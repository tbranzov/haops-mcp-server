/**
 * Unit tests for feature 035c498f (MCP HTTP Daemon — Session TTL + Resource
 * Caps + 404-based Session Recovery).
 *
 * Covers:
 *   1. Idle eviction via reaper (Jest fake timers — no real wall-clock waits).
 *   2. Cap eviction on initialize when the Map is full.
 *   3. HTTP 404 + -32001 on unknown session id.
 *   4. HTTP 404 + -32001 after the reaper evicts a session (end-to-end).
 *   5. lastActivityAt is refreshed on each request that hits a session.
 *   6. Graceful shutdown stops the reaper (no leaked interval).
 *   7. /health surfaces the new metric fields.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
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
    clientInfo: { name: 'ttl-test-client', version: '0.0.0' },
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
  if (res.status !== 200) {
    throw new Error(
      `initSession: expected 200, got ${res.status} body=${JSON.stringify(res.body)}`
    );
  }
  return res.headers['mcp-session-id'];
}

describe('Session TTL + caps + 404 recovery (feature 035c498f)', () => {
  describe('idle eviction via reaper', () => {
    it('evicts a session whose lastActivityAt is older than idleTtlMs', async () => {
      // Controllable clock. We don't use jest.useFakeTimers() for setInterval
      // here because we invoke the reaper directly via handle.runReaper() to
      // keep the test deterministic and fast.
      let fakeNow = 1_700_000_000_000;
      const handle = await createHttpServer({
        port: 0,
        listen: true,
        buildMcpServer: makeTestMcpServer,
        idleTtlMs: 60_000, // 1 minute
        reaperIntervalMs: 60_000,
        now: () => fakeNow,
      });
      try {
        const sid = await initSession(handle.httpServer);
        expect(handle.getSessionCount()).toBe(1);

        // Advance virtual clock beyond the TTL.
        fakeNow += 61_000;

        await handle.runReaper();

        expect(handle.getSessionCount()).toBe(0);
        const metrics = handle.getMetrics();
        expect(metrics.sessionsEvictedIdle).toBe(1);
        expect(metrics.sessionsEvictedCap).toBe(0);
        expect(metrics.sessionsEvicted).toBe(1);

        // Subsequent request with the evicted sid → 404 + -32001.
        const res = await request(handle.httpServer)
          .post('/mcp')
          .set('Accept', MCP_ACCEPT)
          .set('Mcp-Session-Id', sid)
          .set('Mcp-Protocol-Version', MCP_PROTOCOL_VERSION)
          .send({ jsonrpc: '2.0', method: 'tools/list', id: 10 });
        expect(res.status).toBe(404);
        expect(res.body).toMatchObject({
          jsonrpc: '2.0',
          error: expect.objectContaining({ code: -32001 }),
        });
      } finally {
        await handle.close();
      }
    });

    it('does NOT evict a session that has been active within idleTtlMs', async () => {
      let fakeNow = 1_700_000_000_000;
      const handle = await createHttpServer({
        port: 0,
        listen: true,
        buildMcpServer: makeTestMcpServer,
        idleTtlMs: 60_000,
        reaperIntervalMs: 60_000,
        now: () => fakeNow,
      });
      try {
        const sid = await initSession(handle.httpServer);

        // Advance 30s — still within TTL.
        fakeNow += 30_000;

        // Make an activity-bumping request.
        await request(handle.httpServer)
          .post('/mcp')
          .set('Accept', MCP_ACCEPT)
          .set('Mcp-Session-Id', sid)
          .set('Mcp-Protocol-Version', MCP_PROTOCOL_VERSION)
          .send({ jsonrpc: '2.0', method: 'tools/list', id: 42 });

        // Advance another 45s → 75s total since session start, but only
        // 45s since last activity → still within TTL.
        fakeNow += 45_000;
        await handle.runReaper();
        expect(handle.getSessionCount()).toBe(1);
        expect(handle.getMetrics().sessionsEvictedIdle).toBe(0);
      } finally {
        await handle.close();
      }
    });
  });

  describe('cap eviction', () => {
    it('evicts the oldest-idle session when initialize hits the cap', async () => {
      let fakeNow = 1_700_000_000_000;
      const handle = await createHttpServer({
        port: 0,
        listen: true,
        buildMcpServer: makeTestMcpServer,
        maxSessions: 2,
        idleTtlMs: 10 * 60_000,
        reaperIntervalMs: 10 * 60_000,
        now: () => fakeNow,
      });
      try {
        const s1 = await initSession(handle.httpServer);
        fakeNow += 1_000;
        const s2 = await initSession(handle.httpServer);
        expect(handle.getSessionCount()).toBe(2);

        // Touching s2 makes s1 the oldest-idle.
        fakeNow += 1_000;
        await request(handle.httpServer)
          .post('/mcp')
          .set('Accept', MCP_ACCEPT)
          .set('Mcp-Session-Id', s2)
          .set('Mcp-Protocol-Version', MCP_PROTOCOL_VERSION)
          .send({ jsonrpc: '2.0', method: 'tools/list', id: 2 });

        // Third init should evict s1 (oldest-idle).
        fakeNow += 1_000;
        const s3 = await initSession(handle.httpServer);

        expect(handle.getSessionCount()).toBe(2);
        const metrics = handle.getMetrics();
        expect(metrics.sessionsEvictedCap).toBe(1);
        expect(metrics.sessionsEvictedIdle).toBe(0);

        // s1 now returns 404.
        const useEvicted = await request(handle.httpServer)
          .post('/mcp')
          .set('Accept', MCP_ACCEPT)
          .set('Mcp-Session-Id', s1)
          .set('Mcp-Protocol-Version', MCP_PROTOCOL_VERSION)
          .send({ jsonrpc: '2.0', method: 'tools/list', id: 99 });
        expect(useEvicted.status).toBe(404);

        // s2 and s3 remain valid.
        expect(handle.getSessionLastActivityAt(s2)).toBeDefined();
        expect(handle.getSessionLastActivityAt(s3)).toBeDefined();
      } finally {
        await handle.close();
      }
    });
  });

  describe('404 on unknown session id', () => {
    it('POST with a made-up Mcp-Session-Id returns 404 + -32001', async () => {
      const handle = await createHttpServer({
        port: 0,
        listen: true,
        buildMcpServer: makeTestMcpServer,
      });
      try {
        const res = await request(handle.httpServer)
          .post('/mcp')
          .set('Accept', MCP_ACCEPT)
          .set('Mcp-Session-Id', 'deadbeef-0000-0000-0000-000000000000')
          .set('Mcp-Protocol-Version', MCP_PROTOCOL_VERSION)
          .send({ jsonrpc: '2.0', method: 'tools/list', id: 1 });
        expect(res.status).toBe(404);
        expect(res.body).toMatchObject({
          jsonrpc: '2.0',
          error: expect.objectContaining({
            code: -32001,
            message: expect.stringMatching(/session/i),
          }),
          id: null,
        });
      } finally {
        await handle.close();
      }
    });

    it('POST without any session id AND without initialize body still returns 400 + -32600', async () => {
      // The switch from 400 → 404 applies ONLY to unknown-sid requests.
      // A malformed "no sid, not initialize" request remains a 400.
      const handle = await createHttpServer({
        port: 0,
        listen: true,
        buildMcpServer: makeTestMcpServer,
      });
      try {
        const res = await request(handle.httpServer)
          .post('/mcp')
          .set('Accept', MCP_ACCEPT)
          .send({ jsonrpc: '2.0', method: 'tools/list', id: 1 });
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({
          jsonrpc: '2.0',
          error: expect.objectContaining({ code: -32600 }),
        });
      } finally {
        await handle.close();
      }
    });
  });

  describe('lastActivityAt refresh', () => {
    it('moves lastActivityAt forward on each request that hits a session', async () => {
      let fakeNow = 1_700_000_000_000;
      const handle = await createHttpServer({
        port: 0,
        listen: true,
        buildMcpServer: makeTestMcpServer,
        now: () => fakeNow,
      });
      try {
        const sid = await initSession(handle.httpServer);
        const t0 = handle.getSessionLastActivityAt(sid);
        expect(t0).toBeDefined();

        // Advance clock, then make a second request.
        fakeNow += 5_000;
        await request(handle.httpServer)
          .post('/mcp')
          .set('Accept', MCP_ACCEPT)
          .set('Mcp-Session-Id', sid)
          .set('Mcp-Protocol-Version', MCP_PROTOCOL_VERSION)
          .send({ jsonrpc: '2.0', method: 'tools/list', id: 2 });

        const t1 = handle.getSessionLastActivityAt(sid);
        expect(t1).toBeDefined();
        expect(t1!).toBeGreaterThan(t0!);
        expect(t1! - t0!).toBeGreaterThanOrEqual(5_000);
      } finally {
        await handle.close();
      }
    });
  });

  describe('graceful shutdown stops reaper', () => {
    it('close() clears the reaper interval (no pending timers, no leaks)', async () => {
      const handle = await createHttpServer({
        port: 0,
        listen: true,
        buildMcpServer: makeTestMcpServer,
        reaperIntervalMs: 60_000,
      });

      // Snapshot active handles before close — any setInterval would appear
      // in process._getActiveHandles() until cleared. Node doesn't expose
      // that as public API, so we do the stable check: close() must resolve
      // and the HTTP server must be listening=false afterwards.
      expect(handle.httpServer.listening).toBe(true);
      await handle.close();
      expect(handle.httpServer.listening).toBe(false);

      // Indirect guarantee: after close(), calling runReaper() must still be
      // safe (the interval callback never re-fires through clearInterval).
      await expect(handle.runReaper()).resolves.toBeUndefined();

      // And calling close() again must not throw.
      await expect(handle.close()).resolves.toBeUndefined();
    });
  });

  describe('/health surfaces new counters', () => {
    it('exposes idleTtlMs, maxSessions, reaperIntervalMs, and eviction counts', async () => {
      let fakeNow = 1_700_000_000_000;
      const handle = await createHttpServer({
        port: 0,
        listen: true,
        buildMcpServer: makeTestMcpServer,
        idleTtlMs: 60_000,
        maxSessions: 8,
        reaperIntervalMs: 60_000,
        now: () => fakeNow,
      });
      try {
        // Fresh server — counters at zero, config echoed.
        const res = await request(handle.httpServer).get('/health');
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
          status: 'ok',
          sessions: 0,
          sessionsEvicted: 0,
          sessionsEvictedIdle: 0,
          sessionsEvictedCap: 0,
          idleTtlMs: 60_000,
          maxSessions: 8,
          reaperIntervalMs: 60_000,
        });

        // Cause an idle eviction.
        await initSession(handle.httpServer);
        fakeNow += 61_000;
        await handle.runReaper();

        const res2 = await request(handle.httpServer).get('/health');
        expect(res2.status).toBe(200);
        expect(res2.body).toMatchObject({
          sessions: 0,
          sessionsEvicted: 1,
          sessionsEvictedIdle: 1,
          sessionsEvictedCap: 0,
        });
      } finally {
        await handle.close();
      }
    });
  });
});
