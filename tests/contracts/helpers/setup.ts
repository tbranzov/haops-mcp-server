/**
 * Global setup for HAOps MCP contract tests.
 *
 * Checks HAOps availability before running any tests.
 * If HAOps is unreachable or HAOPS_API_KEY is missing, all tests are skipped.
 *
 * Usage: imported at the top of each contract test file via:
 *   import { skipIfUnavailable } from './helpers/setup';
 *   beforeAll(skipIfUnavailable);
 */

import { HAOPS_API_URL, HAOPS_API_KEY } from './contractHelpers.js';

export let haopsAvailable = false;

/**
 * Check HAOps availability. Call in beforeAll() of each test file.
 * Sets haopsAvailable = true if server is reachable and API key is provided.
 */
export async function checkHaopsAvailability(): Promise<void> {
  if (!HAOPS_API_KEY) {
    console.warn(
      '\n[Contract Tests] HAOPS_API_KEY not set — all contract tests will be skipped.\n' +
        'Set HAOPS_API_KEY=your-key to run contract tests.\n'
    );
    haopsAvailable = false;
    return;
  }

  try {
    const res = await fetch(`${HAOPS_API_URL}/api/projects`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${HAOPS_API_KEY}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(5000),
    });

    if (res.status === 401) {
      console.warn(
        `\n[Contract Tests] HAOps returned 401 — API key may be invalid.\n` +
          `URL: ${HAOPS_API_URL}\n` +
          'All contract tests will be skipped.\n'
      );
      haopsAvailable = false;
    } else {
      haopsAvailable = true;
    }
  } catch {
    console.warn(
      `\n[Contract Tests] HAOps not reachable at ${HAOPS_API_URL} — all tests will be skipped.\n` +
        'Start HAOps (npm run dev) and set HAOPS_API_URL + HAOPS_API_KEY to run contract tests.\n'
    );
    haopsAvailable = false;
  }
}

/**
 * Helper to skip a single test if HAOps is unavailable.
 * Use inside each test: if (!haopsAvailable) return;
 */
export function skipIfUnavailable(): boolean {
  return !haopsAvailable;
}
