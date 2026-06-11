/**
 * MCP Telemetry — fire-and-forget response byte counter.
 *
 * Records { tool, bytes, calls } per invocation to a local JSONL file
 * at ~/.haops-mcp/stats/<YYYY-MM-DD>.jsonl.
 *
 * Design constraints:
 *   - Zero await in the hot path — all disk I/O is fully async, errors are
 *     silently swallowed so a write failure never crashes the MCP process.
 *   - No network traffic; ingest into a remote store is a future v2.
 *   - Byte count is the UTF-8 byte length of the MCP tool response text.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const STATS_DIR = path.join(os.homedir(), '.haops-mcp', 'stats');

// Ensure the stats directory exists once at module load — synchronous here so
// we don't need to await before the first write, which would introduce latency.
try {
  fs.mkdirSync(STATS_DIR, { recursive: true });
} catch {
  // Silently ignore if creation fails (permissions, etc.)
}

function todayFile(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return path.join(STATS_DIR, `${yyyy}-${mm}-${dd}.jsonl`);
}

/**
 * Record a tool invocation. Fire-and-forget — returns immediately.
 *
 * @param toolName  - The MCP tool name (e.g. "haops_create_issue")
 * @param responseText - The text content of the MCP response
 */
export function recordToolCall(toolName: string, responseText: string): void {
  const bytes = Buffer.byteLength(responseText, 'utf8');
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    tool: toolName,
    bytes,
  }) + '\n';

  // Fire-and-forget — deliberately NOT awaited
  fs.appendFile(todayFile(), entry, (err) => {
    if (err) {
      // Silently ignore — telemetry must never break the tool call
    }
  });
}
