/**
 * HTTP transport mode for haops-mcp-server.
 *
 * Starts an Express HTTP daemon that speaks MCP over StreamableHTTPServerTransport.
 * Designed as an N:1 shared daemon: multiple Claude clients can POST to /mcp
 * concurrently and share the same HAOps API client singleton / auth context.
 *
 * Stdio mode remains the default (see src/index.ts). Express is dynamically
 * imported so stdio sessions never pay the express startup cost.
 *
 * Architecture
 * ------------
 *   - ONE HAOps API client / auth context (the singleton in src/api/client.ts).
 *   - ONE MCP `Server` instance is NOT sufficient — the SDK's `Protocol.connect()`
 *     asserts `_transport === undefined`, so each active transport must own its
 *     own Server. We therefore take a `buildMcpServer` factory and materialise
 *     one Server+Transport pair per client session.
 *   - Stateful MCP sessions: first `initialize` POST creates a session and
 *     returns `Mcp-Session-Id`; subsequent POSTs route to the same transport
 *     via that header.
 *   - Per-session transports are cached in an in-memory `Map`; onsessionclosed
 *     evicts them.
 *
 * Endpoints
 * ---------
 *   POST /mcp     — MCP JSON-RPC (initialize + subsequent calls via Mcp-Session-Id)
 *   GET  /mcp     — SSE stream for server-initiated notifications (per-session)
 *   DELETE /mcp   — explicit session close
 *   GET  /health  — liveness probe
 *
 * Security
 * --------
 *   - DNS rebinding protection via Host-header allowlist middleware.
 *   - Bind to 127.0.0.1 by default (single-user developer machine).
 */

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Server as HttpServer } from 'node:http';
import type { NextFunction, Request, Response } from 'express';

const SERVER_VERSION = '2.3.0';

export interface HttpServerHandle {
  /** The underlying Node HTTP server (useful for supertest / programmatic shutdown). */
  httpServer: HttpServer;
  /** Gracefully close all sessions + the HTTP server. Resolves once sockets drain. */
  close: () => Promise<void>;
  /** Number of POST /mcp requests currently being processed. */
  getActiveConnections: () => number;
  /** Number of live MCP sessions (one per Claude client). */
  getSessionCount: () => number;
}

export interface CreateHttpServerOptions {
  /** TCP port to bind. Use 0 for an OS-assigned port (tests). */
  port: number;
  /** Bind host. Defaults to 127.0.0.1 (single-user, no DNS rebinding surface). */
  host?: string;
  /**
   * If true (default), call .listen(port). Pass false to keep the server
   * unbound — supertest will bind ephemeral ports as needed per request.
   */
  listen?: boolean;
  /**
   * Override the default Host-header allowlist. Accepts entries like
   * 'localhost', 'localhost:3100', '127.0.0.1:3100', '[::1]:3100'.
   *
   * If omitted, the allowlist is computed at request time from the bound
   * port so both fixed-port daemons and port-0 test servers work.
   */
  allowedHosts?: string[];
  /**
   * Factory that produces a fresh MCP `Server` wired up with tool handlers.
   * One Server is created per client session (the SDK Protocol binds 1:1 to
   * a transport).
   */
  buildMcpServer: () => Server;
}

/**
 * Wire up the HAOps MCP server family to an Express app and (optionally)
 * start listening. Returns a handle with a close() for graceful shutdown.
 */
export async function createHttpServer(
  options: CreateHttpServerOptions
): Promise<HttpServerHandle> {
  // Dynamic imports: stdio users never load express.
  const expressModule = await import('express');
  const express = expressModule.default;
  const httpModule = await import('node:http');
  const cryptoModule = await import('node:crypto');
  const { StreamableHTTPServerTransport } = await import(
    '@modelcontextprotocol/sdk/server/streamableHttp.js'
  );
  const { isInitializeRequest } = await import(
    '@modelcontextprotocol/sdk/types.js'
  );

  const host = options.host ?? '127.0.0.1';
  const listen = options.listen ?? true;
  const buildMcpServer = options.buildMcpServer;

  type TransportEntry = {
    transport: InstanceType<typeof StreamableHTTPServerTransport>;
    server: Server;
  };
  const sessions = new Map<string, TransportEntry>();

  const app = express();

  // Pre-allocate so middleware closures can read the bound port (port 0 case).
  const httpServer = httpModule.createServer(app);

  const resolveAllowedHosts = (): string[] => {
    if (options.allowedHosts) return options.allowedHosts;
    const addr = httpServer.address();
    const boundPort =
      addr && typeof addr === 'object' && addr !== null ? addr.port : options.port;
    return [
      'localhost',
      `localhost:${boundPort}`,
      '127.0.0.1',
      `127.0.0.1:${boundPort}`,
      '[::1]',
      `[::1]:${boundPort}`,
    ];
  };

  // DNS rebinding protection: require Host header ∈ allowed list.
  app.use((req, res, next) => {
    const hostHeader = req.headers.host;
    if (!hostHeader) {
      res.status(400).json({ error: 'Missing Host header' });
      return;
    }
    const allowed = resolveAllowedHosts();
    if (!allowed.includes(hostHeader)) {
      res.status(403).json({ error: `Host not allowed: ${hostHeader}` });
      return;
    }
    next();
  });

  app.use(express.json({ limit: '4mb' }));

  let activeConnections = 0;
  const startedAt = Date.now();

  app.get('/health', (_req, res) => {
    res.status(200).json({
      status: 'ok',
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      version: SERVER_VERSION,
      connections: activeConnections,
      sessions: sessions.size,
    });
  });

  /**
   * Build a new session: fresh MCP Server, fresh transport, onsessioninitialized
   * hook that stashes the pair in our map, onclose hook that evicts it.
   */
  const createSession = async (): Promise<TransportEntry> => {
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => cryptoModule.randomUUID(),
      // JSON responses make concurrent curl/supertest trivial. Streamable
      // HTTP clients that want SSE can still hit GET /mcp.
      enableJsonResponse: true,
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, { transport, server });
      },
      onsessionclosed: (sessionId) => {
        sessions.delete(sessionId);
      },
    });

    transport.onclose = () => {
      // transport.sessionId is populated after initialize.
      // Only evict from the map — don't call server.close() here, because
      // Protocol.close() itself calls transport.close(), which would re-enter
      // this handler and blow the stack.
      const id = transport.sessionId;
      if (id) sessions.delete(id);
    };

    await server.connect(transport);
    return { transport, server };
  };

  /**
   * Handler for all three HTTP methods on /mcp. Routes to the correct
   * session's transport, or creates a new session on `initialize`.
   */
  const handleMcp = async (req: Request, res: Response) => {
    activeConnections += 1;
    try {
      const sessionIdHeader = req.headers['mcp-session-id'];
      const sessionId = Array.isArray(sessionIdHeader)
        ? sessionIdHeader[0]
        : sessionIdHeader;

      let entry: TransportEntry | undefined;

      if (sessionId && sessions.has(sessionId)) {
        entry = sessions.get(sessionId);
      } else if (req.method === 'POST' && !sessionId && isInitializeRequest(req.body)) {
        // First POST from a new client: initialize.
        entry = await createSession();
      } else {
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32600,
            message:
              'Invalid Request: missing or unknown Mcp-Session-Id, and body is not an initialize request',
          },
          id: null,
        });
        return;
      }

      if (!entry) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Session lookup failed' },
          id: null,
        });
        return;
      }

      await entry.transport.handleRequest(req, res, req.body);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('MCP transport error:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : 'Internal error',
          },
          id: null,
        });
      }
    } finally {
      activeConnections -= 1;
    }
  };

  app.post('/mcp', handleMcp);
  app.get('/mcp', handleMcp);
  app.delete('/mcp', handleMcp);

  // Express JSON body-parse errors (malformed body) — return a JSON-RPC
  // error response instead of Express's default HTML.
  app.use(
    (
      err: Error & { type?: string; status?: number },
      _req: Request,
      res: Response,
      next: NextFunction
    ) => {
      if (err.type === 'entity.parse.failed') {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32700, message: 'Parse error: invalid JSON' },
          id: null,
        });
        return;
      }
      next(err);
    }
  );

  if (listen) {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      httpServer.once('error', onError);
      httpServer.listen(options.port, host, () => {
        httpServer.off('error', onError);
        resolve();
      });
    });
  }

  const close = async (): Promise<void> => {
    // Close every active session's transport first, so in-flight MCP
    // requests receive a clean shutdown. The Protocol layer calls
    // transport.close() internally when server.close() runs, so calling
    // server.close() alone is sufficient to tear both down.
    const closers: Array<Promise<unknown>> = [];
    for (const entry of sessions.values()) {
      closers.push(
        entry.server.close().catch(() => {
          /* already closed */
        })
      );
    }
    await Promise.all(closers);
    sessions.clear();

    // Then stop accepting new HTTP connections, if listening.
    if (!httpServer.listening) return;
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });
  };

  return {
    httpServer,
    close,
    getActiveConnections: () => activeConnections,
    getSessionCount: () => sessions.size,
  };
}

/**
 * Wire SIGTERM/SIGINT handlers for a daemon lifecycle. Exits the process
 * after the handle closes. Separate from createHttpServer() so tests can
 * construct servers without installing global signal handlers.
 */
export function installSignalHandlers(handle: HttpServerHandle): void {
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    // eslint-disable-next-line no-console
    console.error(`Received ${signal}, shutting down HTTP daemon...`);
    try {
      await handle.close();
      // eslint-disable-next-line no-console
      console.error('HTTP daemon stopped cleanly');
      process.exit(0);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Error during shutdown:', err);
      process.exit(1);
    }
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}
