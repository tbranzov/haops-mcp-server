/**
 * Diagram lint surface: haops_lint_diagram plus the compact `warnings` block shown after diagram writes.
 *
 * The app lints API-key diagram writes and returns `warnings` (severity crash | high | medium | low).
 * Crash-severity findings first; a capped list so a bad diagram cannot flood the agent's context.
 */
import { HAOpsApiError } from './api/client.js';

export interface RequestClient {
  request(method: 'GET', url: string): Promise<unknown>;
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface DiagramWarning {
  code: string;
  severity: string;
  elementType?: string;
  elementId?: string | null;
  fix?: string;
  message?: string;
}

const SEVERITY_ORDER = ['crash', 'high', 'medium', 'low'];
/** Findings listed per response; the rest are counted. */
export const MAX_SHOWN = 20;

const rank = (s: string) => {
  const i = SEVERITY_ORDER.indexOf(s);
  return i === -1 ? SEVERITY_ORDER.length : i;
};

/** Compact grouped block, crash first. Empty string when there is nothing to show. */
export function formatDiagramWarnings(warnings: unknown, total?: number, max: number = MAX_SHOWN): string {
  if (!Array.isArray(warnings) || warnings.length === 0) return '';
  const all = (warnings as DiagramWarning[]).filter((w) => w && typeof w === 'object');
  const sorted = [...all].sort((a, b) => rank(a.severity) - rank(b.severity));
  const shown = sorted.slice(0, max);
  const count = Math.max(total ?? 0, all.length);
  const lines: string[] = [];
  let current = '';
  for (const w of shown) {
    if (w.severity !== current) {
      current = w.severity;
      const n = sorted.filter((x) => x.severity === current).length;
      lines.push(`${String(current).toUpperCase()} (${n}):`);
    }
    const where = w.elementId ? ` ${w.elementType ?? 'element'} ${w.elementId}` : w.elementType ? ` ${w.elementType}` : '';
    lines.push(`- ${w.code}${where}${w.fix ? ` — fix: ${w.fix}` : w.message ? ` — ${w.message}` : ''}`);
  }
  const hidden = count - shown.length;
  const head = `Lint warnings (${count}): fix these, the human cannot see or repair them as written. Check with haops_lint_diagram.`;
  return [head, ...lines, ...(hidden > 0 ? [`(+${hidden} more not shown; run haops_lint_diagram)`] : [])].join('\n');
}

/** Splits `warnings`/`warningsTotal` off a PATCH response so they are shown once, as the block. */
export function splitWriteWarnings(result: unknown): { rest: unknown; block: string } {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return { rest: result, block: '' };
  const { warnings, warningsTotal, ...rest } = result as Record<string, unknown>;
  return { rest, block: formatDiagramWarnings(warnings, typeof warningsTotal === 'number' ? warningsTotal : undefined) };
}

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

function isRouteMissing(error: unknown): boolean {
  if (!(error instanceof HAOpsApiError) || error.statusCode !== 404) return false;
  const body = error.response as { error?: unknown } | undefined;
  return !(body && typeof body === 'object' && typeof body.error === 'string');
}

interface LintBody {
  diagramId: string;
  diagramType: string;
  contentHash?: string;
  total: number;
  truncated?: boolean;
  byCode?: Record<string, number>;
  warnings: DiagramWarning[];
}

export async function lintDiagramTool(
  client: RequestClient,
  args: { projectSlug: string; diagramId: string },
): Promise<ToolResult> {
  try {
    const r = (await client.request(
      'GET',
      `/api/projects/${encodeURIComponent(args.projectSlug)}/diagrams/${encodeURIComponent(args.diagramId)}/lint`,
    )) as LintBody;
    if (!r.total) return ok(`Diagram ${r.diagramId} (${r.diagramType}): no lint findings.`);
    const byCode = Object.entries(r.byCode ?? {}).map(([c, n]) => `${c}×${n}`).join(', ');
    const block = formatDiagramWarnings(r.warnings, r.total);
    return ok([
      `Diagram ${r.diagramId} (${r.diagramType}) hash ${r.contentHash ?? '?'}: ${r.total} finding(s)${byCode ? ` — ${byCode}` : ''}`,
      block,
    ].join('\n'));
  } catch (error) {
    if (isRouteMissing(error)) return fail("Error: this HAOps server doesn't have haops_lint_diagram (the diagram lint route) yet. Nothing was changed.");
    return fail(`Error linting diagram: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}
