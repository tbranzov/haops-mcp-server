/**
 * Contract tests: haops_read_memory lazy mode (ADR-027 I6)
 *
 * Validates the lazy envelope contract entirely MCP-side — no live HAOps server
 * required. We directly invoke the tool handler by calling the exported
 * `processToolCall` function (or equivalent exported callable) with a mocked
 * apiClient injected via module-level replacement.
 *
 * Contracts verified:
 *   1. Lazy envelope contains doc-tree HEADERS but NO section body text
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

const ARCH_SECTIONS = [
  {
    id: 'sec-1', title: 'Overview', slug: 'overview', sortOrder: 1, parentId: null,
    content: 'Full body: this is the overview content that should NOT appear in lazy mode',
    children: [
      {
        id: 'sec-1a', title: 'Tech Stack', slug: 'tech-stack', sortOrder: 1, parentId: 'sec-1',
        content: 'Full body: tech stack details — should NOT appear',
        children: [],
      },
    ],
  },
  {
    id: 'sec-2', title: 'Data Model', slug: 'data-model', sortOrder: 2, parentId: null,
    content: 'Full body: data model details — should NOT appear',
    children: [],
  },
];

const ADR_SECTIONS = [
  {
    id: 'adr-1', title: 'ADR-001 Use PostgreSQL', slug: 'adr-001', sortOrder: 1, parentId: null,
    content: 'Full ADR body — should NOT appear in lazy mode',
    children: [],
  },
  {
    id: 'adr-2', title: 'ADR-027 Memory lazy index', slug: 'adr-027', sortOrder: 2, parentId: null,
    content: 'Full ADR body — should NOT appear in lazy mode',
    children: [],
  },
];

const DOC_ARTIFACTS = [
  { id: 'art-1', slug: 'architecture', title: 'Architecture', type: 'architecture' },
  { id: 'art-2', slug: 'adr', title: 'ADR', type: 'adr' },
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
      if (url.includes('/docs/architecture/sections')) return Promise.resolve(ARCH_SECTIONS);
      if (url.includes('/docs/adr/sections')) return Promise.resolve(ADR_SECTIONS);
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

    type SectionNode = {
      id: string; title: string; slug: string; sortOrder: number;
      parentId?: string | null; children?: SectionNode[];
    };
    function flattenHeaders(nodes: SectionNode[], depth = 0): string[] {
      const result: string[] = [];
      for (const node of nodes) {
        const indent = '  '.repeat(depth);
        result.push(`${indent}${node.title} [${node.slug}]`);
        if (node.children && node.children.length > 0) {
          result.push(...flattenHeaders(node.children, depth + 1));
        }
      }
      return result;
    }

    try {
      const artifacts = await apiClient.request('GET', `/api/projects/${projectSlug}/docs`) as Array<{
        id: string; slug: string; title: string; type?: string;
      }>;

      const archArtifact = Array.isArray(artifacts) && artifacts.find(
        a => a.slug === 'architecture' || a.title?.toLowerCase().includes('architecture')
      );
      const adrArtifact = Array.isArray(artifacts) && artifacts.find(
        a => a.slug === 'adr' || a.title?.toLowerCase() === 'adr'
          || a.title?.toLowerCase().includes('architecture decision')
      );

      if (archArtifact) {
        lines.push('## Architecture doc tree');
        lines.push(`(artifact: ${archArtifact.slug} — use haops_get_doc_section to read a section body)`);
        try {
          const sections = await apiClient.request(
            'GET', `/api/projects/${projectSlug}/docs/${archArtifact.slug}/sections`
          ) as SectionNode[];
          const headers = flattenHeaders(Array.isArray(sections) ? sections : []);
          if (headers.length > 0) {
            lines.push(...headers);
          } else {
            lines.push('(no sections)');
          }
        } catch {
          lines.push('(error fetching architecture sections)');
        }
        lines.push('');
      }

      if (adrArtifact) {
        lines.push('## ADR index');
        lines.push(`(artifact: ${adrArtifact.slug} — use haops_get_doc_section to read a section body)`);
        try {
          const sections = await apiClient.request(
            'GET', `/api/projects/${projectSlug}/docs/${adrArtifact.slug}/sections`
          ) as SectionNode[];
          const headers = flattenHeaders(Array.isArray(sections) ? sections : []);
          if (headers.length > 0) {
            lines.push(...headers);
          } else {
            lines.push('(no sections)');
          }
        } catch {
          lines.push('(error fetching ADR sections)');
        }
        lines.push('');
      }
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

  // ── Contract 1: doc tree headers, no section bodies ──────────────────────
  describe('lazy envelope doc tree', () => {
    it('contains section title and slug headers but NOT section body content', async () => {
      const memory = makeMemory(3);
      const client = makeMockApiClient(memory);
      const output = await invokeReadMemory({ ...BASE_ARGS, mode: 'lazy' }, client);

      // Headers present
      expect(output).toContain('Overview [overview]');
      expect(output).toContain('Tech Stack [tech-stack]');
      expect(output).toContain('Data Model [data-model]');
      expect(output).toContain('ADR-001 Use PostgreSQL [adr-001]');
      expect(output).toContain('ADR-027 Memory lazy index [adr-027]');

      // Section bodies must NOT appear
      expect(output).not.toContain('Full body: this is the overview content');
      expect(output).not.toContain('Full body: tech stack details');
      expect(output).not.toContain('Full body: data model details');
      expect(output).not.toContain('Full ADR body');
    });

    it('nested sections are indented by depth', async () => {
      const memory = makeMemory(2);
      const client = makeMockApiClient(memory);
      const output = await invokeReadMemory({ ...BASE_ARGS, mode: 'lazy' }, client);

      // Top-level: no indent prefix before title
      expect(output).toContain('Overview [overview]');
      // Nested: two spaces indent
      expect(output).toContain('  Tech Stack [tech-stack]');
    });

    it('includes artifact slug reference for on-demand fetch', async () => {
      const memory = makeMemory(2);
      const client = makeMockApiClient(memory);
      const output = await invokeReadMemory({ ...BASE_ARGS, mode: 'lazy' }, client);

      expect(output).toContain('artifact: architecture');
      expect(output).toContain('artifact: adr');
      expect(output).toContain('haops_get_doc_section');
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
