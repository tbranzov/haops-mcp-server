/**
 * Contract test helpers for HAOps MCP Server.
 *
 * Provides HTTP helpers (haopsGet, haopsPost, haopsPut, haopsDelete) with API key auth,
 * and shape validation utilities (extractShape, validateAndSnapshotShape) for detecting
 * API response drift.
 *
 * Environment variables:
 *   HAOPS_API_URL    — base URL (default: http://localhost:3000)
 *   HAOPS_API_KEY    — required; tests skip if missing
 *   HAOPS_PROJECT_SLUG — project slug for project-scoped endpoints (default: fdev)
 */

export const HAOPS_API_URL = process.env.HAOPS_API_URL ?? 'http://localhost:3000';
export const HAOPS_API_KEY = process.env.HAOPS_API_KEY ?? '';
export const HAOPS_PROJECT_SLUG = process.env.HAOPS_PROJECT_SLUG ?? 'fdev';

// ── HTTP Helpers ───────────────────────────────────────────────────────────────

function buildHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${HAOPS_API_KEY}`,
  };
}

export async function haopsGet(path: string): Promise<{ status: number; body: unknown }> {
  const url = `${HAOPS_API_URL}${path}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: buildHeaders(),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

export async function haopsPost(path: string, data: unknown): Promise<{ status: number; body: unknown }> {
  const url = `${HAOPS_API_URL}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(),
    body: JSON.stringify(data),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

export async function haopsPut(path: string, data: unknown): Promise<{ status: number; body: unknown }> {
  const url = `${HAOPS_API_URL}${path}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: buildHeaders(),
    body: JSON.stringify(data),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

export async function haopsDelete(path: string): Promise<{ status: number; body: unknown }> {
  const url = `${HAOPS_API_URL}${path}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: buildHeaders(),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

// ── Shape Extraction ───────────────────────────────────────────────────────────

type ShapeValue = string | ShapeObject | ShapeObject[];
interface ShapeObject {
  [key: string]: ShapeValue;
}

/**
 * Recursively extract field names and typeof values from an object.
 * Arrays are represented as 'array' (or an array with one shape element if items are objects).
 *
 * Example:
 *   extractShape({ id: 'abc', title: 'foo', issues: [] })
 *   → { id: 'string', title: 'string', issues: 'array' }
 */
export function extractShape(obj: unknown): ShapeObject | string {
  if (obj === null) return 'null';
  if (Array.isArray(obj)) {
    if (obj.length === 0) return 'array';
    const firstItem = obj[0];
    if (typeof firstItem === 'object' && firstItem !== null) {
      return [extractShape(firstItem)] as unknown as ShapeObject;
    }
    return 'array';
  }
  if (typeof obj === 'object') {
    const shape: ShapeObject = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (value === null) {
        shape[key] = 'null';
      } else if (Array.isArray(value)) {
        if (value.length === 0) {
          shape[key] = 'array';
        } else if (typeof value[0] === 'object' && value[0] !== null) {
          shape[key] = [extractShape(value[0])] as unknown as ShapeObject;
        } else {
          shape[key] = 'array';
        }
      } else if (typeof value === 'object') {
        shape[key] = extractShape(value) as ShapeObject;
      } else {
        shape[key] = typeof value;
      }
    }
    return shape;
  }
  return typeof obj;
}

/**
 * Extract response shape and match against Jest snapshot.
 * Call inside a test with expect(...).toMatchSnapshot().
 *
 * @param data   — The response body (or a sub-object) to snapshot.
 * @param label  — Human-readable label for the snapshot (not used as snapshot name; Jest uses test name).
 */
export function validateAndSnapshotShape(data: unknown, label: string): void {
  const shape = extractShape(data);
  expect({ label, shape }).toMatchSnapshot();
}
