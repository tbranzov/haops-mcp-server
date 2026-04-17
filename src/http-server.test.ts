/**
 * Unit tests for HTTP transport mode.
 *
 * We construct a standalone MCP `Server` factory here (not the real haops
 * 110-tool factory from src/index.ts) so tests don't require HAOPS_API_KEY
 * in env and don't touch the real axios client. The transport layer is what
 * we exercise.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import request from 'supertest';
import { createHttpServer, type HttpServerHandle } from './http-server.js';

/**
 * Build a minimal MCP server with one fake tool. This is the test double for
 * the real `buildMcpServer()` from src/index.ts. One call = one fresh Server.
 */
function makeTestMcpServer(): Server {
  const server = new Server(
    { name: 'test-mcp', version: '0.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'test_echo',
        description: 'Echoes input',
        inputSchema: {
          type: 'object',
          properties: { msg: { type: 'string' } },
          required: ['msg'],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name === 'test_echo') {
      const msg = (req.params.arguments as { msg?: string } | undefined)?.msg ?? '';
      return { content: [{ type: 'text', text: `echo: ${msg}` }] };
    }
    throw new Error(`Unknown tool: ${req.params.name}`);
  });

  return server;
}

// MCP Streamable HTTP requires Accept: application/json, text/event-stream
// on POST /mcp. Supertest's default Accept header is rejected by the transport,
// so every test sets this explicitly.
const MCP_ACCEPT = 'application/json, text/event-stream';

// Protocol version required on POST initialize per MCP spec.
const MCP_PROTOCOL_VERSION = '2025-03-26';

const INITIALIZE_BODY = {
  jsonrpc: '2.0',
  method: 'initialize',
  params: {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'test-client', version: '0.0.0' },
  },
  id: 1,
};

/**
 * Drive the MCP client-side handshake and return the session id. Every
 * subsequent request that should route to this session must send
 * `Mcp-Session-Id: <sessionId>` and `Mcp-Protocol-Version`.
 */
async function initSession(
  httpServer: HttpServerHandle['httpServer']
): Promise<string> {
  const res = await request(httpServer)
    .post('/mcp')
    .set('Accept', MCP_ACCEPT)
    .send(INITIALIZE_BODY);
  expect(res.status).toBe(200);
  const sessionId = res.headers['mcp-session-id'];
  expect(sessionId).toBeDefined();
  // Client must also send `notifications/initialized` before issuing
  // non-initialize requests — but the SDK does not strictly enforce that
  // for tools/list/call, so we skip it in tests for brevity.
  return sessionId;
}

describe('HTTP server', () => {
  let handle: HttpServerHandle;

  beforeEach(async () => {
    // listen:true with port 0 → OS-assigned ephemeral port; allowed-hosts
    // middleware reads the bound port at request time, so supertest's
    // auto-generated `127.0.0.1:<port>` Host header passes validation.
    handle = await createHttpServer({
      port: 0,
      listen: true,
      buildMcpServer: makeTestMcpServer,
    });
  });

  afterEach(async () => {
    await handle.close();
  });

  describe('GET /health', () => {
    it('returns 200 with the expected shape', async () => {
      const res = await request(handle.httpServer).get('/health');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: 'ok',
        version: expect.any(String),
        uptime: expect.any(Number),
        connections: expect.any(Number),
        sessions: expect.any(Number),
      });
      expect(res.body.uptime).toBeGreaterThanOrEqual(0);
      expect(res.body.connections).toBeGreaterThanOrEqual(0);
      expect(res.body.sessions).toBe(0);
    });
  });

  describe('POST /mcp — JSON-RPC', () => {
    it('responds to initialize and returns an Mcp-Session-Id', async () => {
      const res = await request(handle.httpServer)
        .post('/mcp')
        .set('Accept', MCP_ACCEPT)
        .send(INITIALIZE_BODY);

      expect(res.status).toBe(200);
      expect(res.headers['mcp-session-id']).toBeDefined();
      expect(res.body).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: expect.any(String),
          capabilities: expect.any(Object),
          serverInfo: expect.objectContaining({ name: 'test-mcp' }),
        },
      });
      expect(handle.getSessionCount()).toBe(1);
    });

    it('responds to tools/list after initialize', async () => {
      const sessionId = await initSession(handle.httpServer);

      const res = await request(handle.httpServer)
        .post('/mcp')
        .set('Accept', MCP_ACCEPT)
        .set('Mcp-Session-Id', sessionId)
        .set('Mcp-Protocol-Version', MCP_PROTOCOL_VERSION)
        .send({ jsonrpc: '2.0', method: 'tools/list', id: 2 });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        jsonrpc: '2.0',
        id: 2,
        result: { tools: expect.any(Array) },
      });
      expect(res.body.result.tools).toHaveLength(1);
      expect(res.body.result.tools[0].name).toBe('test_echo');
    });

    it('responds to tools/call', async () => {
      const sessionId = await initSession(handle.httpServer);

      const res = await request(handle.httpServer)
        .post('/mcp')
        .set('Accept', MCP_ACCEPT)
        .set('Mcp-Session-Id', sessionId)
        .set('Mcp-Protocol-Version', MCP_PROTOCOL_VERSION)
        .send({
          jsonrpc: '2.0',
          method: 'tools/call',
          params: { name: 'test_echo', arguments: { msg: 'hi' } },
          id: 3,
        });

      expect(res.status).toBe(200);
      expect(res.body.result.content[0].text).toBe('echo: hi');
    });

    it('rejects non-initialize requests without a session id', async () => {
      const res = await request(handle.httpServer)
        .post('/mcp')
        .set('Accept', MCP_ACCEPT)
        .send({ jsonrpc: '2.0', method: 'tools/list', id: 99 });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({
        code: -32600,
        message: expect.stringMatching(/session/i),
      });
    });

    it('returns a JSON-RPC parse error for malformed JSON without crashing', async () => {
      const res = await request(handle.httpServer)
        .post('/mcp')
        .set('Accept', MCP_ACCEPT)
        .set('Content-Type', 'application/json')
        .send('{ not json');

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        jsonrpc: '2.0',
        error: { code: -32700 },
        id: null,
      });

      // Server is still alive after the malformed request.
      const healthRes = await request(handle.httpServer).get('/health');
      expect(healthRes.status).toBe(200);
    });
  });

  describe('concurrency — multiple independent sessions', () => {
    it('handles 3 concurrent clients, each with its own session', async () => {
      // Initialize 3 distinct sessions in parallel — each gets its own
      // MCP Server + transport.
      const [s1, s2, s3] = await Promise.all([
        initSession(handle.httpServer),
        initSession(handle.httpServer),
        initSession(handle.httpServer),
      ]);
      expect(s1).not.toBe(s2);
      expect(s2).not.toBe(s3);
      expect(s1).not.toBe(s3);
      expect(handle.getSessionCount()).toBe(3);

      // Concurrently call tools/call through each session.
      const fire = (session: string, msg: string, id: number) =>
        request(handle.httpServer)
          .post('/mcp')
          .set('Accept', MCP_ACCEPT)
          .set('Mcp-Session-Id', session)
          .set('Mcp-Protocol-Version', MCP_PROTOCOL_VERSION)
          .send({
            jsonrpc: '2.0',
            method: 'tools/call',
            params: { name: 'test_echo', arguments: { msg } },
            id,
          });

      const [r1, r2, r3] = await Promise.all([
        fire(s1, 'alpha', 101),
        fire(s2, 'beta', 102),
        fire(s3, 'gamma', 103),
      ]);

      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      expect(r3.status).toBe(200);
      // Each response carries the right id — proves no cross-client mixup.
      expect(r1.body.id).toBe(101);
      expect(r2.body.id).toBe(102);
      expect(r3.body.id).toBe(103);
      expect(r1.body.result.content[0].text).toBe('echo: alpha');
      expect(r2.body.result.content[0].text).toBe('echo: beta');
      expect(r3.body.result.content[0].text).toBe('echo: gamma');
    });
  });

  describe('shutdown', () => {
    it('close() stops a listening HTTP server without throwing', async () => {
      const h2 = await createHttpServer({
        port: 0,
        listen: true,
        buildMcpServer: makeTestMcpServer,
      });
      await expect(h2.close()).resolves.toBeUndefined();
      expect(h2.httpServer.listening).toBe(false);
    });

    it('close() is safe to call twice', async () => {
      const h2 = await createHttpServer({
        port: 0,
        listen: true,
        buildMcpServer: makeTestMcpServer,
      });
      await h2.close();
      await expect(h2.close()).resolves.toBeUndefined();
    });

    it('close() evicts live sessions', async () => {
      await initSession(handle.httpServer);
      await initSession(handle.httpServer);
      expect(handle.getSessionCount()).toBe(2);
      await handle.close();
      expect(handle.getSessionCount()).toBe(0);
    });

    it('simulated SIGTERM shutdown path closes the handle', async () => {
      // We don't call installSignalHandlers (that would clobber the test
      // runner's own handlers). Instead we verify the shutdown *function*
      // — close() — runs cleanly, which is what installSignalHandlers wraps.
      const h2 = await createHttpServer({
        port: 0,
        listen: true,
        buildMcpServer: makeTestMcpServer,
      });
      const before = h2.httpServer.listening;
      await h2.close();
      expect(before).toBe(true);
      expect(h2.httpServer.listening).toBe(false);
    });
  });

  describe('real port listen', () => {
    it('binds an ephemeral port and exposes it via httpServer.address()', async () => {
      const addr = handle.httpServer.address();
      expect(addr).not.toBeNull();
      expect(typeof addr).toBe('object');
      if (addr && typeof addr === 'object') {
        expect(addr.port).toBeGreaterThan(0);
      }
    });
  });

  describe('DNS rebinding protection', () => {
    it('rejects requests with a non-allowed Host header', async () => {
      const res = await request(handle.httpServer)
        .get('/health')
        .set('Host', 'evil.example.com');
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: expect.stringContaining('not allowed') });
    });
  });
});
