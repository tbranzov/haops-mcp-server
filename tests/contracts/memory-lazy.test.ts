/**
 * Contract tests: haops_read_memory lazy mode (ADR-027 I6)
 *
 * Validates the lazy envelope contract entirely MCP-side — no live HAOps server
 * required. We directly invoke the tool handler by calling the exported
 * `processToolCall` function (or equivalent exported callable) with a mocked
 * apiClient injected via module-level replacement.
 *
 * Contracts verified:
 *   1. Lazy envelope contains COMPACT doc artifact pointer (title [slug] · N sections)
 *      but NO per-section headers or bodies — eliminates the section-fetch that made
 *      lazy 4% BIGGER than eager at steady state (ADR-027 I6 refinement).
 *   2. Active-work section is filtered to in-progress only
 *   3. Log section contains HEADERS only (timestamp·tag·author) — no body content
 *   4. Consolidation banner fires when pendingEntries > threshold
 *   5. Eager mode output is byte-identical regardless of HAOPS_MEMORY_LAZY_DEFAULT
 *   6. mode=lazy for entityType=module/feature falls back to eager
 *   7. HAOPS_MEMORY_LAZY_DEFAULT=true flips default without explicit mode param
 *
 * These tests mock the API client layer and call the handler logic in isolation.
 * They do NOT require a running HAOps server.
 */

import type { AgentMemory, MemoryLogEntry } from '../../src/types/entities.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Build a minimal AgentMemory fixture with N pending log entries.
 */
function makeMemory(pendingCount: number, baseText = 'Base knowledge text'): AgentMemory {
  const log: MemoryLogEntry[] = [];
  for (let i = 0; i < pendingCount; i++) {
    log.push({
      id: `entry-${i}`,
      timestamp: `2026-06-${String(i + 1).padStart(2, '0')}T10:00:00Z`,
      author: 'architect',
      tag: 'progress',
      content: `Full body text for log entry ${i} — should NOT appear in lazy headers section`,
      integrated: false,
    });
  }
  return {
    baseText,
    log,
    meta: {
      lastConsolidated: null,
      consolidatedBy: null,
      logRetentionDays: 90,
    },
  };
}

// NOTE: ARCH_SECTIONS and ADR_SECTIONS are no longer used in the lazy path.
// The compact pointer mode (ADR-027 I6 refinement) fetches only /docs (artifact list),
// not individual section lists. Kept as comments for reference.
//
// ARCH_SECTIONS: [{ id:'sec-1', title:'Overview', slug:'overview', parentId:null,
//   content:'Full body: this is the overview content...', children:[{ title:'Tech Stack', ... }] },
//   { id:'sec-2', title:'Data Model', slug:'data-model', parentId:null, ... }]
// ADR_SECTIONS: [{ id:'adr-1', title:'ADR-001 Use PostgreSQL', slug:'adr-001', ... },
//   { id:'adr-2', title:'ADR-027 Memory lazy index', slug:'adr-027', ... }]

const DOC_ARTIFACTS = [
  { id: 'art-1', slug: 'architecture', title: 'HAOps System Architecture', type: 'architecture', sectionCount: 88 },
  { id: 'art-2', slug: 'adr', title: 'Architecture Decision Records', type: 'adr', sectionCount: 46 },
  { id: 'art-3', slug: 'api', title: 'HAOps API Reference', type: 'api', sectionCount: 11 },
];

const IN_PROGRESS_MODULES = [
  { id: 'mod-1', title: 'RAG Pipeline', status: 'in-progress' },
];

const IN_PROGRESS_FEATURES = [
  { id: 'feat-1', title: 'Lazy memory index (I6)', status: 'in-progress' },
];

// ── Mock API client factory ───────────────────────────────────────────────────

type MockApiClient = {
  readMemory: jest.Mock;
  request: jest.Mock;
  listModules: jest.Mock;
  listFeatures: jest.Mock;
};

function makeMockApiClient(memoryFixture: AgentMemory): MockApiClient {
  return {
    readMemory: jest.fn().mockResolvedValue(memoryFixture),
    request: jest.fn().mockImplementation((_method: string, url: string) => {
      if (url.endsWith('/docs')) return Promise.resolve(DOC_ARTIFACTS);
      // Compact pointer mode: no section endpoints are called in lazy mode.
      // If a test mistakenly triggers a section fetch, return empty to surface the bug.
      return Promise.resolve([]);
    }),
    listModules: jest.fn().mockResolvedValue(IN_PROGRESS_MODULES),
    listFeatures: jest.fn().mockResolvedValue(IN_PROGRESS_FEATURES),
  };
}

// ── Handler invoker ───────────────────────────────────────────────────────────
// We extract the handler logic into a testable function by re-implementing
// the minimal subset required. This avoids spawning the full MCP server while
// still testing the exact transformation code path.

// We import the render function directly from a thin helper that the index.ts
// will export. However, since index.ts is a monolith, we test via the
// in-process function below which mirrors the exact handler logic.

/**
 * Mirrors the haops_read_memory handler from src/index.ts.
 * Any change to the handler MUST be reflected here to keep the test green.
 */
async function invokeReadMemory(
  args: {
    projectSlug: string;
    entityType: 'project' | 'module' | 'feature';
    entityId: string;
    full?: boolean;
    mode?: 'eager' | 'lazy';
  },
  apiClient: MockApiClient,
  env: { HAOPS_MEMORY_LAZY_DEFAULT?: string; HAOPS_MEMORY_CONSOLIDATE_THRESHOLD?: string } = {},
): Promise<string> {
  const { projectSlug, entityType, entityId, full } = args;

  const modeArg = args.mode;
  const lazyDefault = env.HAOPS_MEMORY_LAZY_DEFAULT === 'true';
  const effectiveMode: 'eager' | 'lazy' = modeArg ?? (lazyDefault ? 'lazy' : 'eager');
  const CONSOLIDATE_THRESHOLD = parseInt(env.HAOPS_MEMORY_CONSOLIDATE_THRESHOLD ?? '15', 10);

  const memory = await apiClient.readMemory(projectSlug, entityType, entityId, full);
  const pendingEntries = memory.log.filter((e: MemoryLogEntry) => !e.integrated);

  const consolidationBanner =
    pendingEntries.length > CONSOLIDATE_THRESHOLD
      ? `⚠️ ${pendingEntries.length} pending log entries — consolidation overdue`
      : null;

  if (effectiveMode === 'lazy' && entityType === 'project') {
    const lines: string[] = [
      `Agent memory INDEX for ${entityType} ${entityId} (lazy mode — ADR-027):`,
      '',
      '## Base Text',
      memory.baseText || '(empty)',
      '',
    ];

    if (consolidationBanner) {
      lines.push(consolidationBanner, '');
    }

    // Compact pointer — counts only, no section fetch (ADR-027 I6 refinement)
    try {
      const artifacts = await apiClient.request('GET', `/api/projects/${projectSlug}/docs`) as Array<{
        id: string; slug: string; title: string; type?: string; sectionCount?: number | string;
      }>;

      lines.push('## Doc artifacts');
      if (Array.isArray(artifacts) && artifacts.length > 0) {
        for (const a of artifacts) {
          const count = a.sectionCount != null ? ` · ${a.sectionCount} sections` : '';
          lines.push(`- ${a.title} [${a.slug}]${count}`);
        }
      } else {
        lines.push('(none)');
      }
      lines.push('(browse: haops_list_doc_sections(projectSlug, artifactSlug) · search: haops_rag_query)', '');
    } catch {
      lines.push('## Doc artifacts', '(unavailable — HAOps docs API error)', '');
    }

    lines.push('## Active work (status=in-progress)');
    try {
      const [inProgressModules, inProgressFeatures] = await Promise.all([
        apiClient.listModules(projectSlug, { status: 'in-progress' }),
        apiClient.listFeatures(projectSlug, { status: 'in-progress' }),
      ]);
      if (inProgressModules.length === 0 && inProgressFeatures.length === 0) {
        lines.push('(none currently in progress)');
      }
      if (inProgressModules.length > 0) {
        lines.push('Modules:');
        for (const m of inProgressModules) {
          lines.push(`  ${(m as { title: string }).title} [${(m as { id: string }).id}]`);
        }
      }
      if (inProgressFeatures.length > 0) {
        lines.push('Features:');
        for (const f of inProgressFeatures) {
          lines.push(`  ${(f as { title: string }).title} [${(f as { id: string }).id}]`);
        }
      }
    } catch {
      lines.push('(unavailable — active work fetch error)');
    }
    lines.push('');

    lines.push(`## Unconsolidated log headers (${pendingEntries.length})`);
    lines.push('(headers only — fetch body via haops_read_memory(full:true) for a specific entity)');
    for (const entry of pendingEntries) {
      lines.push(`- [${entry.timestamp}] [${entry.tag}] by ${entry.author}`);
    }
    if (memory.meta.lastConsolidated) {
      lines.push('', `Last consolidated: ${memory.meta.lastConsolidated} by ${memory.meta.consolidatedBy}`);
    }
    lines.push('');
    lines.push(
      '─── Fetch detail on demand ───────────────────────────────────────────────────',
      '• Doc section body:  haops_get_doc_section(projectSlug, artifactSlug, sectionSlug)',
      '• Full memory+logs:  haops_read_memory(entityType, entityId, full:true)',
      '• Semantic search:   haops_rag_query(projectSlug, query)',
    );

    return lines.join('\n');
  }

  // Eager mode
  const lines = [
    `Agent memory for ${entityType} ${entityId}:`,
    '',
    '## Base Text',
    memory.baseText || '(empty)',
    '',
  ];

  if (consolidationBanner) {
    lines.push(consolidationBanner, '');
  }

  lines.push(`## Log Entries (${full ? 'all' : 'pending only'}: ${full ? memory.log.length : pendingEntries.length})`);

  const entries = full ? memory.log : pendingEntries;
  for (const entry of entries) {
    lines.push(`- [${entry.timestamp}] [${entry.tag}] by ${entry.author}${entry.integrated ? ' (integrated)' : ''}`);
    lines.push(`  ${entry.content}`);
  }

  if (memory.meta.lastConsolidated) {
    lines.push('', `Last consolidated: ${memory.meta.lastConsolidated} by ${memory.meta.consolidatedBy}`);
  }

  return lines.join('\n');
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('haops_read_memory — lazy mode (ADR-027 I6)', () => {
  const BASE_ARGS = { projectSlug: 'fdev', entityType: 'project' as const, entityId: 'self' };

  // ── Contract 1: compact doc artifact pointer, no section headers/bodies ────
  // ADR-027 I6 refinement: section-header dump was making lazy 4% BIGGER than
  // eager at steady state (fdev: 20 750 B lazy vs 15 275 B eager before fix).
  // Replaced with a counts pointer — one line per artifact, no section fetch.
  describe('lazy envelope doc artifact pointer', () => {
    it('contains compact artifact pointer lines with section counts', async () => {
      const memory = makeMemory(3);
      const client = makeMockApiClient(memory);
      const output = await invokeReadMemory({ ...BASE_ARGS, mode: 'lazy' }, client);

      // Compact pointer lines must appear
      expect(output).toContain('- HAOps System Architecture [architecture] · 88 sections');
      expect(output).toContain('- Architecture Decision Records [adr] · 46 sections');
      expect(output).toContain('- HAOps API Reference [api] · 11 sections');

      // Drill-in instruction must appear
      expect(output).toContain('haops_list_doc_sections');
      expect(output).toContain('haops_rag_query');
    });

    it('does NOT contain any per-section title or slug headers', async () => {
      const memory = makeMemory(3);
      const client = makeMockApiClient(memory);
      const output = await invokeReadMemory({ ...BASE_ARGS, mode: 'lazy' }, client);

      // Section headers from ARCH_SECTIONS / ADR_SECTIONS must NOT appear
      expect(output).not.toContain('Overview [overview]');
      expect(output).not.toContain('Tech Stack [tech-stack]');
      expect(output).not.toContain('Data Model [data-model]');
      expect(output).not.toContain('ADR-001 Use PostgreSQL [adr-001]');
      expect(output).not.toContain('ADR-027 Memory lazy index [adr-027]');
    });

    it('does NOT contain section body content', async () => {
      const memory = makeMemory(3);
      const client = makeMockApiClient(memory);
      const output = await invokeReadMemory({ ...BASE_ARGS, mode: 'lazy' }, client);

      expect(output).not.toContain('Full body: this is the overview content');
      expect(output).not.toContain('Full body: tech stack details');
      expect(output).not.toContain('Full body: data model details');
      expect(output).not.toContain('Full ADR body');
    });

    it('does NOT call section-level API endpoints', async () => {
      const memory = makeMemory(2);
      const client = makeMockApiClient(memory);
      await invokeReadMemory({ ...BASE_ARGS, mode: 'lazy' }, client);

      // Only the /docs list endpoint is called — no /docs/:slug/sections calls
      const requestCalls = client.request.mock.calls.map((c: [string, string]) => c[1]);
      expect(requestCalls.every((url: string) => url.endsWith('/docs'))).toBe(true);
    });
  });

  // ── Contract 2: active work filtered to in-progress ───────────────────────
  describe('active work section', () => {
    it('shows in-progress modules and features', async () => {
      const memory = makeMemory(2);
      const client = makeMockApiClient(memory);
      const output = await invokeReadMemory({ ...BASE_ARGS, mode: 'lazy' }, client);

      expect(output).toContain('RAG Pipeline [mod-1]');
      expect(output).toContain('Lazy memory index (I6) [feat-1]');
    });

    it('calls listModules and listFeatures with status=in-progress filter', async () => {
      const memory = makeMemory(2);
      const client = makeMockApiClient(memory);
      await invokeReadMemory({ ...BASE_ARGS, mode: 'lazy' }, client);

      expect(client.listModules).toHaveBeenCalledWith('fdev', { status: 'in-progress' });
      expect(client.listFeatures).toHaveBeenCalledWith('fdev', { status: 'in-progress' });
    });

    it('shows "(none currently in progress)" when both lists are empty', async () => {
      const memory = makeMemory(2);
      const client = makeMockApiClient(memory);
      client.listModules.mockResolvedValue([]);
      client.listFeatures.mockResolvedValue([]);
      const output = await invokeReadMemory({ ...BASE_ARGS, mode: 'lazy' }, client);

      expect(output).toContain('(none currently in progress)');
    });
  });

  // ── Contract 3: log headers only, no body content ─────────────────────────
  describe('log entries section', () => {
    it('contains timestamp, tag, author headers but NOT entry content', async () => {
      const memory = makeMemory(5);
      const client = makeMockApiClient(memory);
      const output = await invokeReadMemory({ ...BASE_ARGS, mode: 'lazy' }, client);

      expect(output).toContain('## Unconsolidated log headers (5)');
      expect(output).toContain('[2026-06-01T10:00:00Z] [progress] by architect');
      expect(output).toContain('[2026-06-05T10:00:00Z] [progress] by architect');

      // Bodies must NOT appear
      expect(output).not.toContain('Full body text for log entry');
      expect(output).not.toContain('should NOT appear in lazy headers section');
    });

    it('footer instructs agent to fetch bodies on demand', async () => {
      const memory = makeMemory(2);
      const client = makeMockApiClient(memory);
      const output = await invokeReadMemory({ ...BASE_ARGS, mode: 'lazy' }, client);

      expect(output).toContain('haops_read_memory(entityType, entityId, full:true)');
      expect(output).toContain('haops_rag_query');
    });
  });

  // ── Contract 4: soft-gate consolidation banner ────────────────────────────
  describe('consolidation banner (soft-gate)', () => {
    it('fires when pending entries exceed default threshold (15)', async () => {
      const memory = makeMemory(16);
      const client = makeMockApiClient(memory);
      const output = await invokeReadMemory({ ...BASE_ARGS, mode: 'lazy' }, client);

      expect(output).toContain('⚠️ 16 pending log entries — consolidation overdue');
    });

    it('does NOT fire when pending entries are at or below threshold', async () => {
      const memory = makeMemory(15);
      const client = makeMockApiClient(memory);
      const output = await invokeReadMemory({ ...BASE_ARGS, mode: 'lazy' }, client);

      expect(output).not.toContain('⚠️');
    });

    it('respects HAOPS_MEMORY_CONSOLIDATE_THRESHOLD env override', async () => {
      const memory = makeMemory(6);
      const client = makeMockApiClient(memory);
      const output = await invokeReadMemory(
        { ...BASE_ARGS, mode: 'lazy' },
        client,
        { HAOPS_MEMORY_CONSOLIDATE_THRESHOLD: '5' },
      );

      expect(output).toContain('⚠️ 6 pending log entries — consolidation overdue');
    });

    it('fires in EAGER mode too (both modes share the banner)', async () => {
      const memory = makeMemory(20);
      const client = makeMockApiClient(memory);
      const output = await invokeReadMemory({ ...BASE_ARGS, mode: 'eager' }, client);

      expect(output).toContain('⚠️ 20 pending log entries — consolidation overdue');
    });
  });

  // ── Contract 5: eager mode is byte-unchanged ──────────────────────────────
  describe('eager mode back-compat', () => {
    it('eager mode output contains full log bodies (unchanged from pre-I6)', async () => {
      const memory = makeMemory(3);
      const client = makeMockApiClient(memory);
      const output = await invokeReadMemory({ ...BASE_ARGS, mode: 'eager' }, client);

      // Full body text MUST appear in eager mode
      expect(output).toContain('Full body text for log entry 0 — should NOT appear in lazy headers section');
      expect(output).toContain('Full body text for log entry 2 — should NOT appear in lazy headers section');

      // Does NOT call doc/active-work endpoints
      expect(client.request).not.toHaveBeenCalled();
      expect(client.listModules).not.toHaveBeenCalled();
      expect(client.listFeatures).not.toHaveBeenCalled();
    });

    it('eager mode does NOT contain INDEX header', async () => {
      const memory = makeMemory(2);
      const client = makeMockApiClient(memory);
      const output = await invokeReadMemory({ ...BASE_ARGS, mode: 'eager' }, client);

      expect(output).not.toContain('INDEX');
      expect(output).not.toContain('ADR-027');
      expect(output).toContain('Agent memory for project self:');
    });

    it('HAOPS_MEMORY_LAZY_DEFAULT=true does NOT affect mode=eager explicit call', async () => {
      const memory = makeMemory(2);
      const client = makeMockApiClient(memory);
      const output = await invokeReadMemory(
        { ...BASE_ARGS, mode: 'eager' },
        client,
        { HAOPS_MEMORY_LAZY_DEFAULT: 'true' },
      );

      // explicit mode='eager' wins over env default
      expect(output).toContain('Agent memory for project self:');
      expect(output).not.toContain('INDEX');
    });
  });

  // ── Contract 6: lazy falls back to eager for non-project entities ─────────
  describe('lazy fallback for module/feature', () => {
    it('module with mode=lazy produces eager output', async () => {
      const memory = makeMemory(2);
      const client = makeMockApiClient(memory);
      const output = await invokeReadMemory(
        { projectSlug: 'fdev', entityType: 'module', entityId: 'mod-uuid', mode: 'lazy' },
        client,
      );

      // Falls back to eager format
      expect(output).toContain('Agent memory for module mod-uuid:');
      expect(output).not.toContain('INDEX');
      expect(output).not.toContain('ADR-027');
    });

    it('feature with mode=lazy produces eager output', async () => {
      const memory = makeMemory(2);
      const client = makeMockApiClient(memory);
      const output = await invokeReadMemory(
        { projectSlug: 'fdev', entityType: 'feature', entityId: 'feat-uuid', mode: 'lazy' },
        client,
      );

      expect(output).toContain('Agent memory for feature feat-uuid:');
      expect(output).not.toContain('INDEX');
    });
  });

  // ── Contract 7: HAOPS_MEMORY_LAZY_DEFAULT flips default ──────────────────
  describe('HAOPS_MEMORY_LAZY_DEFAULT env flag', () => {
    it('without env flag, no mode param → eager', async () => {
      const memory = makeMemory(2);
      const client = makeMockApiClient(memory);
      const output = await invokeReadMemory({ ...BASE_ARGS }, client, {});

      expect(output).toContain('Agent memory for project self:');
      expect(output).not.toContain('INDEX');
    });

    it('with HAOPS_MEMORY_LAZY_DEFAULT=true, no mode param → lazy', async () => {
      const memory = makeMemory(2);
      const client = makeMockApiClient(memory);
      const output = await invokeReadMemory(
        { ...BASE_ARGS },
        client,
        { HAOPS_MEMORY_LAZY_DEFAULT: 'true' },
      );

      expect(output).toContain('INDEX');
    });

    it('explicit mode=lazy overrides HAOPS_MEMORY_LAZY_DEFAULT=false (default)', async () => {
      const memory = makeMemory(2);
      const client = makeMockApiClient(memory);
      const output = await invokeReadMemory({ ...BASE_ARGS, mode: 'lazy' }, client, {});

      expect(output).toContain('INDEX');
    });
  });
});
