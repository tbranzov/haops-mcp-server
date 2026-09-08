/**
 * Contract tests for the Diagram Studio MCP toolset (module d881186f,
 * issues d73aa6c8 core tools + b6f11bbd D4 agent-ergonomic tools).
 *
 * Adapted from HAOps Science's diagram-tools-precondition.test.ts pattern
 * (mock the API client, drive tools via the real buildMcpServer()'s
 * tools/call handler) — but science's client exposes typed per-entity
 * methods (createDiagram/getDiagram/updateDiagram/...), while this repo's
 * client exposes ONE generic `request(method, url, data?)` (see every other
 * tool added since the doc-section family). So instead of mocking typed
 * methods, we mock `request` itself and assert on (method, url, body)
 * triples — the equivalent contract for this client shape.
 *
 * Covers: URL/method/body construction for every tool, the auto-fetched
 * contentHash precondition (mirrors haops_update_section's INV-6 pattern —
 * content present + no explicit precondition → auto-fetch; explicit
 * baseContentHash → no auto-fetch; skipPrecondition → no auto-fetch, no
 * hash sent; no content → no auto-fetch), 409-stale surfacing with a clear
 * re-read-and-reapply message, the node-delete edge-cascade, the
 * batch-elements RMW-under-one-hash shape, the BPMN layout-preservation
 * guard, auto-arrange's dagre-layout write-back, and the
 * new-from-template isTemplate guard.
 */

import { jest } from '@jest/globals';

process.env.HAOPS_API_KEY = 'test-key-for-unit-tests';
process.env.HAOPS_API_URL = 'http://localhost:3100';

const mockRequest = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.mock('./api/client.js', () => {
  class HAOpsApiError extends Error {
    statusCode?: number;
    response?: unknown;
    constructor(message: string, statusCode?: number, response?: unknown) {
      super(message);
      this.name = 'HAOpsApiError';
      this.statusCode = statusCode;
      this.response = response;
    }
  }
  return {
    HAOpsApiClient: jest.fn().mockImplementation(() => ({
      request: mockRequest,
    })),
    HAOpsApiError,
  };
});

import { buildMcpServer } from './index.js';

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

async function callTool(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
  const server = buildMcpServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handlers = (server as unknown as { _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<ToolResult>> })._requestHandlers;
  const handler = handlers?.get('tools/call');
  if (!handler) throw new Error('tools/call handler not registered on MCP server');
  return handler({ method: 'tools/call', params: { name: toolName, arguments: args } }, {});
}

const PROJECT_SLUG = 'test-project';
const DIAGRAM_ID = 'diagram-1';
const CURRENT_HASH = 'a'.repeat(64);

function freshEmptyContent() {
  return { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
}

/** Access the (method, url, body) of the Nth call to the mocked `request`. */
function callArgs(n = 0): [string, string, unknown] {
  return mockRequest.mock.calls[n] as [string, string, unknown];
}

// A structured 409 { error: 'stale', currentHash } — the HAOpsApiError shape
// handleError() produces for the diagram PATCH route's optimistic-
// concurrency conflict.
function staleError() {
  const { HAOpsApiError } = jest.requireMock('./api/client.js') as { HAOpsApiError: new (m: string, s?: number, r?: unknown) => Error };
  return new HAOpsApiError('HTTP 409: stale', 409, { error: 'stale', currentHash: 'b'.repeat(64) });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('haops_create_diagram', () => {
  it('POSTs title/diagramType/folderId when supplied', async () => {
    mockRequest.mockResolvedValueOnce({ id: DIAGRAM_ID, title: 'New Diagram', diagramType: 'bpmn' });
    await callTool('haops_create_diagram', { projectSlug: PROJECT_SLUG, title: 'New Diagram', diagramType: 'bpmn', folderId: 'f1' });
    const [method, url, body] = callArgs();
    expect(method).toBe('POST');
    expect(url).toBe(`/api/projects/${PROJECT_SLUG}/diagrams`);
    expect(body).toEqual({ title: 'New Diagram', diagramType: 'bpmn', folderId: 'f1' });
  });

  it('omits diagramType/folderId from the body when not supplied', async () => {
    mockRequest.mockResolvedValueOnce({ id: DIAGRAM_ID, title: 'New Diagram' });
    await callTool('haops_create_diagram', { projectSlug: PROJECT_SLUG, title: 'New Diagram' });
    const [, , body] = callArgs();
    expect(body).toEqual({ title: 'New Diagram' });
  });
});

describe('haops_list_diagrams', () => {
  it('builds a query string only from supplied filters', async () => {
    mockRequest.mockResolvedValueOnce([]);
    await callTool('haops_list_diagrams', { projectSlug: PROJECT_SLUG, isTemplate: true, type: 'flowchart' });
    const [method, url] = callArgs();
    expect(method).toBe('GET');
    expect(url).toContain(`/api/projects/${PROJECT_SLUG}/diagrams?`);
    expect(url).toContain('isTemplate=true');
    expect(url).toContain('type=flowchart');
  });

  it('omits the query string entirely when no filters are given', async () => {
    mockRequest.mockResolvedValueOnce([]);
    await callTool('haops_list_diagrams', { projectSlug: PROJECT_SLUG });
    const [, url] = callArgs();
    expect(url).toBe(`/api/projects/${PROJECT_SLUG}/diagrams`);
  });
});

describe('haops_get_diagram / haops_delete_diagram', () => {
  it('GETs the diagram by id', async () => {
    mockRequest.mockResolvedValueOnce({ id: DIAGRAM_ID });
    await callTool('haops_get_diagram', { projectSlug: PROJECT_SLUG, diagramId: DIAGRAM_ID });
    expect(callArgs()).toEqual(['GET', `/api/projects/${PROJECT_SLUG}/diagrams/${DIAGRAM_ID}`, undefined]);
  });

  it('DELETEs the diagram by id', async () => {
    mockRequest.mockResolvedValueOnce({ message: 'Diagram deleted' });
    const result = await callTool('haops_delete_diagram', { projectSlug: PROJECT_SLUG, diagramId: DIAGRAM_ID });
    expect(callArgs()).toEqual(['DELETE', `/api/projects/${PROJECT_SLUG}/diagrams/${DIAGRAM_ID}`, undefined]);
    expect(result.isError).toBeUndefined();
  });
});

describe('haops_update_diagram — contentHash precondition (INV-6-style)', () => {
  it('auto-fetches and sends the current contentHash when content is present and no precondition given', async () => {
    mockRequest.mockResolvedValueOnce({ id: DIAGRAM_ID, content: freshEmptyContent(), contentHash: CURRENT_HASH }); // GET (precondition fetch)
    mockRequest.mockResolvedValueOnce({ id: DIAGRAM_ID, title: 'Updated' }); // PATCH

    await callTool('haops_update_diagram', { projectSlug: PROJECT_SLUG, diagramId: DIAGRAM_ID, content: freshEmptyContent() });

    expect(mockRequest).toHaveBeenCalledTimes(2);
    const [patchMethod, patchUrl, patchBody] = callArgs(1);
    expect(patchMethod).toBe('PATCH');
    expect(patchUrl).toBe(`/api/projects/${PROJECT_SLUG}/diagrams/${DIAGRAM_ID}`);
    expect((patchBody as Record<string, unknown>).baseContentHash).toBe(CURRENT_HASH);
  });

  it('does NOT auto-fetch when the caller already supplied baseContentHash', async () => {
    mockRequest.mockResolvedValueOnce({ id: DIAGRAM_ID, title: 'Updated' });
    await callTool('haops_update_diagram', {
      projectSlug: PROJECT_SLUG, diagramId: DIAGRAM_ID, content: freshEmptyContent(), baseContentHash: 'caller-hash',
    });
    expect(mockRequest).toHaveBeenCalledTimes(1);
    const [, , body] = callArgs(0);
    expect((body as Record<string, unknown>).baseContentHash).toBe('caller-hash');
  });

  it('does NOT auto-fetch and sends no baseContentHash when skipPrecondition:true', async () => {
    mockRequest.mockResolvedValueOnce({ id: DIAGRAM_ID, title: 'Updated' });
    await callTool('haops_update_diagram', {
      projectSlug: PROJECT_SLUG, diagramId: DIAGRAM_ID, content: freshEmptyContent(), skipPrecondition: true,
    });
    expect(mockRequest).toHaveBeenCalledTimes(1);
    const [, , body] = callArgs(0);
    expect((body as Record<string, unknown>).baseContentHash).toBeUndefined();
  });

  it('does NOT auto-fetch when no content is present (nothing to protect)', async () => {
    mockRequest.mockResolvedValueOnce({ id: DIAGRAM_ID, title: 'Updated' });
    await callTool('haops_update_diagram', { projectSlug: PROJECT_SLUG, diagramId: DIAGRAM_ID, title: 'Updated' });
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it('surfaces a 409 stale conflict with a clear re-read instruction, never a bare error', async () => {
    mockRequest.mockResolvedValueOnce({ id: DIAGRAM_ID, content: freshEmptyContent(), contentHash: CURRENT_HASH });
    mockRequest.mockRejectedValueOnce(staleError());
    const result = await callTool('haops_update_diagram', { projectSlug: PROJECT_SLUG, diagramId: DIAGRAM_ID, content: freshEmptyContent() });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/stale/i);
    expect(result.content[0].text).toMatch(/haops_get_diagram/);
  });
});

describe('haops_clone_diagram / haops_new_diagram_from_template', () => {
  it('POSTs title/bindings to the clone route', async () => {
    mockRequest.mockResolvedValueOnce({ id: 'clone-1', title: 'Copy of X' });
    await callTool('haops_clone_diagram', { projectSlug: PROJECT_SLUG, diagramId: DIAGRAM_ID, title: 'My Fork', bindings: 'copy' });
    expect(callArgs()).toEqual([
      'POST',
      `/api/projects/${PROJECT_SLUG}/diagrams/${DIAGRAM_ID}/clone`,
      { title: 'My Fork', bindings: 'copy' },
    ]);
  });

  it('new-from-template errors (no clone call) when the source is not a template', async () => {
    mockRequest.mockResolvedValueOnce({ id: DIAGRAM_ID, title: 'Not A Template', isTemplate: false });
    const result = await callTool('haops_new_diagram_from_template', { projectSlug: PROJECT_SLUG, diagramId: DIAGRAM_ID });
    expect(result.isError).toBe(true);
    expect(mockRequest).toHaveBeenCalledTimes(1); // only the GET, no clone POST
  });

  it('new-from-template clones with bindings:none and the template\'s own title by default', async () => {
    mockRequest.mockResolvedValueOnce({ id: DIAGRAM_ID, title: 'Starter', isTemplate: true }); // GET
    mockRequest.mockResolvedValueOnce({ id: 'clone-2', title: 'Starter' }); // clone POST
    await callTool('haops_new_diagram_from_template', { projectSlug: PROJECT_SLUG, diagramId: DIAGRAM_ID });
    const [method, url, body] = callArgs(1);
    expect(method).toBe('POST');
    expect(url).toBe(`/api/projects/${PROJECT_SLUG}/diagrams/${DIAGRAM_ID}/clone`);
    expect(body).toEqual({ title: 'Starter', bindings: 'none' });
  });

  it('new-from-template respects sourceIsTemplateOverride for a non-template source', async () => {
    mockRequest.mockResolvedValueOnce({ id: DIAGRAM_ID, title: 'Regular', isTemplate: false });
    mockRequest.mockResolvedValueOnce({ id: 'clone-3', title: 'Regular' });
    const result = await callTool('haops_new_diagram_from_template', {
      projectSlug: PROJECT_SLUG, diagramId: DIAGRAM_ID, sourceIsTemplateOverride: true,
    });
    expect(result.isError).toBeUndefined();
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });
});

describe('haops_set_bpmn_diagram_xml', () => {
  const BPMN_NO_DI = '<bpmn:definitions><bpmn:process id="P1"/></bpmn:definitions>';
  const BPMN_WITH_DI = '<bpmn:definitions><bpmndi:BPMNDiagram id="D1"/></bpmn:definitions>';

  it('errors (no write) when the target diagram is not diagramType bpmn', async () => {
    mockRequest.mockResolvedValueOnce({ id: DIAGRAM_ID, diagramType: 'flowchart', content: freshEmptyContent(), contentHash: CURRENT_HASH });
    const result = await callTool('haops_set_bpmn_diagram_xml', { projectSlug: PROJECT_SLUG, diagramId: DIAGRAM_ID, bpmnXml: BPMN_NO_DI });
    expect(result.isError).toBe(true);
    expect(mockRequest).toHaveBeenCalledTimes(1); // only the GET, no PATCH
  });

  it('writes semantics-only XML over a target with no existing DI', async () => {
    mockRequest.mockResolvedValueOnce({ id: DIAGRAM_ID, diagramType: 'bpmn', content: { nodes: [], edges: [], bpmnXml: undefined }, contentHash: CURRENT_HASH });
    mockRequest.mockResolvedValueOnce({ id: DIAGRAM_ID });
    const result = await callTool('haops_set_bpmn_diagram_xml', { projectSlug: PROJECT_SLUG, diagramId: DIAGRAM_ID, bpmnXml: BPMN_NO_DI });
    expect(result.isError).toBeUndefined();
    const [, , body] = callArgs(1);
    expect((body as { content: { bpmnXml: string } }).content.bpmnXml).toBe(BPMN_NO_DI);
  });

  it('P2-1 layout-preservation guard: refuses a semantics-only rewrite over a DI-bearing target', async () => {
    mockRequest.mockResolvedValueOnce({ id: DIAGRAM_ID, diagramType: 'bpmn', content: { nodes: [], edges: [], bpmnXml: BPMN_WITH_DI }, contentHash: CURRENT_HASH });
    const result = await callTool('haops_set_bpmn_diagram_xml', { projectSlug: PROJECT_SLUG, diagramId: DIAGRAM_ID, bpmnXml: BPMN_NO_DI });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/overwriteLayout/);
    expect(mockRequest).toHaveBeenCalledTimes(1); // nothing written
  });

  it('overwriteLayout:true allows the semantics-only rewrite over a DI-bearing target', async () => {
    mockRequest.mockResolvedValueOnce({ id: DIAGRAM_ID, diagramType: 'bpmn', content: { nodes: [], edges: [], bpmnXml: BPMN_WITH_DI }, contentHash: CURRENT_HASH });
    mockRequest.mockResolvedValueOnce({ id: DIAGRAM_ID });
    const result = await callTool('haops_set_bpmn_diagram_xml', {
      projectSlug: PROJECT_SLUG, diagramId: DIAGRAM_ID, bpmnXml: BPMN_NO_DI, overwriteLayout: true,
    });
    expect(result.isError).toBeUndefined();
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });

  it('a DI-bearing incoming XML is always allowed over a DI-bearing target', async () => {
    mockRequest.mockResolvedValueOnce({ id: DIAGRAM_ID, diagramType: 'bpmn', content: { nodes: [], edges: [], bpmnXml: BPMN_WITH_DI }, contentHash: CURRENT_HASH });
    mockRequest.mockResolvedValueOnce({ id: DIAGRAM_ID });
    const result = await callTool('haops_set_bpmn_diagram_xml', { projectSlug: PROJECT_SLUG, diagramId: DIAGRAM_ID, bpmnXml: BPMN_WITH_DI });
    expect(result.isError).toBeUndefined();
  });
});

describe('haops_create_diagram_version / haops_list_diagram_versions / haops_restore_diagram_version', () => {
  it('POSTs label/description to the versions route', async () => {
    mockRequest.mockResolvedValueOnce({ id: 'v1', versionNumber: 1 });
    await callTool('haops_create_diagram_version', { projectSlug: PROJECT_SLUG, diagramId: DIAGRAM_ID, label: 'Before refactor' });
    expect(callArgs()).toEqual([
      'POST',
      `/api/projects/${PROJECT_SLUG}/diagrams/${DIAGRAM_ID}/versions`,
      { label: 'Before refactor' },
    ]);
  });

  it('lists versions with limit/offset in the query string', async () => {
    mockRequest.mockResolvedValueOnce({ versions: [], total: 0 });
    await callTool('haops_list_diagram_versions', { projectSlug: PROJECT_SLUG, diagramId: DIAGRAM_ID, limit: 10, offset: 5 });
    const [, url] = callArgs();
    expect(url).toBe(`/api/projects/${PROJECT_SLUG}/diagrams/${DIAGRAM_ID}/versions?limit=10&offset=5`);
  });

  it('restores a version by id', async () => {
    mockRequest.mockResolvedValueOnce({ restored: true });
    await callTool('haops_restore_diagram_version', { projectSlug: PROJECT_SLUG, diagramId: DIAGRAM_ID, versionId: 'v1' });
    expect(callArgs()).toEqual([
      'POST',
      `/api/projects/${PROJECT_SLUG}/diagrams/${DIAGRAM_ID}/versions/v1/restore`,
      undefined,
    ]);
  });
});

describe('haops_link_diagram / haops_list_diagram_links / haops_unbind_diagram', () => {
  it('binds with the retargeted linkableType (Module/Feature/Issue/DocSection/HelpArticle)', async () => {
    mockRequest.mockResolvedValueOnce({ id: 'link-1', linkableType: 'Module', linkableId: 'mod-1' });
    await callTool('haops_link_diagram', { projectSlug: PROJECT_SLUG, diagramId: DIAGRAM_ID, linkableType: 'Module', linkableId: 'mod-1' });
    expect(callArgs()).toEqual([
      'POST',
      `/api/projects/${PROJECT_SLUG}/diagrams/${DIAGRAM_ID}/links`,
      { linkableType: 'Module', linkableId: 'mod-1' },
    ]);
  });

  it('lists links', async () => {
    mockRequest.mockResolvedValueOnce({ data: [], grouped: {} });
    await callTool('haops_list_diagram_links', { projectSlug: PROJECT_SLUG, diagramId: DIAGRAM_ID });
    expect(callArgs()).toEqual(['GET', `/api/projects/${PROJECT_SLUG}/diagrams/${DIAGRAM_ID}/links`, undefined]);
  });

  it('unbinds directly by linkId without a resolve lookup', async () => {
    mockRequest.mockResolvedValueOnce({ message: 'Link removed' });
    await callTool('haops_unbind_diagram', { projectSlug: PROJECT_SLUG, diagramId: DIAGRAM_ID, linkId: 'link-1' });
    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(callArgs()).toEqual(['DELETE', `/api/projects/${PROJECT_SLUG}/diagrams/${DIAGRAM_ID}/links/link-1`, undefined]);
  });

  it('resolves linkId from linkableType+linkableId via a list call first', async () => {
    mockRequest.mockResolvedValueOnce({ data: [{ id: 'link-9', linkableType: 'Module', linkableId: 'mod-1' }] });
    mockRequest.mockResolvedValueOnce({ message: 'Link removed' });
    await callTool('haops_unbind_diagram', { projectSlug: PROJECT_SLUG, diagramId: DIAGRAM_ID, linkableType: 'Module', linkableId: 'mod-1' });
    expect(mockRequest).toHaveBeenCalledTimes(2);
    const [method, url] = callArgs(1);
    expect(method).toBe('DELETE');
    expect(url).toBe(`/api/projects/${PROJECT_SLUG}/diagrams/${DIAGRAM_ID}/links/link-9`);
  });

  it('errors when no binding matches the given linkableType+linkableId (no DELETE attempted)', async () => {
    mockRequest.mockResolvedValueOnce({ data: [] });
    const result = await callTool('haops_unbind_diagram', { projectSlug: PROJECT_SLUG, diagramId: DIAGRAM_ID, linkableType: 'Module', linkableId: 'nope' });
    expect(result.isError).toBe(true);
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it('errors when neither linkId nor a linkableType+linkableId pair is given', async () => {
    const result = await callTool('haops_unbind_diagram', { projectSlug: PROJECT_SLUG, diagramId: DIAGRAM_ID });
    expect(result.isError).toBe(true);
    expect(mockRequest).not.toHaveBeenCalled();
  });
});

describe('haops_add_diagram_element / haops_update_diagram_element / haops_delete_diagram_element', () => {
  it('add: appends a node with an auto-generated id and the freshly-read hash', async () => {
    mockRequest.mockResolvedValueOnce({ id: DIAGRAM_ID, content: freshEmptyContent(), contentHash: CURRENT_HASH });
    mockRequest.mockResolvedValueOnce({ id: DIAGRAM_ID });
    const result = await callTool('haops_add_diagram_element', {
      projectSlug: PROJECT_SLUG, diagramId: DIAGRAM_ID, elementType: 'node',
      node: { position: { x: 10, y: 20 }, data: { label: 'Start' } },
    });
    expect(result.isError).toBeUndefined();
    const [, , body] = callArgs(1);
    const content = (body as { content: { nodes: Array<{ id: string; position: unknown }> } }).content;
    expect(content.nodes).toHaveLength(1);
    expect(content.nodes[0].position).toEqual({ x: 10, y: 20 });
    expect((body as { baseContentHash: string }).baseContentHash).toBe(CURRENT_HASH);
  });

  it('add: errors (no write) when node.position is missing', async () => {
    mockRequest.mockResolvedValueOnce({ id: DIAGRAM_ID, content: freshEmptyContent(), contentHash: CURRENT_HASH });
    const result = await callTool('haops_add_diagram_element', {
      projectSlug: PROJECT_SLUG, diagramId: DIAGRAM_ID, elementType: 'node', node: { data: { label: 'X' } },
    });
    expect(result.isError).toBe(true);
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it('add: surfaces 409 stale with a "just retry" message', async () => {
    mockRequest.mockResolvedValueOnce({ id: DIAGRAM_ID, content: freshEmptyContent(), contentHash: CURRENT_HASH });
    mockRequest.mockRejectedValueOnce(staleError());
    const result = await callTool('haops_add_diagram_element', {
      projectSlug: PROJECT_SLUG, diagramId: DIAGRAM_ID, elementType: 'node', node: { position: { x: 0, y: 0 }, data: { label: 'X' } },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/retry/i);
  });

  it('update: shallow-merges data key-by-key rather than replacing it wholesale', async () => {
    const existingContent = {
      nodes: [{ id: 'n1', type: 'generic', position: { x: 0, y: 0 }, data: { label: 'Old', color: 'red' } }],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    };
    mockRequest.mockResolvedValueOnce({ id: DIAGRAM_ID, content: existingContent, contentHash: CURRENT_HASH });
    mockRequest.mockResolvedValueOnce({ id: DIAGRAM_ID });
    await callTool('haops_update_diagram_element', {
      projectSlug: PROJECT_SLUG, diagramId: DIAGRAM_ID, elementType: 'node', elementId: 'n1', patch: { data: { label: 'New' } },
    });
    const [, , body] = callArgs(1);
    const node = (body as { content: { nodes: Array<{ data: Record<string, unknown> }> } }).content.nodes[0];
    expect(node.data).toEqual({ label: 'New', color: 'red' }); // color preserved, label overwritten
  });

  it('update: errors (no write) when the elementId is not found', async () => {
    mockRequest.mockResolvedValueOnce({ id: DIAGRAM_ID, content: freshEmptyContent(), contentHash: CURRENT_HASH });
    const result = await callTool('haops_update_diagram_element', {
      projectSlug: PROJECT_SLUG, diagramId: DIAGRAM_ID, elementType: 'node', elementId: 'missing', patch: { data: { label: 'X' } },
    });
    expect(result.isError).toBe(true);
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it('delete: removing a node cascades to remove its edges and reports the count', async () => {
    const existingContent = {
      nodes: [
        { id: 'n1', type: 'generic', position: { x: 0, y: 0 }, data: { label: 'A' } },
        { id: 'n2', type: 'generic', position: { x: 100, y: 0 }, data: { label: 'B' } },
      ],
      edges: [{ id: 'e1', source: 'n1', target: 'n2', type: 'generic' }],
      viewport: { x: 0, y: 0, zoom: 1 },
    };
    mockRequest.mockResolvedValueOnce({ id: DIAGRAM_ID, content: existingContent, contentHash: CURRENT_HASH });
    mockRequest.mockResolvedValueOnce({ id: DIAGRAM_ID });
    const result = await callTool('haops_delete_diagram_element', {
      projectSlug: PROJECT_SLUG, diagramId: DIAGRAM_ID, elementType: 'node', elementId: 'n1',
    });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text) as { deletedId: string; cascadedEdgesRemoved: number };
    expect(parsed.cascadedEdgesRemoved).toBe(1);
    const [, , body] = callArgs(1);
    const content = (body as { content: { nodes: unknown[]; edges: unknown[] } }).content;
    expect(content.nodes).toHaveLength(1);
    expect(content.edges).toHaveLength(0);
  });

  it('delete: errors (no write) when the elementId is not found', async () => {
    mockRequest.mockResolvedValueOnce({ id: DIAGRAM_ID, content: freshEmptyContent(), contentHash: CURRENT_HASH });
    const result = await callTool('haops_delete_diagram_element', {
      projectSlug: PROJECT_SLUG, diagramId: DIAGRAM_ID, elementType: 'edge', elementId: 'missing',
    });
    expect(result.isError).toBe(true);
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });
});

describe('haops_batch_diagram_elements', () => {
  it('reads once and writes once for a mix of add/update/remove', async () => {
    const existingContent = {
      nodes: [{ id: 'n1', type: 'generic', position: { x: 0, y: 0 }, data: { label: 'Keep' } }],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    };
    mockRequest.mockResolvedValueOnce({ id: DIAGRAM_ID, content: existingContent, contentHash: CURRENT_HASH });
    mockRequest.mockResolvedValueOnce({ id: DIAGRAM_ID });

    const result = await callTool('haops_batch_diagram_elements', {
      projectSlug: PROJECT_SLUG,
      diagramId: DIAGRAM_ID,
      add: {
        nodes: [{ id: 'n2', position: { x: 50, y: 50 }, data: { label: 'New' } }],
        edges: [{ source: 'n1', target: 'n2' }], // references a same-call added node
      },
      update: [{ elementType: 'node', elementId: 'n1', patch: { data: { label: 'Updated' } } }],
    });

    expect(mockRequest).toHaveBeenCalledTimes(2); // ONE read, ONE write regardless of op count
    const [, , body] = callArgs(1);
    const content = (body as { content: { nodes: Array<{ id: string; data: { label: string } }>; edges: Array<{ source: string; target: string }> } }).content;
    expect(content.nodes).toHaveLength(2);
    expect(content.nodes.find((n) => n.id === 'n1')!.data.label).toBe('Updated');
    expect(content.edges).toHaveLength(1);
    expect(content.edges[0]).toMatchObject({ source: 'n1', target: 'n2' });

    const parsed = JSON.parse(result.content[0].text) as { addedIds: string[] };
    expect(parsed.addedIds).toContain('n2');
  });

  it('remove cascades node->edge deletion and reports warnings for unknown ids without failing the call', async () => {
    const existingContent = {
      nodes: [
        { id: 'n1', type: 'generic', position: { x: 0, y: 0 }, data: {} },
        { id: 'n2', type: 'generic', position: { x: 0, y: 0 }, data: {} },
      ],
      edges: [{ id: 'e1', source: 'n1', target: 'n2', type: 'generic' }],
      viewport: { x: 0, y: 0, zoom: 1 },
    };
    mockRequest.mockResolvedValueOnce({ id: DIAGRAM_ID, content: existingContent, contentHash: CURRENT_HASH });
    mockRequest.mockResolvedValueOnce({ id: DIAGRAM_ID });

    const result = await callTool('haops_batch_diagram_elements', {
      projectSlug: PROJECT_SLUG,
      diagramId: DIAGRAM_ID,
      remove: [
        { elementType: 'node', elementId: 'n1' },
        { elementType: 'node', elementId: 'does-not-exist' },
      ],
    });

    const parsed = JSON.parse(result.content[0].text) as { cascadedEdgesRemoved: number; warnings: string[] };
    expect(parsed.cascadedEdgesRemoved).toBe(1);
    expect(parsed.warnings.some((w) => w.includes('does-not-exist'))).toBe(true);
    expect(result.isError).toBeUndefined(); // partial-failure warnings don't fail the whole batch
  });

  it('surfaces 409 stale with the retry message', async () => {
    mockRequest.mockResolvedValueOnce({ id: DIAGRAM_ID, content: freshEmptyContent(), contentHash: CURRENT_HASH });
    mockRequest.mockRejectedValueOnce(staleError());
    const result = await callTool('haops_batch_diagram_elements', {
      projectSlug: PROJECT_SLUG, diagramId: DIAGRAM_ID, add: { nodes: [{ position: { x: 0, y: 0 }, data: {} }] },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/retry/i);
  });
});

describe('haops_auto_arrange_diagram', () => {
  it('is a no-op (no write) for a bpmn diagram', async () => {
    mockRequest.mockResolvedValueOnce({ id: DIAGRAM_ID, diagramType: 'bpmn', content: { nodes: [{}, {}], edges: [] }, contentHash: CURRENT_HASH });
    const result = await callTool('haops_auto_arrange_diagram', { projectSlug: PROJECT_SLUG, diagramId: DIAGRAM_ID });
    expect(result.isError).toBeUndefined();
    expect(mockRequest).toHaveBeenCalledTimes(1); // only the GET
  });

  it('is a no-op (no write) for fewer than 2 nodes', async () => {
    mockRequest.mockResolvedValueOnce({ id: DIAGRAM_ID, diagramType: 'flowchart', content: { nodes: [{ id: 'n1' }], edges: [] }, contentHash: CURRENT_HASH });
    await callTool('haops_auto_arrange_diagram', { projectSlug: PROJECT_SLUG, diagramId: DIAGRAM_ID });
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it('lays out nodes with dagre and writes new positions back, leaving data untouched', async () => {
    const existingContent = {
      nodes: [
        { id: 'n1', type: 'generic', position: { x: 0, y: 0 }, data: { label: 'A' } },
        { id: 'n2', type: 'generic', position: { x: 0, y: 0 }, data: { label: 'B' } },
        { id: 'n3', type: 'generic', position: { x: 0, y: 0 }, data: { label: 'C' } },
      ],
      edges: [
        { id: 'e1', source: 'n1', target: 'n2', type: 'generic' },
        { id: 'e2', source: 'n2', target: 'n3', type: 'generic' },
      ],
      viewport: { x: 0, y: 0, zoom: 1 },
    };
    mockRequest.mockResolvedValueOnce({ id: DIAGRAM_ID, diagramType: 'flowchart', content: existingContent, contentHash: CURRENT_HASH });
    mockRequest.mockResolvedValueOnce({ id: DIAGRAM_ID });

    const result = await callTool('haops_auto_arrange_diagram', { projectSlug: PROJECT_SLUG, diagramId: DIAGRAM_ID, direction: 'LR' });
    expect(result.isError).toBeUndefined();

    const [, , body] = callArgs(1);
    const content = (body as { content: { nodes: Array<{ id: string; position: { x: number; y: number }; data: { label: string } }> } }).content;
    expect(content.nodes).toHaveLength(3);
    // A linear chain laid out left-to-right should strictly increase in x.
    const byId = new Map(content.nodes.map((n) => [n.id, n]));
    expect(byId.get('n1')!.position.x).toBeLessThan(byId.get('n2')!.position.x);
    expect(byId.get('n2')!.position.x).toBeLessThan(byId.get('n3')!.position.x);
    // data is untouched by the layout pass.
    expect(byId.get('n1')!.data.label).toBe('A');
  });

  it('surfaces 409 stale with the retry message', async () => {
    mockRequest.mockResolvedValueOnce({
      id: DIAGRAM_ID, diagramType: 'flowchart',
      content: { nodes: [{ id: 'n1', position: { x: 0, y: 0 } }, { id: 'n2', position: { x: 0, y: 0 } }], edges: [] },
      contentHash: CURRENT_HASH,
    });
    mockRequest.mockRejectedValueOnce(staleError());
    const result = await callTool('haops_auto_arrange_diagram', { projectSlug: PROJECT_SLUG, diagramId: DIAGRAM_ID });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/retry/i);
  });
});

describe('haops_render_stored_diagram', () => {
  it('defaults to format=png and includes scale only when given', async () => {
    mockRequest.mockResolvedValueOnce({ diagramId: DIAGRAM_ID, format: 'png', pngBase64: 'abc', width: 100, height: 50 });
    await callTool('haops_render_stored_diagram', { projectSlug: PROJECT_SLUG, diagramId: DIAGRAM_ID });
    const [method, url] = callArgs();
    expect(method).toBe('GET');
    expect(url).toBe(`/api/projects/${PROJECT_SLUG}/diagrams/${DIAGRAM_ID}/render?format=png`);
  });

  it('passes format=svg and scale through', async () => {
    mockRequest.mockResolvedValueOnce({ diagramId: DIAGRAM_ID, format: 'svg', svg: '<svg/>', width: 100, height: 50 });
    await callTool('haops_render_stored_diagram', { projectSlug: PROJECT_SLUG, diagramId: DIAGRAM_ID, format: 'svg', scale: 3 });
    const [, url] = callArgs();
    expect(url).toBe(`/api/projects/${PROJECT_SLUG}/diagrams/${DIAGRAM_ID}/render?format=svg&scale=3`);
  });
});
