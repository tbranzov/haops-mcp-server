/**
 * R2 tools: haops_read_memory_entry, haops_list_decisions, haops_get_timeline.
 *
 * Handlers take anything with `request(method, url)` (the real HAOpsApiClient in
 * production and in tests) and return an MCP tool result. A 404 that is not the
 * server's own JSON error means the route does not exist on this HAOps server yet,
 * so the agent gets "this HAOps server doesn't have <X> yet" instead of a bare 404.
 */
import { HAOpsApiError } from './api/client.js';

export interface RequestClient {
  request(method: 'GET', url: string): Promise<unknown>;
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

/** Route missing = 404 whose body carries no JSON `error` string (the app's own 404s always do). */
function isRouteMissing(error: unknown): boolean {
  if (!(error instanceof HAOpsApiError) || error.statusCode !== 404) return false;
  const body = error.response as { error?: unknown } | undefined;
  return !(body && typeof body === 'object' && typeof body.error === 'string');
}

function errorResult(error: unknown, what: string, label: string): ToolResult {
  if (isRouteMissing(error)) return fail(`Error: this HAOps server doesn't have ${what} yet. Nothing was changed.`);
  const message = error instanceof Error ? error.message : 'Unknown error';
  return fail(`Error ${label}: ${message}`);
}

const enc = encodeURIComponent;

// ── haops_read_memory_entry ─────────────────────────────────────────────────

interface MemoryEntryResponse {
  entry: {
    id: string; timestamp: string; author: string; tag: string; content: string; integrated: boolean;
    title?: string; status?: string; supersedes?: string; supersededBy?: string;
  };
  entityType: string;
  entityId: string;
}

export async function readMemoryEntryTool(
  client: RequestClient,
  args: { projectSlug: string; entryId: string },
): Promise<ToolResult> {
  try {
    const r = (await client.request(
      'GET',
      `/api/projects/${enc(args.projectSlug)}/memory/entries/${enc(args.entryId)}`,
    )) as MemoryEntryResponse;
    const e = r.entry;
    const lines = [
      `Memory entry ${e.id} [${e.tag}] on ${r.entityType} ${r.entityId}`,
      `by ${e.author} at ${e.timestamp}${e.integrated ? ' (integrated)' : ''}`,
    ];
    if (e.title) lines.push(`Title: ${e.title}`);
    if (e.tag === 'decision') {
      lines.push(`Status: ${e.status ?? 'active'}`);
      if (e.supersedes) lines.push(`Supersedes: ${e.supersedes}`);
      if (e.supersededBy) lines.push(`Superseded by: ${e.supersededBy}`);
    }
    lines.push('', e.content);
    return ok(lines.join('\n'));
  } catch (error) {
    return errorResult(error, 'haops_read_memory_entry (the memory entry route)', 'reading memory entry');
  }
}

// ── haops_list_decisions ────────────────────────────────────────────────────

interface DecisionRow {
  id: string; title: string; at: string; author: string; status: string;
  scope: { type: string; id: string }; supersedes: string | null; supersededBy: string | null; integrated: boolean;
}

export async function listDecisionsTool(
  client: RequestClient,
  args: { projectSlug: string; scope?: string; activeOnly?: boolean; since?: string; limit?: number },
): Promise<ToolResult> {
  try {
    const qs = new URLSearchParams();
    if (args.scope) qs.set('scope', args.scope);
    if (args.activeOnly !== undefined) qs.set('activeOnly', String(args.activeOnly));
    if (args.since) qs.set('since', args.since);
    if (args.limit !== undefined) qs.set('limit', String(args.limit));
    const q = qs.toString();
    const r = (await client.request(
      'GET',
      `/api/projects/${enc(args.projectSlug)}/decisions${q ? `?${q}` : ''}`,
    )) as { decisions: DecisionRow[]; total: number };

    if (r.decisions.length === 0) {
      return ok(args.activeOnly === false ? 'No decisions.' : 'No active decisions.');
    }
    const lines = r.decisions.map((d) => {
      const chain = [d.supersedes ? `supersedes ${d.supersedes}` : '', d.supersededBy ? `superseded by ${d.supersededBy}` : '']
        .filter(Boolean).join(', ');
      return `- [${d.status}] ${d.title}\n  id ${d.id} · ${d.at.slice(0, 10)} · ${d.author} · ${d.scope.type}${d.scope.type === 'project' ? '' : ` ${d.scope.id}`}${chain ? ` · ${chain}` : ''}`;
    });
    const more = r.total > r.decisions.length ? `\n(showing ${r.decisions.length} of ${r.total}; narrow with scope/since or raise limit)` : '';
    return ok(`Decisions (${r.decisions.length}):\n${lines.join('\n')}${more}\nFull text: haops_read_memory_entry(projectSlug, id)`);
  } catch (error) {
    return errorResult(error, 'haops_list_decisions (the decisions route)', 'listing decisions');
  }
}

// ── haops_get_timeline ──────────────────────────────────────────────────────

interface TimelineEventRow {
  id: string; at: string; source: string; kind: string; actorKind: string; actor: string | null;
  entityType: string; entityId: string | null; summary: string; link: string | null; note?: string;
}
interface TimelineBody {
  window: { since: string; until: string; clamped: boolean };
  events: TimelineEventRow[];
  truncated: boolean;
  perSource: Record<string, { count: number; truncated: boolean; skipped?: string; error?: string }>;
}

export async function getTimelineTool(
  client: RequestClient,
  args: {
    projectSlug: string; since?: string; until?: string; sources?: string[];
    actorKind?: string; entityType?: string; entityId?: string; limit?: number;
  },
): Promise<ToolResult> {
  try {
    const qs = new URLSearchParams();
    if (args.since) qs.set('since', args.since);
    if (args.until) qs.set('until', args.until);
    if (args.sources && args.sources.length > 0) qs.set('sources', args.sources.join(','));
    if (args.actorKind) qs.set('actorKind', args.actorKind);
    if (args.entityType) qs.set('entityType', args.entityType);
    if (args.entityId) qs.set('entityId', args.entityId);
    if (args.limit !== undefined) qs.set('limit', String(args.limit));
    const q = qs.toString();
    const r = (await client.request(
      'GET',
      `/api/projects/${enc(args.projectSlug)}/timeline${q ? `?${q}` : ''}`,
    )) as TimelineBody;

    const header = `Timeline ${r.window.since} → ${r.window.until}${r.window.clamped ? ' (window clamped to 30 days)' : ''}: ${r.events.length} events`;
    const lines = r.events.map((e) => {
      const who = e.actor ? `${e.actor} (${e.actorKind})` : e.actorKind;
      return `${e.at.slice(0, 16).replace('T', ' ')} [${e.source}/${e.kind}] ${e.summary} — ${who}${e.note ? ` · ${e.note}` : ''}`;
    });
    const notes: string[] = [];
    if (r.truncated) notes.push('Truncated: more events exist. Narrow since/until, sources or filters; there is no cursor.');
    for (const [source, s] of Object.entries(r.perSource ?? {})) {
      if (s.error) notes.push(`${source}: error (${s.error})`);
      else if (s.skipped) notes.push(`${source}: skipped (${s.skipped})`);
      else if (s.truncated) notes.push(`${source}: truncated`);
    }
    return ok([header, ...lines, ...(notes.length ? ['', ...notes] : [])].join('\n'));
  } catch (error) {
    return errorResult(error, 'haops_get_timeline (the project timeline route)', 'getting timeline');
  }
}
