import { describe, it, expect } from '@jest/globals';
import axios from 'axios';
import { HAOpsApiClient } from './api/client.js';
import { lintDiagramTool, formatDiagramWarnings, splitWriteWarnings } from './diagramLintTools.js';

function clientWith(status: number, body: unknown) {
  const seen: { url?: string } = {};
  const client = new HAOpsApiClient('http://127.0.0.1:9', 'dummy');
  const inner = (client as unknown as { axios: ReturnType<typeof axios.create> }).axios;
  inner.defaults.adapter = async (config) => {
    seen.url = config.url;
    const response = { data: body, status, statusText: 'x', headers: {}, config };
    if (status >= 400) throw new axios.AxiosError('Request failed', 'ERR_BAD_REQUEST', config, null, response as never);
    return response;
  };
  return { client, seen };
}
const text = (r: { content: Array<{ text: string }> }) => r.content[0].text;
const w = (code: string, severity: string, id: string | null, fix = `fix ${code}`) => ({ code, severity, elementType: 'node', elementId: id, fix, message: 'm' });

describe('haops_lint_diagram', () => {
  it('requests the lint route and lists findings crash first, grouped', async () => {
    const { client, seen } = clientWith(200, {
      diagramId: 'd1', diagramType: 'flowchart', contentHash: 'h', total: 3, truncated: false,
      byCode: { NODE_HIDDEN: 1, NODE_ID_MISSING: 1, LABEL_WRAPS: 1 },
      warnings: [w('LABEL_WRAPS', 'low', 'n3'), w('NODE_HIDDEN', 'high', 'n2'), w('NODE_ID_MISSING', 'crash', null)],
    });
    const r = await lintDiagramTool(client, { projectSlug: 'fdev', diagramId: 'd1' });
    expect(seen.url).toBe('/api/projects/fdev/diagrams/d1/lint');
    const t = text(r);
    expect(t).toContain('3 finding(s)');
    expect(t.indexOf('CRASH (1)')).toBeLessThan(t.indexOf('HIGH (1)'));
    expect(t.indexOf('HIGH (1)')).toBeLessThan(t.indexOf('LOW (1)'));
    expect(t).toContain('NODE_HIDDEN node n2 — fix: fix NODE_HIDDEN');
  });

  it('shows BPMN findings with rule id, element id, message and severity', async () => {
    const b = (code: string, severity: string, id: string, message: string) => ({ code, severity, elementType: 'bpmn', elementId: id, message, fix: '' });
    const { client } = clientWith(200, {
      diagramId: 'd1', diagramType: 'bpmn', contentHash: 'h', total: 2, truncated: false,
      byCode: { 'fake-join': 1, 'haops/single-start-event': 1 },
      warnings: [b('fake-join', 'medium', 'J1', 'Incoming flows are not synchronized'), b('haops/single-start-event', 'high', 'Process_1', 'Process has 2 start events')],
    });
    const t = text(await lintDiagramTool(client, { projectSlug: 'fdev', diagramId: 'd1' }));
    expect(t).toContain('haops/single-start-event bpmn Process_1 — Process has 2 start events');
    expect(t).toContain('fake-join bpmn J1 — Incoming flows are not synchronized');
    expect(t.indexOf('HIGH (1)')).toBeLessThan(t.indexOf('MEDIUM (1)'));
  });

  it('says so when clean', async () => {
    const { client } = clientWith(200, { diagramId: 'd1', diagramType: 'flowchart', total: 0, warnings: [], byCode: {} });
    expect(text(await lintDiagramTool(client, { projectSlug: 'fdev', diagramId: 'd1' }))).toContain('no lint findings');
  });

  it('caps the list and counts the rest', async () => {
    const warnings = Array.from({ length: 30 }, (_, i) => w('NODE_HIDDEN', 'high', `n${i}`));
    const { client } = clientWith(200, { diagramId: 'd1', diagramType: 'x', total: 45, truncated: true, byCode: { NODE_HIDDEN: 45 }, warnings });
    const t = text(await lintDiagramTool(client, { projectSlug: 'fdev', diagramId: 'd1' }));
    expect(t).toContain('n19');
    expect(t).not.toContain('n20 ');
    expect(t).toContain('+25 more');
  });

  it('route missing (404 without JSON error) says the server has no haops_lint_diagram yet', async () => {
    const { client } = clientWith(404, '<!DOCTYPE html>Not found');
    const r = await lintDiagramTool(client, { projectSlug: 'fdev', diagramId: 'd1' });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/doesn't have haops_lint_diagram .* yet/);
  });

  it("the app's own 404 keeps the server message", async () => {
    const { client } = clientWith(404, { error: 'Diagram not found' });
    const r = await lintDiagramTool(client, { projectSlug: 'fdev', diagramId: 'd1' });
    expect(text(r)).toContain('Diagram not found');
    expect(text(r)).not.toContain("doesn't have");
  });
});

describe('write-response warnings', () => {
  it('empty or absent warnings give no block', () => {
    expect(formatDiagramWarnings(undefined)).toBe('');
    expect(formatDiagramWarnings([])).toBe('');
    expect(splitWriteWarnings({ id: 'd', title: 't' }).block).toBe('');
  });

  it('splits warnings off the response, crash first, with the true total', () => {
    const { rest, block } = splitWriteWarnings({
      id: 'd', warnings: [w('LABEL_WRAPS', 'low', 'a'), w('EDGE_ENDPOINT_MISSING', 'crash', 'e1')], warningsTotal: 7,
    });
    expect(rest).toEqual({ id: 'd' });
    expect(block).toContain('Lint warnings (7)');
    expect(block.indexOf('EDGE_ENDPOINT_MISSING')).toBeLessThan(block.indexOf('LABEL_WRAPS'));
    expect(block).toContain('haops_lint_diagram');
  });
});
