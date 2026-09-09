/**
 * Contract tests for the DB Explorer -> Diagram Studio MCP toolset (module
 * d881186f, feature e4448315-f194-49c0-aeeb-04b260d2095c — F3 agent
 * enablement), issues e2139c3f (introspect/sample), a15af48c (schema-diff),
 * 59f157eb (sync), de31fc5f (plan_table/plan_change/batch_database_elements),
 * 28dc63c5 (create_diagram database support), 748ad610 (this file).
 *
 * Same harness as diagram-tools.test.ts: mock the API client's generic
 * `request(method, url, data?)` and drive tools via the real
 * buildMcpServer()'s tools/call handler, asserting on (method, url, body)
 * triples plus the contentHash read-modify-write precondition for the
 * mutating tools (haops_plan_table / haops_plan_change /
 * haops_batch_database_elements).
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

function resultJson(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

const PROJECT_SLUG = 'test-project';
const DIAGRAM_ID = 'diagram-1';
const DATABASE_ID = 'db-1';
const CURRENT_HASH = 'a'.repeat(64);

function databaseDiagram(nodes: Array<Record<string, unknown>> = [], edges: Array<Record<string, unknown>> = []) {
  return {
    id: DIAGRAM_ID,
    diagramType: 'database',
    content: { nodes, edges, viewport: { x: 0, y: 0, zoom: 1 } },
    contentHash: CURRENT_HASH,
  };
}

function deployedTableNode(tableName: string, columns: Array<Record<string, unknown>> = [], position = { x: 100, y: 200 }) {
  return {
    id: `db_table_${tableName}`,
    type: 'database.table',
    position,
    data: { label: tableName, columns, layer: 'deployed', provenance: 'introspected' },
  };
}

/** Access the (method, url, body) of the Nth call to the mocked `request`. */
function callArgs(n = 0): [string, string, unknown] {
  return mockRequest.mock.calls[n] as [string, string, unknown];
}

function staleError() {
  const { HAOpsApiError } = jest.requireMock('./api/client.js') as { HAOpsApiError: new (m: string, s?: number, r?: unknown) => Error };
  return new HAOpsApiError('HTTP 409: stale', 409, { error: 'stale', currentHash: 'b'.repeat(64) });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('haops_introspect_database', () => {
  it('POSTs to the databases schema route with includeRowCounts when supplied', async () => {
    mockRequest.mockResolvedValueOnce({ success: true, schema: { tables: [], relationships: [] } });
    await callTool('haops_introspect_database', { projectSlug: PROJECT_SLUG, databaseId: DATABASE_ID, includeRowCounts: true });
    const [method, url, body] = callArgs();
    expect(method).toBe('POST');
    expect(url).toBe(`/api/projects/${PROJECT_SLUG}/databases/${DATABASE_ID}/schema`);
    expect(body).toEqual({ includeRowCounts: true });
  });

  it('sends an empty body when includeRowCounts is omitted', async () => {
    mockRequest.mockResolvedValueOnce({ success: true, schema: {} });
    await callTool('haops_introspect_database', { projectSlug: PROJECT_SLUG, databaseId: DATABASE_ID });
    const [, , body] = callArgs();
    expect(body).toEqual({});
  });
});

describe('haops_sample_table_data', () => {
  it('POSTs tableName plus any supplied paging/sort fields', async () => {
    mockRequest.mockResolvedValueOnce({ success: true, data: { rows: [], totalRows: 0, page: 0, pageSize: 25 } });
    await callTool('haops_sample_table_data', {
      projectSlug: PROJECT_SLUG, databaseId: DATABASE_ID, tableName: 'users', page: 1, pageSize: 10, sortBy: 'id', sortOrder: 'desc',
    });
    const [method, url, body] = callArgs();
    expect(method).toBe('POST');
    expect(url).toBe(`/api/projects/${PROJECT_SLUG}/databases/${DATABASE_ID}/table-data`);
    expect(body).toEqual({ tableName: 'users', page: 1, pageSize: 10, sortBy: 'id', sortOrder: 'desc' });
  });

  it('sends only tableName when paging/sort are omitted', async () => {
    mockRequest.mockResolvedValueOnce({ success: true, data: { rows: [], totalRows: 0, page: 0, pageSize: 25 } });
    await callTool('haops_sample_table_data', { projectSlug: PROJECT_SLUG, databaseId: DATABASE_ID, tableName: 'users' });
    const [, , body] = callArgs();
    expect(body).toEqual({ tableName: 'users' });
  });
});

describe('haops_get_schema_diff', () => {
  it('GETs the schema-diff route', async () => {
    mockRequest.mockResolvedValueOnce({ addedTables: [], droppedTables: [], addedColumns: [], modifiedColumns: [], droppedColumns: [], addedRelationships: [], droppedRelationships: [] });
    await callTool('haops_get_schema_diff', { projectSlug: PROJECT_SLUG, diagramId: DIAGRAM_ID });
    expect(callArgs()).toEqual(['GET', `/api/projects/${PROJECT_SLUG}/diagrams/${DIAGRAM_ID}/schema-diff`, undefined]);
  });
});

describe('haops_sync_database_diagram', () => {
  it('checkOnly:true GETs the sync route (read-only drift check)', async () => {
    mockRequest.mockResolvedValueOnce({ changed: false, lastSyncedAt: null });
    await callTool('haops_sync_database_diagram', { projectSlug: PROJECT_SLUG, diagramId: DIAGRAM_ID, checkOnly: true });
    expect(callArgs()).toEqual(['GET', `/api/projects/${PROJECT_SLUG}/diagrams/${DIAGRAM_ID}/sync`, undefined]);
  });

  it('checkOnly omitted POSTs the real sync with includeRowCounts when supplied', async () => {
    mockRequest.mockResolvedValueOnce({ diagram: { id: DIAGRAM_ID }, addedTables: [], removedTables: [], drift: [] });
    await callTool('haops_sync_database_diagram', { projectSlug: PROJECT_SLUG, diagramId: DIAGRAM_ID, includeRowCounts: true });
    const [method, url, body] = callArgs();
    expect(method).toBe('POST');
    expect(url).toBe(`/api/projects/${PROJECT_SLUG}/diagrams/${DIAGRAM_ID}/sync`);
    expect(body).toEqual({ includeRowCounts: true });
  });

  it('checkOnly:false also POSTs (not GET)', async () => {
    mockRequest.mockResolvedValueOnce({ diagram: { id: DIAGRAM_ID }, addedTables: [], removedTables: [], drift: [] });
    await callTool('haops_sync_database_diagram', { projectSlug: PROJECT_SLUG, diagramId: DIAGRAM_ID, checkOnly: false });
    const [method] = callArgs();
    expect(method).toBe('POST');
  });
});

describe('haops_plan_table', () => {
  it('reads once, appends a planned new-table node, and writes back with the freshly-read contentHash', async () => {
    mockRequest.mockResolvedValueOnce(databaseDiagram()); // GET
    mockRequest.mockResolvedValueOnce({ id: DIAGRAM_ID }); // PATCH

    const result = await callTool('haops_plan_table', {
      projectSlug: PROJECT_SLUG,
      diagramId: DIAGRAM_ID,
      tableName: 'widgets',
      columns: [{ name: 'id', dataType: 'uuid', isPrimaryKey: true, nullable: false }],
    });

    expect(mockRequest).toHaveBeenCalledTimes(2);
    const [getMethod, getUrl] = callArgs(0);
    expect(getMethod).toBe('GET');
    expect(getUrl).toBe(`/api/projects/${PROJECT_SLUG}/diagrams/${DIAGRAM_ID}`);

    const [patchMethod, patchUrl, patchBody] = callArgs(1);
    expect(patchMethod).toBe('PATCH');
    expect(patchUrl).toBe(`/api/projects/${PROJECT_SLUG}/diagrams/${DIAGRAM_ID}`);
    const body = patchBody as { content: { nodes: Array<Record<string, unknown>> }; baseContentHash: string };
    expect(body.baseContentHash).toBe(CURRENT_HASH);
    expect(body.content.nodes).toHaveLength(1);
    const node = body.content.nodes[0];
    expect(node.type).toBe('database.table');
    const data = node.data as Record<string, unknown>;
    expect(data.label).toBe('widgets');
    expect(data.layer).toBe('planned');
    expect(data.provenance).toBe('authored');
    expect(data.changeKind).toBe('new-table');
    expect(data.columns).toEqual([
      { name: 'id', dataType: 'uuid', maxLength: null, nullable: false, isPrimaryKey: true, isForeignKey: false, isUnique: false, defaultValue: null },
    ]);

    expect(result.isError).toBeUndefined();
    const parsed = resultJson(result);
    expect(typeof parsed.nodeId).toBe('string');
  });

  it('defaults to an empty columns list and {x:0,y:0} position when omitted', async () => {
    mockRequest.mockResolvedValueOnce(databaseDiagram());
    mockRequest.mockResolvedValueOnce({ id: DIAGRAM_ID });
    await callTool('haops_plan_table', { projectSlug: PROJECT_SLUG, diagramId: DIAGRAM_ID, tableName: 'empty_table' });
    const [, , patchBody] = callArgs(1);
    const body = patchBody as { content: { nodes: Array<Record<string, unknown>> } };
    const node = body.content.nodes[0];
    expect(node.position).toEqual({ x: 0, y: 0 });
    expect((node.data as Record<string, unknown>).columns).toEqual([]);
  });

  it('errors (no write) when the target diagram is not diagramType:"database"', async () => {
    mockRequest.mockResolvedValueOnce({ id: DIAGRAM_ID, diagramType: 'flowchart', content: { nodes: [], edges: [] }, contentHash: CURRENT_HASH });
    const result = await callTool('haops_plan_table', { projectSlug: PROJECT_SLUG, diagramId: DIAGRAM_ID, tableName: 'x' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not "database"');
    expect(mockRequest).toHaveBeenCalledTimes(1); // GET only, no PATCH
  });

  it('surfaces a 409 stale conflict with a clear retry message', async () => {
    mockRequest.mockResolvedValueOnce(databaseDiagram());
    mockRequest.mockRejectedValueOnce(staleError());
    const result = await callTool('haops_plan_table', { projectSlug: PROJECT_SLUG, diagramId: DIAGRAM_ID, tableName: 'x' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('stale');
    expect(result.content[0].text).toContain('haops_plan_table');
  });
});

describe('haops_plan_change', () => {
  it('errors (no write) when no deployed table with that name exists', async () => {
    mockRequest.mockResolvedValueOnce(databaseDiagram());
    const result = await callTool('haops_plan_change', {
      projectSlug: PROJECT_SLUG, diagramId: DIAGRAM_ID, targetTableName: 'ghost',
      changes: [{ changeKind: 'add-column', column: { name: 'extra' } }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('no deployed table named "ghost"');
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it('creates a fresh overlay (copy of deployed columns, no changeKind) the first time, offset from the deployed node', async () => {
    const deployed = deployedTableNode('accounts', [
      { name: 'id', dataType: 'uuid', maxLength: null, nullable: false, isPrimaryKey: true, isForeignKey: false, isUnique: false, defaultValue: null },
      { name: 'balance', dataType: 'numeric', maxLength: null, nullable: false, isPrimaryKey: false, isForeignKey: false, isUnique: false, defaultValue: '0' },
    ], { x: 100, y: 200 });
    mockRequest.mockResolvedValueOnce(databaseDiagram([deployed]));
    mockRequest.mockResolvedValueOnce({ id: DIAGRAM_ID });

    const result = await callTool('haops_plan_change', {
      projectSlug: PROJECT_SLUG, diagramId: DIAGRAM_ID, targetTableName: 'accounts',
      changes: [{ changeKind: 'add-column', column: { name: 'currency', dataType: 'char', maxLength: 3 } }],
    });

    const [, , patchBody] = callArgs(1);
    const body = patchBody as { content: { nodes: Array<Record<string, unknown>> } };
    expect(body.content.nodes).toHaveLength(2); // deployed + new overlay
    const overlay = body.content.nodes.find((n) => n.id !== deployed.id)!;
    expect(overlay.position).toEqual({ x: 140, y: 240 });
    const data = overlay.data as Record<string, unknown>;
    expect(data.layer).toBe('planned');
    expect(data.provenance).toBe('authored');
    expect(data.targetTableName).toBe('accounts');
    expect(data.label).toBe('accounts (planned changes)');
    const columns = data.columns as Array<Record<string, unknown>>;
    expect(columns).toHaveLength(3); // id + balance (context, no changeKind) + currency (add-column)
    expect(columns[0].changeKind).toBeUndefined();
    expect(columns[1].changeKind).toBeUndefined();
    expect(columns[2]).toMatchObject({ name: 'currency', dataType: 'char', maxLength: 3, changeKind: 'add-column' });

    expect(result.isError).toBeUndefined();
  });

  it('reuses an existing overlay node rather than creating a second one', async () => {
    const deployed = deployedTableNode('accounts', [{ name: 'id', dataType: 'uuid', maxLength: null, nullable: false, isPrimaryKey: true, isForeignKey: false, isUnique: false, defaultValue: null }]);
    const existingOverlay = {
      id: 'db_table_plan_accounts_existing',
      type: 'database.table',
      position: { x: 140, y: 240 },
      data: { label: 'accounts (planned changes)', targetTableName: 'accounts', layer: 'planned', provenance: 'authored', columns: [{ name: 'id', dataType: 'uuid', maxLength: null, nullable: false, isPrimaryKey: true, isForeignKey: false, isUnique: false, defaultValue: null }] },
    };
    mockRequest.mockResolvedValueOnce(databaseDiagram([deployed, existingOverlay]));
    mockRequest.mockResolvedValueOnce({ id: DIAGRAM_ID });

    await callTool('haops_plan_change', {
      projectSlug: PROJECT_SLUG, diagramId: DIAGRAM_ID, targetTableName: 'accounts',
      changes: [{ changeKind: 'drop-column', columnName: 'id' }],
    });

    const [, , patchBody] = callArgs(1);
    const body = patchBody as { content: { nodes: Array<Record<string, unknown>> } };
    expect(body.content.nodes).toHaveLength(2); // deployed + the SAME overlay, not a third node
    const overlay = body.content.nodes.find((n) => n.id === existingOverlay.id)!;
    const columns = (overlay.data as Record<string, unknown>).columns as Array<Record<string, unknown>>;
    expect(columns).toHaveLength(1);
    expect(columns[0].changeKind).toBe('drop-column');
  });

  it('modify-column snapshots the PRE-patch values into previous* before applying the patch', async () => {
    const deployed = deployedTableNode('accounts', [
      { name: 'balance', dataType: 'numeric', maxLength: null, nullable: false, isPrimaryKey: false, isForeignKey: false, isUnique: false, defaultValue: '0' },
    ]);
    mockRequest.mockResolvedValueOnce(databaseDiagram([deployed]));
    mockRequest.mockResolvedValueOnce({ id: DIAGRAM_ID });

    await callTool('haops_plan_change', {
      projectSlug: PROJECT_SLUG, diagramId: DIAGRAM_ID, targetTableName: 'accounts',
      changes: [{ changeKind: 'modify-column', columnName: 'balance', column: { dataType: 'double precision', nullable: true } }],
    });

    const [, , patchBody] = callArgs(1);
    const body = patchBody as { content: { nodes: Array<Record<string, unknown>> } };
    const overlay = body.content.nodes.find((n) => n.id !== deployed.id)!;
    const column = ((overlay.data as Record<string, unknown>).columns as Array<Record<string, unknown>>)[0];
    expect(column).toMatchObject({
      name: 'balance',
      dataType: 'double precision',
      nullable: true,
      changeKind: 'modify-column',
      previousDataType: 'numeric',
      previousNullable: false,
      previousDefaultValue: '0',
    });
  });

  it('warns (does not fail the call) on an unknown columnName for modify/drop', async () => {
    const deployed = deployedTableNode('accounts', [{ name: 'id', dataType: 'uuid', maxLength: null, nullable: false, isPrimaryKey: true, isForeignKey: false, isUnique: false, defaultValue: null }]);
    mockRequest.mockResolvedValueOnce(databaseDiagram([deployed]));
    mockRequest.mockResolvedValueOnce({ id: DIAGRAM_ID });

    const result = await callTool('haops_plan_change', {
      projectSlug: PROJECT_SLUG, diagramId: DIAGRAM_ID, targetTableName: 'accounts',
      changes: [{ changeKind: 'drop-column', columnName: 'does_not_exist' }],
    });
    expect(result.isError).toBeUndefined();
    const parsed = resultJson(result);
    expect(parsed.warnings).toEqual([expect.stringContaining('no column named "does_not_exist"')]);
  });

  it('surfaces a 409 stale conflict with a clear retry message', async () => {
    const deployed = deployedTableNode('accounts');
    mockRequest.mockResolvedValueOnce(databaseDiagram([deployed]));
    mockRequest.mockRejectedValueOnce(staleError());
    const result = await callTool('haops_plan_change', {
      projectSlug: PROJECT_SLUG, diagramId: DIAGRAM_ID, targetTableName: 'accounts',
      changes: [{ changeKind: 'add-column', column: { name: 'x' } }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('stale');
    expect(result.content[0].text).toContain('haops_plan_change');
  });
});

describe('haops_batch_database_elements', () => {
  it('reads once and writes once for addTables + addEdges (referencing a same-call table by name) + remove', async () => {
    const existingNode = deployedTableNode('legacy_table');
    mockRequest.mockResolvedValueOnce(databaseDiagram([existingNode]));
    mockRequest.mockResolvedValueOnce({ id: DIAGRAM_ID });

    const result = await callTool('haops_batch_database_elements', {
      projectSlug: PROJECT_SLUG,
      diagramId: DIAGRAM_ID,
      addTables: [
        { tableName: 'orders', columns: [{ name: 'id', dataType: 'uuid', isPrimaryKey: true }] },
        { tableName: 'order_items' },
      ],
      addEdges: [
        { source: 'order_items', target: 'orders', sourceColumn: 'order_id', targetColumn: 'id', cardinality: 'N:M' },
      ],
      remove: [{ elementType: 'node', elementId: existingNode.id }],
    });

    expect(mockRequest).toHaveBeenCalledTimes(2);
    const [, , patchBody] = callArgs(1);
    const body = patchBody as { content: { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> }; baseContentHash: string };
    expect(body.baseContentHash).toBe(CURRENT_HASH);

    // legacy_table removed, orders + order_items added -> 2 nodes
    expect(body.content.nodes).toHaveLength(2);
    expect(body.content.nodes.find((n) => n.id === existingNode.id)).toBeUndefined();
    const orders = body.content.nodes.find((n) => (n.data as Record<string, unknown>).label === 'orders')!;
    const orderItems = body.content.nodes.find((n) => (n.data as Record<string, unknown>).label === 'order_items')!;
    expect(orders).toBeDefined();
    expect(orderItems).toBeDefined();

    expect(body.content.edges).toHaveLength(1);
    const edge = body.content.edges[0];
    expect(edge.source).toBe(orderItems.id);
    expect(edge.target).toBe(orders.id);
    expect(edge.type).toBe('generic');
    const edgeData = edge.data as Record<string, unknown>;
    expect(edgeData).toMatchObject({ cardinality: 'N:M', sourceColumn: 'order_id', targetColumn: 'id', layer: 'planned', provenance: 'authored' });

    const parsed = resultJson(result);
    expect(parsed.addedTableIds).toHaveLength(2);
    expect(parsed.addedEdgeIds).toHaveLength(1);
    expect(parsed.cascadedEdgesRemoved).toBe(0);
    expect(parsed.warnings).toEqual([]);
  });

  it('warns and skips an addEdges entry whose source/target cannot be resolved', async () => {
    mockRequest.mockResolvedValueOnce(databaseDiagram());
    mockRequest.mockResolvedValueOnce({ id: DIAGRAM_ID });

    const result = await callTool('haops_batch_database_elements', {
      projectSlug: PROJECT_SLUG,
      diagramId: DIAGRAM_ID,
      addEdges: [{ source: 'nonexistent_a', target: 'nonexistent_b', sourceColumn: 'a', targetColumn: 'b' }],
    });

    const [, , patchBody] = callArgs(1);
    const body = patchBody as { content: { edges: Array<Record<string, unknown>> } };
    expect(body.content.edges).toHaveLength(0);
    const parsed = resultJson(result);
    expect(parsed.warnings).toEqual([expect.stringContaining('could not resolve source/target')]);
  });

  it('planChanges creates/updates an overlay for an existing deployed table, batched', async () => {
    const deployed = deployedTableNode('accounts', [{ name: 'id', dataType: 'uuid', maxLength: null, nullable: false, isPrimaryKey: true, isForeignKey: false, isUnique: false, defaultValue: null }]);
    mockRequest.mockResolvedValueOnce(databaseDiagram([deployed]));
    mockRequest.mockResolvedValueOnce({ id: DIAGRAM_ID });

    await callTool('haops_batch_database_elements', {
      projectSlug: PROJECT_SLUG,
      diagramId: DIAGRAM_ID,
      planChanges: [{ targetTableName: 'accounts', changes: [{ changeKind: 'add-column', column: { name: 'nickname' } }] }],
    });

    const [, , patchBody] = callArgs(1);
    const body = patchBody as { content: { nodes: Array<Record<string, unknown>> } };
    expect(body.content.nodes).toHaveLength(2);
    const overlay = body.content.nodes.find((n) => n.id !== deployed.id)!;
    expect((overlay.data as Record<string, unknown>).targetTableName).toBe('accounts');
  });

  it('planChanges warns and skips when the target deployed table does not exist', async () => {
    mockRequest.mockResolvedValueOnce(databaseDiagram());
    mockRequest.mockResolvedValueOnce({ id: DIAGRAM_ID });

    const result = await callTool('haops_batch_database_elements', {
      projectSlug: PROJECT_SLUG,
      diagramId: DIAGRAM_ID,
      planChanges: [{ targetTableName: 'ghost', changes: [{ changeKind: 'add-column', column: { name: 'x' } }] }],
    });
    const parsed = resultJson(result);
    expect(parsed.warnings).toEqual([expect.stringContaining('no deployed table named "ghost"')]);
  });

  it('remove cascades node->edge deletion and reports the count', async () => {
    const nodeA = deployedTableNode('a');
    const nodeB = deployedTableNode('b');
    const edge = { id: 'edge-1', source: nodeA.id, target: nodeB.id, type: 'generic', data: {} };
    mockRequest.mockResolvedValueOnce(databaseDiagram([nodeA, nodeB], [edge]));
    mockRequest.mockResolvedValueOnce({ id: DIAGRAM_ID });

    const result = await callTool('haops_batch_database_elements', {
      projectSlug: PROJECT_SLUG,
      diagramId: DIAGRAM_ID,
      remove: [{ elementType: 'node', elementId: nodeA.id }],
    });

    const [, , patchBody] = callArgs(1);
    const body = patchBody as { content: { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> } };
    expect(body.content.nodes).toHaveLength(1);
    expect(body.content.edges).toHaveLength(0);
    const parsed = resultJson(result);
    expect(parsed.cascadedEdgesRemoved).toBe(1);
  });

  it('errors (no write) when the target diagram is not diagramType:"database"', async () => {
    mockRequest.mockResolvedValueOnce({ id: DIAGRAM_ID, diagramType: 'er', content: { nodes: [], edges: [] }, contentHash: CURRENT_HASH });
    const result = await callTool('haops_batch_database_elements', { projectSlug: PROJECT_SLUG, diagramId: DIAGRAM_ID, addTables: [{ tableName: 'x' }] });
    expect(result.isError).toBe(true);
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it('surfaces a 409 stale conflict with a clear retry message', async () => {
    mockRequest.mockResolvedValueOnce(databaseDiagram());
    mockRequest.mockRejectedValueOnce(staleError());
    const result = await callTool('haops_batch_database_elements', { projectSlug: PROJECT_SLUG, diagramId: DIAGRAM_ID, addTables: [{ tableName: 'x' }] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('stale');
    expect(result.content[0].text).toContain('haops_batch_database_elements');
  });
});

describe('haops_create_diagram — database support', () => {
  it('diagramType:"database" + databaseId POSTs to the databases/[id]/diagram introspect-on-create route', async () => {
    mockRequest.mockResolvedValueOnce({ id: DIAGRAM_ID, title: 'Prod DB', diagramType: 'database' });
    await callTool('haops_create_diagram', { projectSlug: PROJECT_SLUG, diagramType: 'database', databaseId: DATABASE_ID, title: 'Prod DB' });
    const [method, url, body] = callArgs();
    expect(method).toBe('POST');
    expect(url).toBe(`/api/projects/${PROJECT_SLUG}/databases/${DATABASE_ID}/diagram`);
    expect(body).toEqual({ title: 'Prod DB' });
  });

  it('diagramType:"database" + databaseId omits title from the body when not supplied (server defaults to the connection name)', async () => {
    mockRequest.mockResolvedValueOnce({ id: DIAGRAM_ID, title: 'Prod DB', diagramType: 'database' });
    await callTool('haops_create_diagram', { projectSlug: PROJECT_SLUG, diagramType: 'database', databaseId: DATABASE_ID });
    const [, , body] = callArgs();
    expect(body).toEqual({});
  });

  it('diagramType:"database" with NO databaseId falls through to the generic create route', async () => {
    mockRequest.mockResolvedValueOnce({ id: DIAGRAM_ID, title: 'Empty DB Diagram', diagramType: 'database' });
    await callTool('haops_create_diagram', { projectSlug: PROJECT_SLUG, diagramType: 'database', title: 'Empty DB Diagram' });
    const [method, url, body] = callArgs();
    expect(method).toBe('POST');
    expect(url).toBe(`/api/projects/${PROJECT_SLUG}/diagrams`);
    expect(body).toEqual({ title: 'Empty DB Diagram', diagramType: 'database' });
  });

  it('errors (no request made) when title is missing and databaseId is not supplied', async () => {
    const result = await callTool('haops_create_diagram', { projectSlug: PROJECT_SLUG, diagramType: 'flowchart' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('title is required');
    expect(mockRequest).not.toHaveBeenCalled();
  });
});
