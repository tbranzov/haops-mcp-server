/**
 * Regression tests for HTTP transport edge cases not covered by
 * http-server.test.ts. Added by QA (2026-04-17) during Phase 1 review.
 *
 * Each test guards a specific behaviour we manually observed on the running
 * daemon; if that behaviour ever regresses, these tests should catch it.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import request from 'supertest';
import { createHttpServer, type HttpServerHandle } from './http-server.js';

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

const MCP_ACCEPT = 'application/json, text/event-stream';
const MCP_PROTOCOL_VERSION = '2025-03-26';

const INITIALIZE_BODY = {
  jsonrpc: '2.0',
  method: 'initialize',
  params: {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'qa-regression', version: '0.0.0' },
  },
  id: 1,
};

async function initSession(
  httpServer: HttpServerHandle['httpServer']
): Promise<string> {
  const res = await request(httpServer)
    .post('/mcp')
    .set('Accept', MCP_ACCEPT)
    .send(INITIALIZE_BODY);
  expect(res.status).toBe(200);
  return res.headers['mcp-session-id'];
}

describe('HTTP server — regression (QA)', () => {
  let handle: HttpServerHandle;

  beforeEach(async () => {
    handle = await createHttpServer({
      port: 0,
      listen: true,
      buildMcpServer: makeTestMcpServer,
    });
  });

  afterEach(async () => {
    await handle.close();
  });

  describe('session lifecycle', () => {
    it('DELETE with a valid session id evicts it from the map', async () => {
      const sid = await initSession(handle.httpServer);
      expect(handle.getSessionCount()).toBe(1);

      const res = await request(handle.httpServer)
        .delete('/mcp')
        .set('Accept', MCP_ACCEPT)
        .set('Mcp-Session-Id', sid)
        .set('Mcp-Protocol-Version', MCP_PROTOCOL_VERSION);

      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);
      expect(handle.getSessionCount()).toBe(0);
    });

    it('DELETE with an unknown session id returns 404 (spec recovery signal), not 500 or 200', async () => {
      const res = await request(handle.httpServer)
        .delete('/mcp')
        .set('Accept', MCP_ACCEPT)
        .set('Mcp-Session-Id', '00000000-0000-0000-0000-000000000000')
        .set('Mcp-Protocol-Version', MCP_PROTOCOL_VERSION);

      // MCP spec 2025-03-26 / 2025-06-18: unknown or evicted session ids
      // return HTTP 404 so compliant clients can auto-reinitialise. (Before
      // feature 035c498f, this was 400 + -32600.)
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({
        jsonrpc: '2.0',
        error: expect.objectContaining({ code: -32001 }),
      });
    });

    it('POST to a deleted session id is rejected with 404 (spec recovery signal)', async () => {
      const sid = await initSession(handle.httpServer);

      // Close it
      await request(handle.httpServer)
        .delete('/mcp')
        .set('Accept', MCP_ACCEPT)
        .set('Mcp-Session-Id', sid)
        .set('Mcp-Protocol-Version', MCP_PROTOCOL_VERSION);

      // Now try to use it
      const res = await request(handle.httpServer)
        .post('/mcp')
        .set('Accept', MCP_ACCEPT)
        .set('Mcp-Session-Id', sid)
        .set('Mcp-Protocol-Version', MCP_PROTOCOL_VERSION)
        .send({ jsonrpc: '2.0', method: 'tools/list', id: 5 });

      // 404 + -32001 per MCP spec (was 400 + -32600 before feature 035c498f).
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({
        jsonrpc: '2.0',
        error: expect.objectContaining({ code: -32001 }),
      });
    });
  });

  describe('DNS rebinding protection — edge cases', () => {
    it('rejects a Host header with allowed-host suffix-attack pattern', async () => {
      // Ensures the allowlist uses *exact* equality. If the code ever switched
      // to a `endsWith` / `includes` pattern, 127.0.0.1:PORT.evil.com would
      // slip through.
      const addr = handle.httpServer.address();
      const port =
        addr && typeof addr === 'object' && addr !== null ? addr.port : 0;
      const res = await request(handle.httpServer)
        .get('/health')
        .set('Host', `127.0.0.1:${port}.evil.com`);
      expect(res.status).toBe(403);
    });

    it('rejects a Host header with a different port', async () => {
      const res = await request(handle.httpServer)
        .get('/health')
        .set('Host', '127.0.0.1:9999');
      expect(res.status).toBe(403);
    });

    it('applies Host-header check to OPTIONS / DELETE too (not just GET/POST)', async () => {
      const optionsRes = await request(handle.httpServer)
        .options('/mcp')
        .set('Host', 'evil.example.com');
      expect(optionsRes.status).toBe(403);

      const deleteRes = await request(handle.httpServer)
        .delete('/mcp')
        .set('Host', 'evil.example.com');
      expect(deleteRes.status).toBe(403);
    });
  });

  describe('CORS default posture', () => {
    it('emits no Access-Control-Allow-* headers by default', async () => {
      // Phase 1 posture: local-only daemon, no CORS enabled. If someone
      // accidentally wires in the cors() middleware without scoping origins,
      // this test fails loudly.
      const res = await request(handle.httpServer).get('/health');
      expect(res.status).toBe(200);
      for (const header of Object.keys(res.headers)) {
        expect(header.toLowerCase()).not.toMatch(/^access-control-/);
      }
    });
  });

  describe('unknown tools — JSON-RPC error, not HTTP 500', () => {
    it('returns HTTP 200 with an error envelope for an unknown tool name', async () => {
      const sid = await initSession(handle.httpServer);
      const res = await request(handle.httpServer)
        .post('/mcp')
        .set('Accept', MCP_ACCEPT)
        .set('Mcp-Session-Id', sid)
        .set('Mcp-Protocol-Version', MCP_PROTOCOL_VERSION)
        .send({
          jsonrpc: '2.0',
          method: 'tools/call',
          params: { name: 'nonexistent_tool', arguments: {} },
          id: 99,
        });

      // The MCP SDK converts a thrown Error in a tool handler into a
      // JSON-RPC error at the *transport* layer — HTTP stays 200.
      expect(res.status).toBe(200);
      expect(res.body.jsonrpc).toBe('2.0');
      // Either res.body.error (JSON-RPC error) or res.body.result.isError
      const surfacedError =
        !!res.body.error || !!(res.body.result && res.body.result.isError);
      expect(surfacedError).toBe(true);
    });
  });

  describe('body size limit', () => {
    it('rejects a POST body larger than 4mb with 4xx', async () => {
      // express.json({ limit: '4mb' }) — 5mb of garbage must be rejected.
      const big = 'x'.repeat(5 * 1024 * 1024);
      const res = await request(handle.httpServer)
        .post('/mcp')
        .set('Accept', MCP_ACCEPT)
        .set('Content-Type', 'application/json')
        .send(
          JSON.stringify({
            jsonrpc: '2.0',
            method: 'initialize',
            params: {
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: {},
              clientInfo: { name: 'qa', version: '0.0.0', big },
            },
            id: 1,
          })
        );

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    });
  });

  describe('missing Host header', () => {
    it('rejects with 400 when Host header is absent', async () => {
      // supertest always auto-sets Host. We reach through to the underlying
      // net socket to hand-craft a request without one.
      const addr = handle.httpServer.address();
      if (!addr || typeof addr !== 'object') {
        throw new Error('no address');
      }
      const { port } = addr;

      const { connect } = await import('node:net');
      const response: string = await new Promise((resolve, reject) => {
        const sock = connect(port, '127.0.0.1', () => {
          // HTTP/1.0 does not require Host; use that to legally omit it.
          sock.write('GET /health HTTP/1.0\r\n\r\n');
        });
        let buf = '';
        sock.on('data', (d) => {
          buf += d.toString('utf8');
        });
        sock.on('end', () => resolve(buf));
        sock.on('error', reject);
        setTimeout(() => {
          sock.destroy();
          resolve(buf);
        }, 1000);
      });

      expect(response).toMatch(/HTTP\/1\.[01] 400/);
      expect(response).toMatch(/Missing Host header/);
    });
  });

  describe('session count accounting', () => {
    it('getSessionCount reflects DELETE evictions correctly', async () => {
      const s1 = await initSession(handle.httpServer);
      const s2 = await initSession(handle.httpServer);
      await initSession(handle.httpServer);
      expect(handle.getSessionCount()).toBe(3);

      await request(handle.httpServer)
        .delete('/mcp')
        .set('Accept', MCP_ACCEPT)
        .set('Mcp-Session-Id', s1)
        .set('Mcp-Protocol-Version', MCP_PROTOCOL_VERSION);
      expect(handle.getSessionCount()).toBe(2);

      await request(handle.httpServer)
        .delete('/mcp')
        .set('Accept', MCP_ACCEPT)
        .set('Mcp-Session-Id', s2)
        .set('Mcp-Protocol-Version', MCP_PROTOCOL_VERSION);
      expect(handle.getSessionCount()).toBe(1);
    });
  });
});
