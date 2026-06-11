#!/usr/bin/env tsx
/**
 * MCP Telemetry Report — top-N tools by response bytes.
 *
 * Usage:
 *   npx tsx scripts/mcp-stats.ts               # today's stats, top 20
 *   npx tsx scripts/mcp-stats.ts --days 7      # last 7 days combined
 *   npx tsx scripts/mcp-stats.ts --top 10      # show top 10
 *   npx tsx scripts/mcp-stats.ts --days 7 --top 5
 *
 * Reads JSONL files from ~/.haops-mcp/stats/YYYY-MM-DD.jsonl.
 * Each line: { ts: string, tool: string, bytes: number }
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const STATS_DIR = path.join(os.homedir(), '.haops-mcp', 'stats');

// ── CLI args ──────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
function getFlag(flag: string, defaultVal: number): number {
  const idx = argv.indexOf(flag);
  if (idx === -1) return defaultVal;
  const val = parseInt(argv[idx + 1], 10);
  return isNaN(val) ? defaultVal : val;
}

const days = getFlag('--days', 1);
const topN = getFlag('--top', 20);

// ── Collect files ─────────────────────────────────────────────────────────────

function isoDate(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() - offsetDays);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

const targetDates = Array.from({ length: days }, (_, i) => isoDate(i));

interface Entry {
  ts: string;
  tool: string;
  bytes: number;
}

interface Aggregate {
  calls: number;
  totalBytes: number;
}

const agg = new Map<string, Aggregate>();
let totalLines = 0;
let totalBytes = 0;

for (const date of targetDates) {
  const file = path.join(STATS_DIR, `${date}.jsonl`);
  if (!fs.existsSync(file)) continue;

  const raw = fs.readFileSync(file, 'utf8');
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as Entry;
      const existing = agg.get(entry.tool) ?? { calls: 0, totalBytes: 0 };
      existing.calls += 1;
      existing.totalBytes += entry.bytes;
      agg.set(entry.tool, existing);
      totalLines += 1;
      totalBytes += entry.bytes;
    } catch {
      // Malformed line — skip
    }
  }
}

// ── Render ────────────────────────────────────────────────────────────────────

const period = days === 1 ? `today (${isoDate(0)})` : `last ${days} days`;

console.log(`\nMCP Telemetry Report — ${period}`);
console.log(`Total calls: ${totalLines} | Total bytes: ${fmtBytes(totalBytes)}\n`);

if (agg.size === 0) {
  console.log('No data found. Run the MCP server to start collecting telemetry.');
  process.exit(0);
}

// Sort by totalBytes descending
const sorted = [...agg.entries()].sort((a, b) => b[1].totalBytes - a[1].totalBytes);
const shown = sorted.slice(0, topN);

const colW = [50, 8, 12, 10];
const header = [
  'Tool'.padEnd(colW[0]),
  'Calls'.padStart(colW[1]),
  'Total bytes'.padStart(colW[2]),
  'Avg bytes'.padStart(colW[3]),
];
console.log(header.join('  '));
console.log('-'.repeat(colW[0] + colW[1] + colW[2] + colW[3] + 6));

for (const [tool, { calls, totalBytes: tb }] of shown) {
  const avg = Math.round(tb / calls);
  const row = [
    tool.padEnd(colW[0]),
    String(calls).padStart(colW[1]),
    fmtBytes(tb).padStart(colW[2]),
    fmtBytes(avg).padStart(colW[3]),
  ];
  console.log(row.join('  '));
}

if (sorted.length > topN) {
  console.log(`\n... and ${sorted.length - topN} more tools. Use --top ${sorted.length} to see all.`);
}

console.log();

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
}
