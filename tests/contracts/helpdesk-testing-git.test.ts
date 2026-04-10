/**
 * Contract tests: Helpdesk, Testing, and Git tools
 *
 * Validates that MCP helpdesk/testing/git tool handlers receive the expected
 * response shapes from HAOps API endpoints. Snapshot drift = API change that needs review.
 *
 * Tools covered (~15):
 *   list_tickets, get_ticket, create_ticket (+ cleanup)
 *   list_tests, list_test_runs, get_test_health
 *   manage_repositories
 *   list_merge_requests
 *   list_help_sections, list_help_articles
 *   list_doc_artifacts
 *
 * Requirements: HAOps running at HAOPS_API_URL with valid HAOPS_API_KEY.
 * If unavailable, all tests skip gracefully.
 */

import {
  haopsGet,
  haopsPost,
  haopsDelete,
  validateAndSnapshotShape,
  HAOPS_PROJECT_SLUG,
} from './helpers/contractHelpers.js';
import { checkHaopsAvailability, haopsAvailable } from './helpers/setup.js';

beforeAll(async () => {
  await checkHaopsAvailability();
});

// ── Helpdesk Tickets ──────────────────────────────────────────────────────────

describe('list_tickets — GET /api/projects/[slug]/helpdesk/tickets', () => {
  it('returns 200 with ticket list shape', async () => {
    if (!haopsAvailable) return;
    const { status, body } = await haopsGet(
      `/api/projects/${HAOPS_PROJECT_SLUG}/helpdesk/tickets`
    );
    expect(status).toBe(200);
    validateAndSnapshotShape(body, 'list_tickets response');
  });
});

describe('create_ticket + get_ticket + cleanup', () => {
  let createdTicketId: string | null = null;

  it('POST /api/projects/[slug]/helpdesk/tickets — creates ticket (create_ticket)', async () => {
    if (!haopsAvailable) return;
    const { status, body } = await haopsPost(
      `/api/projects/${HAOPS_PROJECT_SLUG}/helpdesk/tickets`,
      {
        subject: '[CONTRACT-TEST] Ticket',
        description: 'Automated contract test ticket — safe to delete.',
        requesterEmail: 'contract-test@example.com',
        requesterName: 'Contract Test',
        priority: 'low',
        category: 'general',
      }
    );
    expect(status).toBe(201);
    const created = body as { id?: string; ticket?: { id: string } };
    createdTicketId = created.id ?? created.ticket?.id ?? null;
    validateAndSnapshotShape(body, 'create_ticket response');
  });

  it('GET /api/projects/[slug]/helpdesk/tickets/[id] — gets ticket detail (get_ticket)', async () => {
    if (!haopsAvailable || !createdTicketId) return;
    const { status, body } = await haopsGet(
      `/api/projects/${HAOPS_PROJECT_SLUG}/helpdesk/tickets/${createdTicketId}`
    );
    expect(status).toBe(200);
    validateAndSnapshotShape(body, 'get_ticket response');
  });

  it('DELETE /api/projects/[slug]/helpdesk/tickets/[id] — cleans up test ticket', async () => {
    if (!haopsAvailable || !createdTicketId) return;
    const { status } = await haopsDelete(
      `/api/projects/${HAOPS_PROJECT_SLUG}/helpdesk/tickets/${createdTicketId}`
    );
    // 200 or 204 both acceptable
    expect([200, 204]).toContain(status);
    createdTicketId = null;
  });
});

// ── Testing ───────────────────────────────────────────────────────────────────

describe('list_tests — GET /api/projects/[slug]/tests', () => {
  it('returns 200 with test list shape', async () => {
    if (!haopsAvailable) return;
    const { status, body } = await haopsGet(`/api/projects/${HAOPS_PROJECT_SLUG}/tests`);
    expect(status).toBe(200);
    validateAndSnapshotShape(body, 'list_tests response');
  });
});

describe('list_test_runs — GET /api/projects/[slug]/test-runs', () => {
  it('returns 200 with test run list shape', async () => {
    if (!haopsAvailable) return;
    const { status, body } = await haopsGet(
      `/api/projects/${HAOPS_PROJECT_SLUG}/test-runs`
    );
    expect(status).toBe(200);
    validateAndSnapshotShape(body, 'list_test_runs response');
  });
});

describe('get_test_health — GET /api/projects/[slug]/test-health', () => {
  it('returns 200 with test health shape', async () => {
    if (!haopsAvailable) return;
    const { status, body } = await haopsGet(
      `/api/projects/${HAOPS_PROJECT_SLUG}/test-health`
    );
    expect(status).toBe(200);
    validateAndSnapshotShape(body, 'get_test_health response');
  });
});

describe('list_test_suites — GET /api/projects/[slug]/test-suites', () => {
  it('returns 200 with test suite list shape', async () => {
    if (!haopsAvailable) return;
    const { status, body } = await haopsGet(
      `/api/projects/${HAOPS_PROJECT_SLUG}/test-suites`
    );
    expect(status).toBe(200);
    validateAndSnapshotShape(body, 'list_test_suites response');
  });
});

// ── Git & Repositories ────────────────────────────────────────────────────────

describe('manage_repositories — GET /api/projects/[slug]/repositories', () => {
  it('returns 200 with repository list shape', async () => {
    if (!haopsAvailable) return;
    const { status, body } = await haopsGet(
      `/api/projects/${HAOPS_PROJECT_SLUG}/repositories`
    );
    expect(status).toBe(200);
    validateAndSnapshotShape(body, 'manage_repositories response');
  });
});

describe('list_merge_requests — GET /api/projects/[slug]/git/merge-requests', () => {
  it('returns 200 with merge request list shape', async () => {
    if (!haopsAvailable) return;
    const { status, body } = await haopsGet(
      `/api/projects/${HAOPS_PROJECT_SLUG}/git/merge-requests`
    );
    // 404 is OK if no git repo has been initialized for this project
    if (status === 404) {
      console.warn('[Contract Tests] No git repo found — skipping merge-requests shape snapshot');
      return;
    }
    expect(status).toBe(200);
    validateAndSnapshotShape(body, 'list_merge_requests response');
  });
});

describe('manage_git_repos — GET /api/projects/[slug]/git', () => {
  it('returns 200 with git repo list shape', async () => {
    if (!haopsAvailable) return;
    const { status, body } = await haopsGet(`/api/projects/${HAOPS_PROJECT_SLUG}/git`);
    // 404 is OK if no git repo has been initialized
    if (status === 404) {
      console.warn('[Contract Tests] No git repo found — skipping git repo shape snapshot');
      return;
    }
    expect(status).toBe(200);
    validateAndSnapshotShape(body, 'manage_git_repos response');
  });
});

// ── Help Center ───────────────────────────────────────────────────────────────

describe('list_help_sections — GET /api/help/sections', () => {
  it('returns 200 with help section list shape', async () => {
    if (!haopsAvailable) return;
    const { status, body } = await haopsGet('/api/help/sections');
    expect(status).toBe(200);
    validateAndSnapshotShape(body, 'list_help_sections response');
  });
});

describe('list_help_articles — GET /api/help/sections/[slug]/articles', () => {
  it('returns help articles for first section', async () => {
    if (!haopsAvailable) return;
    const { body: sectionsBody } = await haopsGet('/api/help/sections');
    const sections = sectionsBody as Array<{ slug: string }> | { sections?: Array<{ slug: string }> };
    const sectionList = Array.isArray(sections) ? sections : (sections as { sections?: Array<{ slug: string }> }).sections;
    if (!sectionList || sectionList.length === 0) {
      console.warn('[Contract Tests] No help sections found — skipping articles shape snapshot');
      return;
    }
    const sectionSlug = sectionList[0].slug;
    const { status, body } = await haopsGet(`/api/help/sections/${sectionSlug}/articles`);
    expect(status).toBe(200);
    validateAndSnapshotShape(body, 'list_help_articles response');
  });
});

// ── Documentation Builder ─────────────────────────────────────────────────────

describe('list_doc_artifacts — GET /api/projects/[slug]/docs', () => {
  it('returns 200 with doc artifact list shape', async () => {
    if (!haopsAvailable) return;
    const { status, body } = await haopsGet(`/api/projects/${HAOPS_PROJECT_SLUG}/docs`);
    expect(status).toBe(200);
    validateAndSnapshotShape(body, 'list_doc_artifacts response');
  });
});

describe('list_doc_sections — GET /api/projects/[slug]/docs/[slug]/sections', () => {
  it('returns doc sections for first artifact', async () => {
    if (!haopsAvailable) return;
    const { body: docsBody } = await haopsGet(`/api/projects/${HAOPS_PROJECT_SLUG}/docs`);
    const artifacts = docsBody as Array<{ slug: string }> | { artifacts?: Array<{ slug: string }> };
    const artifactList = Array.isArray(artifacts) ? artifacts : (artifacts as { artifacts?: Array<{ slug: string }> }).artifacts;
    if (!artifactList || artifactList.length === 0) {
      console.warn('[Contract Tests] No doc artifacts found — skipping sections shape snapshot');
      return;
    }
    const artifactSlug = artifactList[0].slug;
    const { status, body } = await haopsGet(
      `/api/projects/${HAOPS_PROJECT_SLUG}/docs/${artifactSlug}/sections`
    );
    expect(status).toBe(200);
    validateAndSnapshotShape(body, 'list_doc_sections response');
  });
});
