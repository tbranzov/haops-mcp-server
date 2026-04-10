/**
 * Contract tests: Communication and Agent tools
 *
 * Validates that MCP communication and agent tool handlers receive the expected
 * response shapes from HAOps API endpoints. Snapshot drift = API change that needs review.
 *
 * Tools covered (~20):
 *   list_channels, create_channel, delete_channel
 *   list_discussions, create_discussion, delete_discussion
 *   list_dm_conversations
 *   list_notifications, mark_notification_read
 *   list_members
 *   read_memory, append_memory
 *   read_protocol
 *   get_activity
 *   get_audit_log
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

// ── Channels ──────────────────────────────────────────────────────────────────

describe('list_channels — GET /api/projects/[slug]/channels', () => {
  it('returns 200 with channel list shape', async () => {
    if (!haopsAvailable) return;
    const { status, body } = await haopsGet(`/api/projects/${HAOPS_PROJECT_SLUG}/channels`);
    expect(status).toBe(200);
    validateAndSnapshotShape(body, 'list_channels response');
  });
});

describe('create_channel + delete_channel', () => {
  let createdChannelId: string | null = null;

  it('POST /api/projects/[slug]/channels — creates channel (create_channel)', async () => {
    if (!haopsAvailable) return;
    const { status, body } = await haopsPost(`/api/projects/${HAOPS_PROJECT_SLUG}/channels`, {
      name: 'contract-test-channel',
      description: 'Temp channel for contract tests',
      isPrivate: false,
    });
    expect(status).toBe(201);
    const created = body as { id?: string; channel?: { id: string } };
    createdChannelId = created.id ?? created.channel?.id ?? null;
    validateAndSnapshotShape(body, 'create_channel response');
  });

  it('DELETE /api/projects/[slug]/channels/[id] — deletes channel (delete_channel)', async () => {
    if (!haopsAvailable || !createdChannelId) return;
    const { status } = await haopsDelete(
      `/api/projects/${HAOPS_PROJECT_SLUG}/channels/${createdChannelId}`
    );
    expect(status).toBe(200);
    createdChannelId = null;
  });
});

// ── Discussions ───────────────────────────────────────────────────────────────

describe('list_discussions — GET /api/projects/[slug]/discussions', () => {
  it('returns 200 with discussion list shape', async () => {
    if (!haopsAvailable) return;
    const { status, body } = await haopsGet(`/api/projects/${HAOPS_PROJECT_SLUG}/discussions`);
    expect(status).toBe(200);
    validateAndSnapshotShape(body, 'list_discussions response');
  });
});

describe('create_discussion + delete_discussion', () => {
  let createdDiscussionId: string | null = null;
  let channelId: string | null = null;

  beforeAll(async () => {
    if (!haopsAvailable) return;
    const { body } = await haopsGet(`/api/projects/${HAOPS_PROJECT_SLUG}/channels`);
    const list = body as Array<{ id: string }> | { channels?: Array<{ id: string }> };
    const channels = Array.isArray(list) ? list : (list as { channels?: Array<{ id: string }> }).channels;
    if (channels && channels.length > 0) {
      channelId = channels[0].id;
    }
  });

  it('POST /api/projects/[slug]/discussions — creates discussion (create_discussion)', async () => {
    if (!haopsAvailable || !channelId) return;
    const { status, body } = await haopsPost(`/api/projects/${HAOPS_PROJECT_SLUG}/discussions`, {
      title: '[CONTRACT-TEST] Discussion',
      type: 'general',
      channelId,
    });
    expect(status).toBe(201);
    const created = body as { id?: string; discussion?: { id: string } };
    createdDiscussionId = created.id ?? created.discussion?.id ?? null;
    validateAndSnapshotShape(body, 'create_discussion response');
  });

  it('DELETE /api/projects/[slug]/discussions/[id] — deletes discussion (delete_discussion)', async () => {
    if (!haopsAvailable || !createdDiscussionId) return;
    const { status } = await haopsDelete(
      `/api/projects/${HAOPS_PROJECT_SLUG}/discussions/${createdDiscussionId}`
    );
    expect(status).toBe(200);
    createdDiscussionId = null;
  });
});

// ── Direct Messages ───────────────────────────────────────────────────────────

describe('list_dm_conversations — GET /api/projects/[slug]/dm/conversations', () => {
  it('returns 200 with DM conversation list shape', async () => {
    if (!haopsAvailable) return;
    const { status, body } = await haopsGet(
      `/api/projects/${HAOPS_PROJECT_SLUG}/dm/conversations`
    );
    expect(status).toBe(200);
    validateAndSnapshotShape(body, 'list_dm_conversations response');
  });
});

// ── Notifications ─────────────────────────────────────────────────────────────

describe('list_notifications — GET /api/notifications', () => {
  it('returns 200 with notification list shape', async () => {
    if (!haopsAvailable) return;
    const { status, body } = await haopsGet('/api/notifications');
    expect(status).toBe(200);
    validateAndSnapshotShape(body, 'list_notifications response');
  });
});

// ── Team Members ──────────────────────────────────────────────────────────────

describe('list_members — GET /api/projects/[slug]/members', () => {
  it('returns 200 with member list shape', async () => {
    if (!haopsAvailable) return;
    const { status, body } = await haopsGet(`/api/projects/${HAOPS_PROJECT_SLUG}/members`);
    expect(status).toBe(200);
    validateAndSnapshotShape(body, 'list_members response');
  });
});

// ── Agent Memory ──────────────────────────────────────────────────────────────

describe('read_memory — GET /api/projects/[slug]/memory/project/self', () => {
  it('returns 200 with memory shape', async () => {
    if (!haopsAvailable) return;
    // Get project ID first
    const { body: projectBody } = await haopsGet(`/api/projects/${HAOPS_PROJECT_SLUG}`);
    const project = projectBody as { id?: string };
    if (!project.id) return;

    const { status, body } = await haopsGet(
      `/api/projects/${HAOPS_PROJECT_SLUG}/memory/project/${project.id}`
    );
    expect(status).toBe(200);
    validateAndSnapshotShape(body, 'read_memory response');
  });
});

describe('append_memory — POST /api/projects/[slug]/memory/project/self', () => {
  it('returns 200 after appending memory entry', async () => {
    if (!haopsAvailable) return;
    const { body: projectBody } = await haopsGet(`/api/projects/${HAOPS_PROJECT_SLUG}`);
    const project = projectBody as { id?: string };
    if (!project.id) return;

    const { status, body } = await haopsPost(
      `/api/projects/${HAOPS_PROJECT_SLUG}/memory/project/${project.id}`,
      {
        tag: 'context',
        content: '[CONTRACT-TEST] Memory append test — safe to ignore.',
      }
    );
    expect(status).toBe(200);
    validateAndSnapshotShape(body, 'append_memory response');
  });
});

// ── Work Protocol ─────────────────────────────────────────────────────────────

describe('read_protocol — GET /api/projects/[slug]/protocol', () => {
  it('returns 200 with protocol shape', async () => {
    if (!haopsAvailable) return;
    const { status, body } = await haopsGet(`/api/projects/${HAOPS_PROJECT_SLUG}/protocol`);
    // 404 is OK if no protocol has been created yet
    if (status === 404) return;
    expect(status).toBe(200);
    validateAndSnapshotShape(body, 'read_protocol response');
  });
});

// ── Activity ──────────────────────────────────────────────────────────────────

describe('get_activity — GET /api/projects/[slug]/activity', () => {
  it('returns 200 with activity feed shape', async () => {
    if (!haopsAvailable) return;
    const { status, body } = await haopsGet(`/api/projects/${HAOPS_PROJECT_SLUG}/activity`);
    expect(status).toBe(200);
    validateAndSnapshotShape(body, 'get_activity response');
  });
});

// ── Audit Log ─────────────────────────────────────────────────────────────────

describe('get_audit_log — GET /api/admin/audit', () => {
  it('returns 200 with audit log shape', async () => {
    if (!haopsAvailable) return;
    const { status, body } = await haopsGet('/api/admin/audit?limit=5');
    // 403 is OK if API key is project-scoped, not global admin
    if (status === 403) {
      console.warn('[Contract Tests] audit endpoint requires admin — skipping shape snapshot');
      return;
    }
    expect(status).toBe(200);
    validateAndSnapshotShape(body, 'get_audit_log response');
  });
});

// ── Search ────────────────────────────────────────────────────────────────────

describe('search_discussion — GET /api/projects/[slug]/discussions/[id]/search', () => {
  it('returns 200 with search result shape', async () => {
    if (!haopsAvailable) return;
    const { body: discBody } = await haopsGet(`/api/projects/${HAOPS_PROJECT_SLUG}/discussions`);
    const list = discBody as Array<{ id: string }> | { discussions?: Array<{ id: string }> };
    const discussions = Array.isArray(list) ? list : (list as { discussions?: Array<{ id: string }> }).discussions;
    if (!discussions || discussions.length === 0) return;

    const discussionId = discussions[0].id;
    const { status, body } = await haopsGet(
      `/api/projects/${HAOPS_PROJECT_SLUG}/discussions/${discussionId}/search?q=test`
    );
    expect(status).toBe(200);
    validateAndSnapshotShape(body, 'search_discussion response');
  });
});
