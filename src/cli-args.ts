/**
 * CLI argument parsing for haops-mcp-server.
 *
 * Kept separate from src/index.ts so it can be unit-tested without
 * triggering index.ts's top-level HAOPS_API_KEY env check.
 */

export interface ParsedCliArgs {
  httpMode: boolean;
  port: number;
}

/**
 * Parse process.argv.
 *
 * Usage:
 *   node dist/index.js                   — stdio mode (default, backward compat)
 *   node dist/index.js --http            — HTTP daemon on port 3100
 *   node dist/index.js --http --port N   — HTTP daemon on port N
 *
 * Unknown flags produce a stderr warning so typos like `--htpp` or
 * `--http=true` don't silently fall back to stdio mode.
 *
 * Invalid --port values cause a hard exit(1). This is the only path that
 * terminates the process from this function.
 */
export function parseCliArgs(
  argv: string[],
  opts: { exit?: (code: number) => never; warn?: (msg: string) => void } = {}
): ParsedCliArgs {
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const warn = opts.warn ?? ((msg: string) => console.error(msg));

  const args = argv.slice(2);
  const httpMode = args.includes('--http');
  const portIdx = args.indexOf('--port');
  let port = 3100;
  if (portIdx !== -1 && portIdx + 1 < args.length) {
    const raw = args[portIdx + 1];
    const parsed = parseInt(raw, 10);
    if (!Number.isNaN(parsed) && parsed > 0 && parsed < 65536) {
      port = parsed;
    } else {
      warn(`Invalid --port value: ${raw}`);
      exit(1);
    }
  }

  const portValueIdx = portIdx !== -1 ? portIdx + 1 : -1;
  for (let i = 0; i < args.length; i++) {
    if (i === portValueIdx) continue;
    const a = args[i];
    if (a === '--http' || a === '--port') continue;
    warn(`Warning: unknown argument "${a}" ignored. Known flags: --http, --port N.`);
  }

  return { httpMode, port };
}
