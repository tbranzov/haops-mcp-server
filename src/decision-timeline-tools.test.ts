import { describe, it, expect } from '@jest/globals';
import axios from 'axios';
import { HAOpsApiClient } from './api/client.js';
import { readMemoryEntryTool, listDecisionsTool, getTimelineTool } from './decisionTimelineTools.js';

type Seen = { method?: string; url?: string; data?: unknown };

/** Real HAOpsApiClient (real handleError) with the network replaced by a stub adapter. */
function clientWith(status: number, body: unknown) {
  const seen: Seen = {};
  const client = new HAOpsApiClient('http://127.0.0.1:9', 'dummy');
  const inner = (client as unknown as { axios: ReturnType<typeof axios.create> }).axios;
  inner.defaults.adapter = async (config) => {
    seen.method = config.method;
    seen.url = config.url;
    seen.data = config.data;
    const response = { data: body, status, statusText: 'x', headers: {}, config };
    if (status >= 400) throw new axios.AxiosError('Request failed', 'ERR_BAD_REQUEST', config, null, response as never);
    return response;
  };
  return { client, seen };
}

const text = (r: { content: Array<{ text: string }> }) => r.content[0].text;
const HTML_404 = '<!DOCTYPE html><html>Not found</html>'; // what a missing Next route returns

describe('haops_read_memory_entry', () => {
  it('requests the entry route and renders body, decision status and chain', async () => {
    const { client, seen } = clientWith(200, {
      entityType: 'module', entityId: 'm-1',
      entry: { id: 'e-1', timestamp: '2026-11-12T10:00:00Z', author: 'architect:t', tag: 'decision', integrated: true,
        content: 'THE WHY', title: 'Ship MCP first', status: 'superseded', supersededBy: 'e-2' },
    });
    const r = await readMemoryEntryTool(client, { projectSlug: 'fdev', entryId: 'e-1' });
    expect(seen.url).toBe('/api/projects/fdev/memory/entries/e-1');
    expect(r.isError).toBeUndefined();
    expect(text(r)).toContain('Title: Ship MCP first');
    expect(text(r)).toContain('Status: superseded');
    expect(text(r)).toContain('Superseded by: e-2');
    expect(text(r)).toContain('THE WHY');
    expect(text(r)).toContain('module m-1');
  });

  it('route missing (404 without a JSON error) says the server has no read_memory_entry yet', async () => {
    const { client } = clientWith(404, HTML_404);
    const r = await readMemoryEntryTool(client, { projectSlug: 'fdev', entryId: 'x' });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/doesn't have haops_read_memory_entry .* yet/);
  });

  it("the app's own 404 (unknown entry) keeps the server message", async () => {
    const { client } = clientWith(404, { error: 'Memory entry not found' });
    const r = await readMemoryEntryTool(client, { projectSlug: 'fdev', entryId: 'x' });
    expect(text(r)).toContain('Memory entry not found');
    expect(text(r)).not.toContain("doesn't have");
  });
});

describe('haops_list_decisions', () => {
  const row = (o: Record<string, unknown>) => ({
    id: 'd1', title: 'Use JSONB', at: '2026-11-10T10:00:00.000Z', author: 'architect:t', status: 'active',
    scope: { type: 'project', id: 'p' }, supersedes: null, supersededBy: null, integrated: false, ...o,
  });

  it('maps filters to the route query and lists title, id, date, scope', async () => {
    const { client, seen } = clientWith(200, { decisions: [row({}), row({ id: 'd2', title: 'Old', status: 'superseded', supersededBy: 'd1', scope: { type: 'module', id: 'm1' } })], total: 5 });
    const r = await listDecisionsTool(client, { projectSlug: 'fdev', scope: 'module:abc', activeOnly: false, since: '2026-11-01T00:00:00Z', limit: 2 });
    const u = new URL(seen.url as string, 'http://x');
    expect(u.pathname).toBe('/api/projects/fdev/decisions');
    expect(Object.fromEntries(u.searchParams)).toEqual({ scope: 'module:abc', activeOnly: 'false', since: '2026-11-01T00:00:00Z', limit: '2' });
    expect(text(r)).toContain('[active] Use JSONB');
    expect(text(r)).toContain('id d1 · 2026-11-10 · architect:t · project');
    expect(text(r)).toContain('superseded by d1');
    expect(text(r)).toContain('showing 2 of 5');
  });

  it('no filters means no query string; empty result is a plain sentence', async () => {
    const { client, seen } = clientWith(200, { decisions: [], total: 0 });
    const r = await listDecisionsTool(client, { projectSlug: 'fdev' });
    expect(seen.url).toBe('/api/projects/fdev/decisions');
    expect(text(r)).toBe('No active decisions.');
  });

  it('route missing says the server has no list_decisions yet', async () => {
    const { client } = clientWith(404, HTML_404);
    const r = await listDecisionsTool(client, { projectSlug: 'fdev' });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/doesn't have haops_list_decisions .* yet/);
  });

  it('a 400 from the server reaches the agent', async () => {
    const { client } = clientWith(400, { error: 'scope must be "project", "module:<uuid>" or "feature:<uuid>"' });
    expect(text(await listDecisionsTool(client, { projectSlug: 'fdev', scope: 'bogus' }))).toContain('scope must be');
  });
});

describe('haops_get_timeline', () => {
  const body = {
    window: { since: '2026-11-10T00:00:00.000Z', until: '2026-11-12T00:00:00.000Z', clamped: false },
    events: [{ id: 'memory:e1', at: '2026-11-11T09:30:00.000Z', source: 'memory', kind: 'decision', actorKind: 'agent',
      actor: 'architect:t', entityType: 'project', entityId: 'p', action: 'append', summary: 'Decision: Use JSONB', link: null }],
    truncated: true,
    perSource: { memory: { count: 1, truncated: false }, git: { count: 0, truncated: false, skipped: 'no repository' }, audit: { count: 0, truncated: false, error: 'timeout' } },
  };

  it('maps params (sources joined by comma) and renders events plus truncation and source notes', async () => {
    const { client, seen } = clientWith(200, body);
    const r = await getTimelineTool(client, {
      projectSlug: 'fdev', since: '2026-11-10T00:00:00Z', sources: ['memory', 'git'], actorKind: 'agent',
      entityType: 'project', entityId: 'p', limit: 10,
    });
    const u = new URL(seen.url as string, 'http://x');
    expect(u.pathname).toBe('/api/projects/fdev/timeline');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      since: '2026-11-10T00:00:00Z', sources: 'memory,git', actorKind: 'agent', entityType: 'project', entityId: 'p', limit: '10',
    });
    const t = text(r);
    expect(t).toContain('2026-11-11 09:30 [memory/decision] Decision: Use JSONB — architect:t (agent)');
    expect(t).toContain('Truncated');
    expect(t).toContain('git: skipped (no repository)');
    expect(t).toContain('audit: error (timeout)');
  });

  it('route missing says the server has no get_timeline yet; a 400 keeps the server message', async () => {
    const missing = await getTimelineTool(clientWith(404, HTML_404).client, { projectSlug: 'fdev' });
    expect(text(missing)).toMatch(/doesn't have haops_get_timeline .* yet/);
    const bad = await getTimelineTool(clientWith(400, { error: 'Invalid actorKind' }).client, { projectSlug: 'fdev', actorKind: 'x' });
    expect(text(bad)).toContain('Invalid actorKind');
  });
});

describe('haops_append_memory params', () => {
  it('sends title and supersedes only when given', async () => {
    const withTitle = clientWith(201, { id: 'e', timestamp: 't', tag: 'decision' });
    await withTitle.client.appendMemoryLog('fdev', 'project', 'self', 'decision', 'why', { title: 'T', supersedes: 'old' });
    expect(JSON.parse(withTitle.seen.data as string)).toEqual({ tag: 'decision', content: 'why', title: 'T', supersedes: 'old' });

    const plain = clientWith(201, { id: 'e', timestamp: 't', tag: 'progress' });
    await plain.client.appendMemoryLog('fdev', 'project', 'self', 'progress', 'did');
    expect(JSON.parse(plain.seen.data as string)).toEqual({ tag: 'progress', content: 'did' });
  });

  it('a missing-title 400 body reaches the agent through handleError', async () => {
    const { client } = clientWith(400, { error: 'title is required for tag "decision"', message: 'Add a short title' });
    await expect(client.appendMemoryLog('fdev', 'project', 'self', 'decision', 'why')).rejects.toThrow(/title is required.*Add a short title/);
  });
});
