/**
 * Contract tests: Work Hierarchy tools
 *
 * Validates that MCP work hierarchy tool handlers receive the expected response
 * shapes from HAOps API endpoints. Snapshot drift = API change that needs review.
 *
 * Tools covered (~15):
 *   list_modules, get_module, create_module, update_module, delete_module
 *   list_features, get_feature, create_feature, delete_feature
 *   list_issues, get_issue, create_issue, delete_issue
 *   get_project_tree, get_structured_view
 *
 * Requirements: HAOps running at HAOPS_API_URL with valid HAOPS_API_KEY.
 * If unavailable, all tests skip gracefully.
 */

import {
  haopsGet,
  haopsPost,
  haopsPut,
  haopsDelete,
  validateAndSnapshotShape,
  HAOPS_PROJECT_SLUG,
} from './helpers/contractHelpers.js';
import { checkHaopsAvailability, haopsAvailable } from './helpers/setup.js';

beforeAll(async () => {
  await checkHaopsAvailability();
});

// ── Modules ───────────────────────────────────────────────────────────────────

describe('list_modules — GET /api/projects/[slug]/modules', () => {
  it('returns 200 with module list shape', async () => {
    if (!haopsAvailable) return;
    const { status, body } = await haopsGet(`/api/projects/${HAOPS_PROJECT_SLUG}/modules`);
    expect(status).toBe(200);
    validateAndSnapshotShape(body, 'list_modules response');
  });
});

describe('get_module — GET /api/modules/[id]', () => {
  let moduleId: string | null = null;

  beforeAll(async () => {
    if (!haopsAvailable) return;
    // Get any module from the project
    const { body } = await haopsGet(`/api/projects/${HAOPS_PROJECT_SLUG}/modules`);
    const list = body as { modules?: Array<{ id: string }> } | Array<{ id: string }>;
    const modules = Array.isArray(list) ? list : (list as { modules?: Array<{ id: string }> }).modules;
    if (modules && modules.length > 0) {
      moduleId = modules[0].id;
    }
  });

  it('returns 200 with module detail shape', async () => {
    if (!haopsAvailable || !moduleId) return;
    const { status, body } = await haopsGet(`/api/modules/${moduleId}`);
    expect(status).toBe(200);
    validateAndSnapshotShape(body, 'get_module response');
  });
});

describe('create_module + update_module + delete_module', () => {
  let createdModuleId: string | null = null;

  it('POST /api/modules — creates module (create_module)', async () => {
    if (!haopsAvailable) return;
    // Need projectId; get it from project info
    const { body: projectBody } = await haopsGet(`/api/projects/${HAOPS_PROJECT_SLUG}`);
    const project = projectBody as { id?: string };
    if (!project.id) return;

    const { status, body } = await haopsPost('/api/modules', {
      title: '[CONTRACT-TEST] Module',
      projectId: project.id,
      status: 'backlog',
      priority: 'low',
    });
    expect(status).toBe(201);
    const created = body as { id?: string };
    createdModuleId = created.id ?? null;
    validateAndSnapshotShape(body, 'create_module response');
  });

  it('PUT /api/modules/[id] — updates module (update_module)', async () => {
    if (!haopsAvailable || !createdModuleId) return;
    const { status, body } = await haopsPut(`/api/modules/${createdModuleId}`, {
      title: '[CONTRACT-TEST] Module Updated',
    });
    expect(status).toBe(200);
    validateAndSnapshotShape(body, 'update_module response');
  });

  it('DELETE /api/modules/[id] — deletes module (delete_module)', async () => {
    if (!haopsAvailable || !createdModuleId) return;
    const { status } = await haopsDelete(`/api/modules/${createdModuleId}`);
    expect(status).toBe(200);
    createdModuleId = null;
  });
});

// ── Features ──────────────────────────────────────────────────────────────────

describe('list_features — GET /api/projects/[slug]/features', () => {
  it('returns 200 with feature list shape', async () => {
    if (!haopsAvailable) return;
    const { status, body } = await haopsGet(`/api/projects/${HAOPS_PROJECT_SLUG}/features`);
    expect(status).toBe(200);
    validateAndSnapshotShape(body, 'list_features response');
  });
});

describe('get_feature — GET /api/features/[id]', () => {
  let featureId: string | null = null;

  beforeAll(async () => {
    if (!haopsAvailable) return;
    const { body } = await haopsGet(`/api/projects/${HAOPS_PROJECT_SLUG}/features`);
    const list = body as { features?: Array<{ id: string }> } | Array<{ id: string }>;
    const features = Array.isArray(list) ? list : (list as { features?: Array<{ id: string }> }).features;
    if (features && features.length > 0) {
      featureId = features[0].id;
    }
  });

  it('returns 200 with feature detail shape', async () => {
    if (!haopsAvailable || !featureId) return;
    const { status, body } = await haopsGet(`/api/features/${featureId}`);
    expect(status).toBe(200);
    validateAndSnapshotShape(body, 'get_feature response');
  });
});

describe('create_feature + delete_feature', () => {
  let createdFeatureId: string | null = null;
  let existingModuleId: string | null = null;

  beforeAll(async () => {
    if (!haopsAvailable) return;
    const { body } = await haopsGet(`/api/projects/${HAOPS_PROJECT_SLUG}/modules`);
    const list = body as { modules?: Array<{ id: string }> } | Array<{ id: string }>;
    const modules = Array.isArray(list) ? list : (list as { modules?: Array<{ id: string }> }).modules;
    if (modules && modules.length > 0) {
      existingModuleId = modules[0].id;
    }
  });

  it('POST /api/features — creates feature (create_feature)', async () => {
    if (!haopsAvailable || !existingModuleId) return;
    const { status, body } = await haopsPost('/api/features', {
      title: '[CONTRACT-TEST] Feature',
      moduleId: existingModuleId,
      status: 'backlog',
      priority: 'low',
    });
    expect(status).toBe(201);
    const created = body as { id?: string };
    createdFeatureId = created.id ?? null;
    validateAndSnapshotShape(body, 'create_feature response');
  });

  it('DELETE /api/features/[id] — deletes feature (delete_feature)', async () => {
    if (!haopsAvailable || !createdFeatureId) return;
    const { status } = await haopsDelete(`/api/features/${createdFeatureId}`);
    expect(status).toBe(200);
    createdFeatureId = null;
  });
});

// ── Issues ────────────────────────────────────────────────────────────────────

describe('list_issues — GET /api/projects/[slug]/issues', () => {
  it('returns 200 with issue list shape', async () => {
    if (!haopsAvailable) return;
    const { status, body } = await haopsGet(`/api/projects/${HAOPS_PROJECT_SLUG}/issues`);
    expect(status).toBe(200);
    validateAndSnapshotShape(body, 'list_issues response');
  });
});

describe('get_issue — GET /api/issues/[id]', () => {
  let issueId: string | null = null;

  beforeAll(async () => {
    if (!haopsAvailable) return;
    const { body } = await haopsGet(`/api/projects/${HAOPS_PROJECT_SLUG}/issues`);
    const list = body as { issues?: Array<{ id: string }> } | Array<{ id: string }>;
    const issues = Array.isArray(list) ? list : (list as { issues?: Array<{ id: string }> }).issues;
    if (issues && issues.length > 0) {
      issueId = issues[0].id;
    }
  });

  it('returns 200 with issue detail shape', async () => {
    if (!haopsAvailable || !issueId) return;
    const { status, body } = await haopsGet(`/api/issues/${issueId}`);
    expect(status).toBe(200);
    validateAndSnapshotShape(body, 'get_issue response');
  });
});

describe('create_issue + delete_issue', () => {
  let createdIssueId: string | null = null;
  let existingFeatureId: string | null = null;

  beforeAll(async () => {
    if (!haopsAvailable) return;
    const { body } = await haopsGet(`/api/projects/${HAOPS_PROJECT_SLUG}/features`);
    const list = body as { features?: Array<{ id: string }> } | Array<{ id: string }>;
    const features = Array.isArray(list) ? list : (list as { features?: Array<{ id: string }> }).features;
    if (features && features.length > 0) {
      existingFeatureId = features[0].id;
    }
  });

  it('POST /api/issues — creates issue (create_issue)', async () => {
    if (!haopsAvailable || !existingFeatureId) return;
    const { status, body } = await haopsPost('/api/issues', {
      title: '[CONTRACT-TEST] Issue',
      featureId: existingFeatureId,
      type: 'task',
      status: 'backlog',
      priority: 'low',
    });
    expect(status).toBe(201);
    const created = body as { id?: string };
    createdIssueId = created.id ?? null;
    validateAndSnapshotShape(body, 'create_issue response');
  });

  it('DELETE /api/issues/[id] — deletes issue (delete_issue)', async () => {
    if (!haopsAvailable || !createdIssueId) return;
    const { status } = await haopsDelete(`/api/issues/${createdIssueId}`);
    expect(status).toBe(200);
    createdIssueId = null;
  });
});

// ── Project views ─────────────────────────────────────────────────────────────

describe('get_project_tree — GET /api/projects/[slug]/tree', () => {
  it('returns 200 with project tree shape', async () => {
    if (!haopsAvailable) return;
    const { status, body } = await haopsGet(`/api/projects/${HAOPS_PROJECT_SLUG}/tree`);
    expect(status).toBe(200);
    validateAndSnapshotShape(body, 'get_project_tree response');
  });
});

describe('get_structured_view — GET /api/projects/[slug]/teamwork/structured', () => {
  it('returns 200 with structured view shape', async () => {
    if (!haopsAvailable) return;
    const { status, body } = await haopsGet(`/api/projects/${HAOPS_PROJECT_SLUG}/teamwork/structured`);
    expect(status).toBe(200);
    validateAndSnapshotShape(body, 'get_structured_view response');
  });
});

