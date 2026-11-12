/**
 * Builds the text an agent sees for a failed API call.
 *
 * The HAOps API answers 4xx with `{ error, message?, violations?, warnings? }`.
 * Reading only `error` hid the part that tells the caller how to fix the request
 * (for example the element id of a diagram contract violation), so the extra
 * fields are appended here, capped so one noisy body cannot flood the context.
 */

export const ERROR_DETAIL_MAX_CHARS = 1200;
export const ERROR_DETAIL_MAX_ITEMS = 10;

export interface ApiErrorBody {
  error?: unknown;
  message?: unknown;
  violations?: unknown;
  warnings?: unknown;
}

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…(truncated)` : text;
}

function itemToText(item: unknown): string {
  if (typeof item === 'string') return item;
  try {
    return JSON.stringify(item) ?? String(item);
  } catch {
    return String(item);
  }
}

function listToText(label: string, value: unknown): string | null {
  if (value == null) return null;
  const items = Array.isArray(value) ? value : [value];
  if (items.length === 0) return null;
  const shown = items.slice(0, ERROR_DETAIL_MAX_ITEMS).map(itemToText);
  const more = items.length > shown.length ? ` (+${items.length - shown.length} more)` : '';
  return `${label}: ${shown.join('; ')}${more}`;
}

export function buildErrorMessage(data: unknown, fallback: string): string {
  if (!data || typeof data !== 'object') return fallback;
  const body = data as ApiErrorBody;

  const head = typeof body.error === 'string' && body.error ? body.error : fallback;

  const detail: string[] = [];
  if (typeof body.message === 'string' && body.message && body.message !== head) {
    detail.push(body.message);
  }
  const violations = listToText('Violations', body.violations);
  if (violations) detail.push(violations);
  const warnings = listToText('Warnings', body.warnings);
  if (warnings) detail.push(warnings);

  if (detail.length === 0) return head;
  return `${head} — ${cap(detail.join(' | '), ERROR_DETAIL_MAX_CHARS)}`;
}
