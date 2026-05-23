/**
 * Contract tests: Protocol resolver tools (F4-I7)
 *
 * Validates the shape contract of GET /api/projects/[slug]/protocol across
 * the three F4 modes:
 *   - legacy (templateId IS NULL)      → byte-identical to pre-F4 response
 *   - composed-lazy (default)          → coreContent + skillRefs, body=''
 *   - composed-bundle (?bundle=true)   → full body + skillRefs
 *
 * AND the `?version=N` historical lookup (unchanged DB shape).
 *
 * The MCP `haops_read_protocol` tool calls these endpoints via `readProtocol`
 * in src/api/client.ts; any drift in response shape here will break the MCP
 * tool. Snapshot drift = API change that needs review.
 *
 * Requirements: HAOps running at HAOPS_API_URL with valid HAOPS_API_KEY +
 * ENABLE_COMPOSED_PROTOCOLS=true. If HAOps is unreachable or composed
 * protocols are disabled, the composed-mode tests skip gracefully.
 */

import {
  haopsGet,
  validateAndSnapshotShape,
  HAOPS_PROJECT_SLUG,
} from './helpers/contractHelpers.js';
import { checkHaopsAvailability, haopsAvailable } from './helpers/setup.js';

beforeAll(async () => {
  await checkHaopsAvailability();
});

// ---------------------------------------------------------------------------
// Role list (no role param) — unchanged contract
// ---------------------------------------------------------------------------

describe('list_protocols — GET /api/projects/[slug]/protocol (no role)', () => {
  it('returns 200 with protocol list shape', async () => {
    if (!haopsAvailable) return;
    const { status, body } = await haopsGet(`/api/projects/${HAOPS_PROJECT_SLUG}/protocol`);
    expect(status).toBe(200);
    validateAndSnapshotShape(body, 'list_protocols response');
  });
});

// ---------------------------------------------------------------------------
// Lazy default for current role row
// ---------------------------------------------------------------------------

describe('read_protocol lazy — GET /api/projects/[slug]/protocol?role=dev', () => {
  it('returns 200 with mode discriminator', async () => {
    if (!haopsAvailable) return;
    const { status, body } = await haopsGet(`/api/projects/${HAOPS_PROJECT_SLUG}/protocol?role=dev`);
    if (status === 404) {
      // No dev protocol seeded for this project — skip the shape assertion
      // but record a snapshot for the 404 body so drift is still caught.
      validateAndSnapshotShape({ status, body }, 'read_protocol lazy 404');
      return;
    }
    expect(status).toBe(200);
    // The response MUST carry a `mode` discriminator OR be a legacy raw row
    // (which has `content` + `version` but no `mode`). Snapshot whichever
    // shape comes back so drift in either branch is caught.
    validateAndSnapshotShape(body, 'read_protocol lazy response');
  });
});

// ---------------------------------------------------------------------------
// Bundle mode for current role row
// ---------------------------------------------------------------------------

describe('read_protocol bundle — GET /api/projects/[slug]/protocol?role=dev&bundle=true', () => {
  it('returns 200 with composed-bundle shape', async () => {
    if (!haopsAvailable) return;
    const { status, body } = await haopsGet(
      `/api/projects/${HAOPS_PROJECT_SLUG}/protocol?role=dev&bundle=true`
    );
    if (status === 404) {
      validateAndSnapshotShape({ status, body }, 'read_protocol bundle 404');
      return;
    }
    expect(status).toBe(200);
    validateAndSnapshotShape(body, 'read_protocol bundle response');
  });
});

// ---------------------------------------------------------------------------
// Historical version lookup — raw DB shape (unchanged F4 contract)
// ---------------------------------------------------------------------------

describe('read_protocol version=N — GET /api/projects/[slug]/protocol?role=dev&version=1', () => {
  it('returns 200 with raw DB row shape OR 404', async () => {
    if (!haopsAvailable) return;
    const { status, body } = await haopsGet(
      `/api/projects/${HAOPS_PROJECT_SLUG}/protocol?role=dev&version=1`
    );
    // Either the row exists (200 + raw DB shape) or it doesn't (404). Both
    // shapes are captured so drift in either branch is caught.
    if (status === 200) {
      validateAndSnapshotShape(body, 'read_protocol version=1 raw shape');
    } else {
      expect(status).toBe(404);
      validateAndSnapshotShape({ status, body }, 'read_protocol version=1 404');
    }
  });
});

// ---------------------------------------------------------------------------
// Preview endpoint — bundle alias (F4-I2)
// ---------------------------------------------------------------------------

describe('preview — GET /api/projects/[slug]/protocol/preview?role=dev', () => {
  it('returns 200 with composed-bundle + F3 compat shape OR 404', async () => {
    if (!haopsAvailable) return;
    const { status, body } = await haopsGet(
      `/api/projects/${HAOPS_PROJECT_SLUG}/protocol/preview?role=dev`
    );
    if (status === 404) {
      validateAndSnapshotShape({ status, body }, 'preview 404');
      return;
    }
    // 422 = flag OFF or composed disabled — snapshot the error shape
    if (status === 422) {
      validateAndSnapshotShape({ status, body }, 'preview 422 flag off');
      return;
    }
    expect(status).toBe(200);
    validateAndSnapshotShape(body, 'preview response shape');
  });
});
