#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { HAOpsApiClient } from './api/client.js';
import { parseCliArgs } from './cli-args.js';
import type {
  CreateModuleRequest,
  UpdateModuleRequest,
  CreateFeatureRequest,
  UpdateFeatureRequest,
  CreateIssueRequest,
  UpdateIssueRequest,
  CreateDiscussionRequest,
  UpdateDiscussionRequest,
  CreateDiscussionMessageRequest,
  CreateDirectMessageRequest,
  ProjectMemberRole,
} from './types/entities.js';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import 'dotenv/config';
import { recordToolCall } from './telemetry.js';

const HAOPS_API_URL = process.env.HAOPS_API_URL || 'http://localhost:3000';
const HAOPS_API_KEY = process.env.HAOPS_API_KEY;

if (!HAOPS_API_KEY) {
  console.error('Error: HAOPS_API_KEY environment variable is required');
  process.exit(1);
}

// Initialize API client
const apiClient = new HAOpsApiClient(HAOPS_API_URL, HAOPS_API_KEY);

// Helper: format relative date for MCP output
function formatRelativeDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 30) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

/**
 * Format a write-tool response in compact (default) or verbose mode.
 *
 * Compact: "{action} — {id} [{status}] {title}" ≤ ~200 chars.
 *   Agents almost never read the full echo; compact saves context budget.
 * Verbose: full pretty-printed JSON for debugging.
 *
 * Exported so unit tests can verify the formatter in isolation.
 *
 * @param action  - Past-tense verb ("created", "updated", "deleted", …)
 * @param obj     - The API response object (must have at least { id })
 * @param verbose - If true, return the full JSON instead
 */
export function formatWriteResult(
  action: string,
  obj: Record<string, unknown>,
  verbose: boolean,
): string {
  if (verbose) {
    return `${action.charAt(0).toUpperCase() + action.slice(1)} successfully:\n${JSON.stringify(obj, null, 2)}`;
  }
  const id = (obj.id as string | undefined) ?? '';
  const title = (obj.title as string | undefined) ?? (obj.name as string | undefined) ?? '';
  const status = (obj.status as string | undefined) ?? '';
  const version = obj.version !== undefined ? ` v${obj.version}` : '';
  let compact = `${action.charAt(0).toUpperCase() + action.slice(1)}`;
  if (id) compact += ` — ${id}`;
  if (status) compact += ` [${status}]`;
  if (title) compact += ` "${title}"`;
  if (version) compact += version;
  // Hard cap at 200 chars (title truncation only)
  if (compact.length > 200) compact = compact.slice(0, 197) + '…';
  return compact;
}

/**
 * Strict RFC 4122 v1–v5 UUID form (version nibble 1–5, variant nibble 8/9/a/b),
 * case-insensitive. The nil UUID is intentionally rejected — HAOps never mints
 * or persists it. Mirrors the server-side guard in `lib/utils/validateUuid.ts`.
 */
const UUID_V1_V5_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Assert that a tool argument expected to be an entity UUID is actually a
 * UUID before it reaches the API. Without this, an omitted/typo'd/undefined
 * argument gets stringified into the request path (e.g.
 * `/merge-requests/undefined`) and surfaces as a confusing Postgres 22P02
 * downstream. Throwing here lets the handler's try/catch return a clean,
 * actionable `isError` tool result instead.
 *
 * @param value - The argument value received from the tool call.
 * @param field - The argument name, for the error message.
 * @returns The validated UUID string (narrowed to `string`).
 */
export function assertUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_V1_V5_REGEX.test(value)) {
    throw new Error(
      `Invalid ${field}: expected a UUID, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * Build a fresh MCP `Server` instance with all HAOps tool & resource
 * handlers registered.
 *
 * The SDK's Protocol layer binds 1:1 with a transport — a Server that has
 * already been `.connect()`ed cannot accept a second transport. Stdio mode
 * therefore uses a single instance (created once in `main()`), while HTTP
 * mode calls this factory once per client session.
 *
 * All handlers capture `apiClient` (the module-level singleton) so every
 * session shares the same connection pool + auth context toward
 * haops.datapatient.eu. This is intentional: one daemon = one HAOps user.
 */
export function buildMcpServer(): Server {
  const server = new Server(
    { name: 'haops-mcp-server', version: '0.1.0' },
    { capabilities: { resources: {}, tools: {} } }
  );

/**
 * List available resources
 */
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: [
      {
        uri: 'haops://projects',
        name: 'All Projects',
        description: 'List all projects in HAOps',
        mimeType: 'application/json',
      },
    ],
  };
});

/**
 * Read a specific resource
 */
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri;

  // Parse URI: haops://projects or haops://projects/{slug}/{entity}?query
  const [uriPath, queryString] = uri.split('?');
  const params = new URLSearchParams(queryString || '');

  const match = uriPath.match(/^haops:\/\/projects(?:\/([^/]+)\/([^/]+))?$/);
  if (!match) {
    throw new Error(`Invalid resource URI: ${uri}`);
  }

  const [, slug, entityType] = match;

  // Extract common filters
  const status = params.get('status') || undefined;
  const priority = params.get('priority') || undefined;
  const limit = params.has('limit') ? parseInt(params.get('limit')!) : undefined;
  const offset = params.has('offset') ? parseInt(params.get('offset')!) : undefined;

  try {
    // haops://projects - list all projects
    if (!slug) {
      const projects = await apiClient.listProjects();
      return {
        contents: [{
          uri,
          mimeType: 'application/json',
          text: JSON.stringify({ data: projects, total: projects.length }, null, 2),
        }],
      };
    }

    // haops://projects/{slug}/modules?status=&priority=&ownerId=
    if (entityType === 'modules') {
      const ownerId = params.get('ownerId') || undefined;
      if (status || priority || ownerId || limit) {
        const result = await apiClient.listModulesWithMeta(slug, { status, priority, ownerId, limit, offset });
        return {
          contents: [{
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(result, null, 2),
          }],
        };
      }
      const modules = await apiClient.listModules(slug);
      return {
        contents: [{
          uri,
          mimeType: 'application/json',
          text: JSON.stringify({ data: modules, total: modules.length }, null, 2),
        }],
      };
    }

    // haops://projects/{slug}/features?status=&priority=
    if (entityType === 'features') {
      const features = await apiClient.listFeatures(slug, { status, priority, limit, offset });
      return {
        contents: [{
          uri,
          mimeType: 'application/json',
          text: JSON.stringify({ data: features, total: features.length }, null, 2),
        }],
      };
    }

    // haops://projects/{slug}/issues?status=&priority=&assignedTo=&type=
    if (entityType === 'issues') {
      const assignedTo = params.get('assignedTo') || undefined;
      const type = params.get('type') || undefined;
      const issues = await apiClient.listIssues(slug, { status, priority, assignedTo, type, limit, offset });
      return {
        contents: [{
          uri,
          mimeType: 'application/json',
          text: JSON.stringify({ data: issues, total: issues.length }, null, 2),
        }],
      };
    }

    throw new Error(`Unknown entity type: ${entityType}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`Failed to fetch resource: ${message}`);
  }
});

/**
 * List available tools
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'haops_list_projects',
        description: 'List all projects in HAOps',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
      {
        name: 'haops_create_module',
        description: 'Create a new module in a HAOps project',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: {
              type: 'string',
              description: 'The project slug (URL identifier)',
            },
            title: {
              type: 'string',
              description: 'Module title',
            },
            description: {
              type: 'string',
              description: 'Detailed module description (optional)',
            },
            ownerId: {
              type: 'string',
              description: 'UUID of the module owner (user ID)',
            },
            status: {
              type: 'string',
              description: 'Module status (optional)',
              enum: ['backlog', 'in-progress', 'review', 'done', 'blocked', 'on-hold', 'cancelled'],
            },
            priority: {
              type: 'string',
              description: 'Priority level (optional)',
              enum: ['low', 'medium', 'high', 'critical'],
            },
            startDate: {
              type: 'string',
              description: 'Start date in YYYY-MM-DD format (optional)',
            },
            targetDate: {
              type: 'string',
              description: 'Target completion date in YYYY-MM-DD format (optional)',
            },
            notes: {
              type: 'string',
              description: 'Internal notes for tracking progress (optional)',
            },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['projectSlug', 'title', 'ownerId'],
        },
      },
      {
        name: 'haops_update_module',
        description: 'Update an existing module in a HAOps project',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: {
              type: 'string',
              description: 'The project slug (URL identifier)',
            },
            moduleId: {
              type: 'string',
              description: 'UUID of the module to update',
            },
            title: {
              type: 'string',
              description: 'Module title (optional)',
            },
            description: {
              type: 'string',
              description: 'Detailed module description (optional)',
            },
            ownerId: {
              type: 'string',
              description: 'UUID of the module owner (optional)',
            },
            status: {
              type: 'string',
              description: 'Module status (optional)',
              enum: ['backlog', 'in-progress', 'review', 'done', 'blocked', 'on-hold', 'cancelled'],
            },
            priority: {
              type: 'string',
              description: 'Priority level (optional)',
              enum: ['low', 'medium', 'high', 'critical'],
            },
            startDate: {
              type: 'string',
              description: 'Start date in YYYY-MM-DD format (optional)',
            },
            targetDate: {
              type: 'string',
              description: 'Target completion date in YYYY-MM-DD format (optional)',
            },
            notes: {
              type: 'string',
              description: 'Internal notes for tracking progress (optional)',
            },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['projectSlug', 'moduleId'],
        },
      },
      {
        name: 'haops_create_feature',
        description: 'Create a new feature in a HAOps module',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: {
              type: 'string',
              description: 'The project slug (URL identifier)',
            },
            moduleId: {
              type: 'string',
              description: 'UUID of the parent module',
            },
            title: {
              type: 'string',
              description: 'Feature title',
            },
            description: {
              type: 'string',
              description: 'Detailed feature description (optional)',
            },
            acceptanceCriteria: {
              type: 'string',
              description: 'Acceptance criteria for the feature (optional)',
            },
            ownerId: {
              type: 'string',
              description: 'UUID of the feature owner (user ID)',
            },
            status: {
              type: 'string',
              description: 'Feature status (optional)',
              enum: ['backlog', 'in-progress', 'review', 'done', 'blocked', 'on-hold', 'cancelled'],
            },
            priority: {
              type: 'string',
              description: 'Priority level (optional)',
              enum: ['low', 'medium', 'high', 'critical'],
            },
            startDate: {
              type: 'string',
              description: 'Start date in YYYY-MM-DD format (optional)',
            },
            targetDate: {
              type: 'string',
              description: 'Target completion date in YYYY-MM-DD format (optional)',
            },
            notes: {
              type: 'string',
              description: 'Internal notes for tracking progress (optional)',
            },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['projectSlug', 'moduleId', 'title', 'ownerId'],
        },
      },
      {
        name: 'haops_update_feature',
        description: 'Update an existing feature in a HAOps module',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: {
              type: 'string',
              description: 'The project slug (URL identifier)',
            },
            featureId: {
              type: 'string',
              description: 'UUID of the feature to update',
            },
            title: {
              type: 'string',
              description: 'Feature title (optional)',
            },
            description: {
              type: 'string',
              description: 'Detailed feature description (optional)',
            },
            acceptanceCriteria: {
              type: 'string',
              description: 'Acceptance criteria for the feature (optional)',
            },
            ownerId: {
              type: 'string',
              description: 'UUID of the feature owner (optional)',
            },
            status: {
              type: 'string',
              description: 'Feature status (optional)',
              enum: ['backlog', 'in-progress', 'review', 'done', 'blocked', 'on-hold', 'cancelled'],
            },
            priority: {
              type: 'string',
              description: 'Priority level (optional)',
              enum: ['low', 'medium', 'high', 'critical'],
            },
            startDate: {
              type: 'string',
              description: 'Start date in YYYY-MM-DD format (optional)',
            },
            targetDate: {
              type: 'string',
              description: 'Target completion date in YYYY-MM-DD format (optional)',
            },
            notes: {
              type: 'string',
              description: 'Internal notes for tracking progress (optional)',
            },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['projectSlug', 'featureId'],
        },
      },
      {
        name: 'haops_create_issue',
        description: 'Create a new issue in a HAOps feature',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: {
              type: 'string',
              description: 'The project slug (URL identifier)',
            },
            featureId: {
              type: 'string',
              description: 'UUID of the parent feature',
            },
            title: {
              type: 'string',
              description: 'Issue title',
            },
            description: {
              type: 'string',
              description: 'Detailed issue description (optional)',
            },
            acceptanceCriteria: {
              type: 'string',
              description: 'Acceptance criteria for the issue (optional)',
            },
            type: {
              type: 'string',
              description: 'Issue type (optional)',
              enum: ['feature', 'bug', 'optimization', 'refactoring', 'documentation', 'research'],
            },
            status: {
              type: 'string',
              description: 'Issue status (optional)',
              enum: ['backlog', 'in-progress', 'review', 'done', 'blocked', 'on-hold', 'cancelled'],
            },
            priority: {
              type: 'string',
              description: 'Priority level (optional)',
              enum: ['low', 'medium', 'high', 'critical'],
            },
            targetDate: {
              type: 'string',
              description: 'Target completion date in YYYY-MM-DD format (optional)',
            },
            assignedTo: {
              type: 'string',
              description: 'UUID of the user assigned to this issue (optional)',
            },
            notes: {
              type: 'string',
              description: 'Internal notes for tracking progress (optional)',
            },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['projectSlug', 'featureId', 'title'],
        },
      },
      {
        name: 'haops_delete_module',
        description: 'Delete a module from a HAOps project. If the module has child features, requires confirm=true to cascade delete.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: {
              type: 'string',
              description: 'The project slug (URL identifier)',
            },
            moduleId: {
              type: 'string',
              description: 'UUID of the module to delete',
            },
            confirm: {
              type: 'boolean',
              description: 'Set to true to confirm cascade deletion of child features and issues. Required if module has children.',
            },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['projectSlug', 'moduleId'],
        },
      },
      {
        name: 'haops_delete_feature',
        description: 'Delete a feature from a HAOps module. If the feature has child issues, requires confirm=true to cascade delete.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: {
              type: 'string',
              description: 'The project slug (URL identifier)',
            },
            featureId: {
              type: 'string',
              description: 'UUID of the feature to delete',
            },
            confirm: {
              type: 'boolean',
              description: 'Set to true to confirm cascade deletion of child issues. Required if feature has children.',
            },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['projectSlug', 'featureId'],
        },
      },
      {
        name: 'haops_delete_issue',
        description: 'Delete an issue from a HAOps feature. No confirmation needed (issues are leaf nodes with no children).',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: {
              type: 'string',
              description: 'The project slug (URL identifier)',
            },
            issueId: {
              type: 'string',
              description: 'UUID of the issue to delete',
            },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['projectSlug', 'issueId'],
        },
      },
      {
        name: 'haops_update_issue',
        description: 'Update an existing issue in a HAOps feature',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: {
              type: 'string',
              description: 'The project slug (URL identifier)',
            },
            issueId: {
              type: 'string',
              description: 'UUID of the issue to update',
            },
            title: {
              type: 'string',
              description: 'Issue title (optional)',
            },
            description: {
              type: 'string',
              description: 'Detailed issue description (optional)',
            },
            acceptanceCriteria: {
              type: 'string',
              description: 'Acceptance criteria for the issue (optional)',
            },
            type: {
              type: 'string',
              description: 'Issue type (optional)',
              enum: ['feature', 'bug', 'optimization', 'refactoring', 'documentation', 'research'],
            },
            status: {
              type: 'string',
              description: 'Issue status (optional)',
              enum: ['backlog', 'in-progress', 'review', 'done', 'blocked', 'on-hold', 'cancelled'],
            },
            priority: {
              type: 'string',
              description: 'Priority level (optional)',
              enum: ['low', 'medium', 'high', 'critical'],
            },
            targetDate: {
              type: 'string',
              description: 'Target completion date in YYYY-MM-DD format (optional)',
            },
            assignedTo: {
              type: 'string',
              description: 'UUID of the user assigned to this issue (optional)',
            },
            notes: {
              type: 'string',
              description: 'Internal notes for tracking progress (optional)',
            },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['projectSlug', 'issueId'],
        },
      },
      {
        name: 'haops_bulk_update_issues',
        description: 'Update multiple issues at once. Useful for batch status changes, priority updates, or reassignments.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: {
              type: 'string',
              description: 'The project slug (URL identifier)',
            },
            issueIds: {
              type: 'array',
              items: { type: 'string' },
              description: 'Array of issue UUIDs to update',
            },
            updates: {
              type: 'object',
              description: 'Fields to update on all issues',
              properties: {
                status: {
                  type: 'string',
                  enum: ['backlog', 'in-progress', 'review', 'done', 'blocked', 'on-hold', 'cancelled'],
                },
                priority: {
                  type: 'string',
                  enum: ['low', 'medium', 'high', 'critical'],
                },
                assignedTo: {
                  type: 'string',
                  description: 'UUID of the user to assign issues to',
                },
              },
            },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['projectSlug', 'issueIds', 'updates'],
        },
      },
      {
        name: 'haops_create_discussion',
        description: 'Create a discussion thread in a HAOps project. Two modes: (1) Entity-linked — provide discussableType + discussableId to link to a Module/Feature/Issue (no channelId needed). (2) Channel-based — provide channelId (use haops_list_channels to find it). Can combine both. At least one of channelId or discussableType+discussableId is required.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: {
              type: 'string',
              description: 'The project slug (URL identifier)',
            },
            title: {
              type: 'string',
              description: 'Discussion title',
            },
            type: {
              type: 'string',
              description: 'Discussion type (optional, default: general)',
              enum: ['extension', 'bug', 'optimization', 'question', 'general'],
            },
            priority: {
              type: 'string',
              description: 'Priority level (optional)',
              enum: ['low', 'medium', 'high', 'critical'],
            },
            channelId: {
              type: 'string',
              description: 'UUID of the channel. Required for channel-based discussions. Use haops_list_channels to get valid channel UUIDs.',
            },
            discussableType: {
              type: 'string',
              description: 'Entity type to link the discussion to. For entity-linked discussions, provide both discussableType and discussableId (no channelId needed).',
              enum: ['Module', 'Feature', 'Issue'],
            },
            discussableId: {
              type: 'string',
              description: 'UUID of the entity to link the discussion to. Required together with discussableType for entity-linked discussions.',
            },
            firstMessage: {
              type: 'string',
              description: 'Initial message content for the discussion thread (optional). Use markdown formatting for best results.',
            },
            firstMessageContentType: {
              type: 'string',
              description: 'Content format for firstMessage (optional, default: markdown). Markdown is recommended for agents.',
              enum: ['text', 'markdown', 'html', 'code'],
            },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['projectSlug', 'title'],
        },
      },
      {
        name: 'haops_list_discussions',
        description: 'List discussions in a HAOps project. Filter by entity (Module/Feature/Issue) to find entity-linked discussions, or by channel/status. Essential for the Entity Discussion Protocol — use this to find the discussion linked to a work item before posting.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: {
              type: 'string',
              description: 'The project slug (URL identifier)',
            },
            entityType: {
              type: 'string',
              description: 'Filter by entity type (e.g., find discussions linked to a Module or Feature)',
              enum: ['Module', 'Feature', 'Issue'],
            },
            entityId: {
              type: 'string',
              description: 'UUID of the entity to find discussions for (requires entityType)',
            },
            channelId: {
              type: 'string',
              description: 'UUID of the channel to filter discussions by',
            },
            status: {
              type: 'string',
              description: 'Filter by discussion status',
              enum: ['open', 'in-progress', 'resolved', 'closed'],
            },
          },
          required: ['projectSlug'],
        },
      },
      {
        name: 'haops_list_channels',
        description: 'List all channels in a HAOps project. Use this to discover channel UUIDs needed for creating channel-based discussions via haops_create_discussion.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: {
              type: 'string',
              description: 'The project slug (URL identifier)',
            },
          },
          required: ['projectSlug'],
        },
      },
      {
        name: 'haops_post_message',
        description: 'Post a message to a discussion thread in a HAOps project. Markdown is recommended for agent messages — it will be converted to HTML server-side.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: {
              type: 'string',
              description: 'The project slug (URL identifier)',
            },
            discussionId: {
              type: 'string',
              description: 'UUID of the discussion thread',
            },
            content: {
              type: 'string',
              description: 'Message content. Use markdown formatting (headings, bold, lists, code blocks) for best results. Supports @mentions with user IDs.',
            },
            contentType: {
              type: 'string',
              description: 'Content format (optional, default: markdown). Markdown is recommended for agents.',
              enum: ['text', 'markdown', 'html', 'code'],
            },
            parentMessageId: {
              type: 'string',
              description: 'UUID of parent message for threaded replies (optional)',
            },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['projectSlug', 'discussionId', 'content'],
        },
      },
      {
        name: 'haops_send_dm',
        description: 'Send a direct message to a user in a HAOps project. Supports markdown formatting — content will be converted to HTML server-side.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: {
              type: 'string',
              description: 'The project slug (URL identifier)',
            },
            recipientUserId: {
              type: 'string',
              description: 'UUID of the recipient user (must be a project member)',
            },
            content: {
              type: 'string',
              description: 'Message content. Markdown formatting is supported and recommended.',
            },
            contentType: {
              type: 'string',
              description: 'Content format (optional, default: markdown)',
              enum: ['text', 'markdown', 'html', 'code'],
            },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['projectSlug', 'recipientUserId', 'content'],
        },
      },
      {
        name: 'haops_get_discussion',
        description: 'Get detailed information about a specific discussion thread, including metadata and entity linkage.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: {
              type: 'string',
              description: 'The project slug (URL identifier)',
            },
            discussionId: {
              type: 'string',
              description: 'UUID of the discussion to retrieve',
            },
          },
          required: ['projectSlug', 'discussionId'],
        },
      },
      {
        name: 'haops_get_discussion_messages',
        description: 'Retrieve messages from a discussion thread with pagination. Essential for reading conversation context before responding.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: {
              type: 'string',
              description: 'The project slug (URL identifier)',
            },
            discussionId: {
              type: 'string',
              description: 'UUID of the discussion',
            },
            page: {
              type: 'number',
              description: 'Page number (default: 1)',
            },
            limit: {
              type: 'number',
              description: 'Messages per page (default: 50, max: 100)',
            },
          },
          required: ['projectSlug', 'discussionId'],
        },
      },
      {
        name: 'haops_list_dm_conversations',
        description: 'List all direct message conversations in a project with unread counts and last message previews.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: {
              type: 'string',
              description: 'The project slug (URL identifier)',
            },
          },
          required: ['projectSlug'],
        },
      },
      {
        name: 'haops_get_dm_history',
        description: 'Retrieve direct message history with a specific user. Use this to read DM context before replying.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: {
              type: 'string',
              description: 'The project slug (URL identifier)',
            },
            userId: {
              type: 'string',
              description: 'UUID of the other user in the conversation',
            },
            page: {
              type: 'number',
              description: 'Page number (default: 1)',
            },
            limit: {
              type: 'number',
              description: 'Messages per page (default: 50, max: 100)',
            },
          },
          required: ['projectSlug', 'userId'],
        },
      },
      {
        name: 'haops_update_discussion',
        description: 'Update discussion properties (title, status, priority, assignment, locking, pinning). Use this to resolve/close discussions or change metadata.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: {
              type: 'string',
              description: 'The project slug (URL identifier)',
            },
            discussionId: {
              type: 'string',
              description: 'UUID of the discussion to update',
            },
            title: {
              type: 'string',
              description: 'New discussion title',
            },
            type: {
              type: 'string',
              description: 'Discussion type',
              enum: ['extension', 'bug', 'optimization', 'question', 'general'],
            },
            status: {
              type: 'string',
              description: 'Discussion status (e.g., resolved, closed)',
              enum: ['open', 'in-progress', 'resolved', 'closed'],
            },
            priority: {
              type: 'string',
              description: 'Priority level',
              enum: ['low', 'medium', 'high', 'critical'],
            },
            assignedTo: {
              type: 'string',
              description: 'UUID of user to assign the discussion to (or null to unassign)',
            },
            isLocked: {
              type: 'boolean',
              description: 'Whether the discussion is locked (no new messages allowed)',
            },
            isPinned: {
              type: 'boolean',
              description: 'Whether the discussion is pinned (appears first in lists)',
            },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['projectSlug', 'discussionId'],
        },
      },
      {
        name: 'haops_mark_dm_read',
        description: 'Mark all direct messages from a specific user as read.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: {
              type: 'string',
              description: 'The project slug (URL identifier)',
            },
            userId: {
              type: 'string',
              description: 'UUID of the user whose messages to mark as read',
            },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['projectSlug', 'userId'],
        },
      },
      {
        name: 'haops_delete_discussion',
        description: 'Delete a discussion thread. This is permanent and will also delete all messages in the thread. Use with caution.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: {
              type: 'string',
              description: 'The project slug (URL identifier)',
            },
            discussionId: {
              type: 'string',
              description: 'UUID of the discussion to delete',
            },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['projectSlug', 'discussionId'],
        },
      },
      {
        name: 'haops_edit_message',
        description: 'Edit an existing message in a discussion thread. Only the message author can edit. Useful for correcting typos or updating information.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: {
              type: 'string',
              description: 'The project slug (URL identifier)',
            },
            discussionId: {
              type: 'string',
              description: 'UUID of the discussion thread',
            },
            messageId: {
              type: 'string',
              description: 'UUID of the message to edit',
            },
            content: {
              type: 'string',
              description: 'New message content. Markdown formatting is recommended.',
            },
            contentType: {
              type: 'string',
              description: 'Content format (optional, default: markdown)',
              enum: ['text', 'markdown', 'html', 'code'],
            },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['projectSlug', 'discussionId', 'messageId', 'content'],
        },
      },
      {
        name: 'haops_delete_message',
        description: 'Delete a message from a discussion thread. Only the message author can delete. This is permanent.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: {
              type: 'string',
              description: 'The project slug (URL identifier)',
            },
            discussionId: {
              type: 'string',
              description: 'UUID of the discussion thread',
            },
            messageId: {
              type: 'string',
              description: 'UUID of the message to delete',
            },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['projectSlug', 'discussionId', 'messageId'],
        },
      },
      {
        name: 'haops_list_members',
        description: 'List all members of a HAOps project with their roles and activity stats.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: {
              type: 'string',
              description: 'The project slug (URL identifier)',
            },
          },
          required: ['projectSlug'],
        },
      },
      {
        name: 'haops_add_member',
        description: 'Add a user as a member to a HAOps project.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: {
              type: 'string',
              description: 'The project slug (URL identifier)',
            },
            userId: {
              type: 'string',
              description: 'UUID of the user to add',
            },
            role: {
              type: 'string',
              description: 'Project role (optional, default: member)',
              enum: ['admin', 'project_manager', 'member', 'viewer'],
            },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['projectSlug', 'userId'],
        },
      },
      {
        name: 'haops_update_member_role',
        description: 'Update a project member\'s role. Cannot change the owner role.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: {
              type: 'string',
              description: 'The project slug (URL identifier)',
            },
            userId: {
              type: 'string',
              description: 'UUID of the member to update',
            },
            role: {
              type: 'string',
              description: 'New project role',
              enum: ['admin', 'project_manager', 'member', 'viewer'],
            },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['projectSlug', 'userId', 'role'],
        },
      },
      {
        name: 'haops_get_activity',
        description: 'Get activity log for a specific entity (Module, Feature, or Issue) in a HAOps project. Shows who changed what and when.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: {
              type: 'string',
              description: 'The project slug (URL identifier)',
            },
            entityType: {
              type: 'string',
              description: 'Type of entity',
              enum: ['Module', 'Feature', 'Issue'],
            },
            entityId: {
              type: 'string',
              description: 'UUID of the entity',
            },
          },
          required: ['projectSlug', 'entityType', 'entityId'],
        },
      },
      {
        name: 'haops_get_audit_log',
        description: 'Get system-wide audit log (admin only). Shows all changes across the platform with filters.',
        inputSchema: {
          type: 'object',
          properties: {
            page: {
              type: 'number',
              description: 'Page number (default: 1)',
            },
            limit: {
              type: 'number',
              description: 'Results per page (default: 50, max: 100)',
            },
            action: {
              type: 'string',
              description: 'Filter by action type (e.g., owner_changed, status_changed, created)',
            },
            entityType: {
              type: 'string',
              description: 'Filter by entity type',
              enum: ['Module', 'Feature', 'Issue'],
            },
          },
          required: [],
        },
      },
      {
        name: 'haops_claim_issue',
        description: 'Claim an issue for work. Checks availability and marks as in-progress. Use before starting implementation.',
        inputSchema: {
          type: 'object',
          properties: {
            issueId: {
              type: 'string',
              description: 'UUID of the issue to claim',
            },
            checkOnly: {
              type: 'boolean',
              description: 'Only check if claimable, do not actually claim (default: false)',
            },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['issueId'],
        },
      },
      {
        name: 'haops_claim_feature',
        description: 'Claim a feature for work. Checks availability and marks as in-progress. Use before starting implementation on a feature.',
        inputSchema: {
          type: 'object',
          properties: {
            featureId: {
              type: 'string',
              description: 'UUID of the feature to claim',
            },
            checkOnly: {
              type: 'boolean',
              description: 'Only check if claimable, do not actually claim (default: false)',
            },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['featureId'],
        },
      },
      {
        name: 'haops_claim_module',
        description: 'Claim a module for work. Checks availability and marks as in-progress. Use before starting implementation on a module.',
        inputSchema: {
          type: 'object',
          properties: {
            moduleId: {
              type: 'string',
              description: 'UUID of the module to claim',
            },
            checkOnly: {
              type: 'boolean',
              description: 'Only check if claimable, do not actually claim (default: false)',
            },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['moduleId'],
        },
      },
      {
        name: 'haops_work_entity_health_check',
        description: 'Run health checks on work entities to detect stale, inconsistent, or problematic states. Returns findings with severity and recommendations.',
        inputSchema: {
          type: 'object',
          properties: {
            projectId: {
              type: 'string',
              description: 'Filter by project UUID (optional, default: all projects)',
            },
            entityType: {
              type: 'string',
              description: 'Filter by entity type (default: all)',
              enum: ['module', 'feature', 'issue', 'all'],
            },
            checks: {
              type: 'array',
              items: { type: 'string' },
              description: 'Array of check types to run (default: all 6). Options: stale_in_progress, inconsistent_taken, orphaned_taken, multiple_stuck, long_review, blocked_without_note',
            },
            staleThresholdHours: {
              type: 'number',
              description: 'Threshold in hours for stale/long_review checks (default: 24)',
            },
            verbosity: {
              type: 'string',
              description: 'Output verbosity level (default: normal)',
              enum: ['summary', 'normal', 'detailed'],
            },
          },
          required: [],
        },
      },
      // ===== Help Center Tools =====
      {
        name: 'haops_list_help_sections',
        description: 'List all help center sections with article counts. Returns published and unpublished sections.',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
      {
        name: 'haops_list_help_articles',
        description: 'List help articles, optionally filtered by section slug.',
        inputSchema: {
          type: 'object',
          properties: {
            sectionSlug: {
              type: 'string',
              description: 'Filter articles by section slug (optional, returns all if omitted)',
            },
          },
          required: [],
        },
      },
      {
        name: 'haops_create_help_article',
        description: 'Create a new help article in a section.',
        inputSchema: {
          type: 'object',
          properties: {
            sectionSlug: {
              type: 'string',
              description: 'The section slug to create the article in',
            },
            title: {
              type: 'string',
              description: 'Article title',
            },
            content: {
              type: 'string',
              description: 'Article content (HTML)',
            },
            isPublished: {
              type: 'boolean',
              description: 'Whether to publish immediately (default: false)',
            },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['sectionSlug', 'title'],
        },
      },
      {
        name: 'haops_get_help_article',
        description: 'Get a help article by slug, including full HTML content. Use this before haops_update_help_article when you need to append to existing content (update is wholesale replace).',
        inputSchema: {
          type: 'object',
          properties: {
            slug: {
              type: 'string',
              description: 'The article slug to fetch',
            },
          },
          required: ['slug'],
        },
      },
      {
        name: 'haops_update_help_article',
        description: 'Update an existing help article by slug.',
        inputSchema: {
          type: 'object',
          properties: {
            slug: {
              type: 'string',
              description: 'The article slug to update',
            },
            title: {
              type: 'string',
              description: 'New title (optional)',
            },
            content: {
              type: 'string',
              description: 'New content in HTML (optional)',
            },
            isPublished: {
              type: 'boolean',
              description: 'Set published status (optional)',
            },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['slug'],
        },
      },

      // ===== Documentation Builder Tools =====
      {
        name: 'haops_list_doc_artifacts',
        description: 'List documentation artifacts for a project. Each artifact represents a type of documentation (architecture, developer, deployment, api, user_guide, changelog, adr, plans).',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: {
              type: 'string',
              description: 'The project slug',
            },
          },
          required: ['projectSlug'],
        },
      },
      {
        name: 'haops_create_doc_artifact',
        description: 'Create a new documentation artifact for a project. One artifact per type per project.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: {
              type: 'string',
              description: 'The project slug',
            },
            type: {
              type: 'string',
              description: 'Artifact type',
              enum: ['architecture', 'developer', 'deployment', 'api', 'user_guide', 'changelog', 'adr', 'plans'],
            },
            title: {
              type: 'string',
              description: 'Artifact title',
            },
            description: {
              type: 'string',
              description: 'Artifact description (optional)',
            },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['projectSlug', 'type', 'title'],
        },
      },
      {
        name: 'haops_update_doc_artifact',
        description: 'Update a documentation artifact (title, description, status, version).',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: {
              type: 'string',
              description: 'The project slug',
            },
            artifactSlug: {
              type: 'string',
              description: 'The artifact slug (usually same as type)',
            },
            title: {
              type: 'string',
              description: 'New title (optional)',
            },
            description: {
              type: 'string',
              description: 'New description (optional)',
            },
            status: {
              type: 'string',
              description: 'New status. Valid transitions: draft→review, review→published, published→outdated, any→draft',
              enum: ['draft', 'review', 'published', 'outdated'],
            },
            version: {
              type: 'string',
              description: 'Version string e.g. "1.0.0" (optional)',
            },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['projectSlug', 'artifactSlug'],
        },
      },
      {
        name: 'haops_create_doc_section',
        description: 'Create a new section within a documentation artifact. IMPORTANT: Uses `artifactSlug` (kebab-case slug of the parent artifact, e.g. "deployment" or "api-routes") — NOT the artifact UUID. This is an exception: most other create-* tools use UUID identifiers. Use `haops_list_doc_artifacts` to find the slug for a given artifact before calling this tool.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: {
              type: 'string',
              description: 'The project slug',
            },
            artifactSlug: {
              type: 'string',
              description: 'Kebab-case slug of the parent documentation artifact (e.g. "deployment", "api-routes"). NOT a UUID — use haops_list_doc_artifacts to find the slug.',
            },
            title: {
              type: 'string',
              description: 'Section title',
            },
            content: {
              type: 'string',
              description: 'Section content in HTML (optional)',
            },
            parentId: {
              type: 'string',
              description: 'UUID of parent section for nesting (optional, null for top-level)',
            },
            sourceHint: {
              type: 'string',
              description: 'Reference to source file e.g. "lib/models/User.ts" (optional)',
            },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['projectSlug', 'artifactSlug', 'title'],
        },
      },
      {
        name: 'haops_update_doc_section',
        description: 'Update a documentation section content, title, slug, or source hint. IMPORTANT: Uses `artifactSlug` (kebab-case slug of the parent artifact, e.g. "deployment" or "api-routes") — NOT the artifact UUID. This is an exception: most other update-* tools use UUID identifiers. Use `haops_list_doc_artifacts` to find the slug for a given artifact before calling this tool.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: {
              type: 'string',
              description: 'The project slug',
            },
            artifactSlug: {
              type: 'string',
              description: 'Kebab-case slug of the parent documentation artifact (e.g. "deployment", "api-routes"). NOT a UUID — use haops_list_doc_artifacts to find the slug.',
            },
            sectionSlug: {
              type: 'string',
              description: 'The current section slug (used to locate the row)',
            },
            title: {
              type: 'string',
              description: 'New title (optional)',
            },
            content: {
              type: 'string',
              description: 'New content in HTML (optional)',
            },
            sourceHint: {
              type: 'string',
              description: 'New source hint (optional)',
            },
            slug: {
              type: 'string',
              description: 'New slug (optional). Must be unique among siblings under the same parent within the artifact; returns 409 on collision. Note: cannot address a section whose current slug is empty — fix that at the DB layer first.',
            },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['projectSlug', 'artifactSlug', 'sectionSlug'],
        },
      },
      {
        name: 'haops_get_doc_section',
        description: 'Get a specific documentation section content and metadata.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: {
              type: 'string',
              description: 'The project slug',
            },
            artifactSlug: {
              type: 'string',
              description: 'The artifact slug',
            },
            sectionSlug: {
              type: 'string',
              description: 'The section slug',
            },
          },
          required: ['projectSlug', 'artifactSlug', 'sectionSlug'],
        },
      },
      {
        name: 'haops_export_doc_markdown',
        description: 'Export a documentation artifact as Markdown text. Returns the full Markdown content as a string (not a file download). Useful for syncing documentation to a git repository.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: {
              type: 'string',
              description: 'The project slug',
            },
            artifactSlug: {
              type: 'string',
              description: 'The artifact slug (e.g. "architecture", "developer", "api")',
            },
          },
          required: ['projectSlug', 'artifactSlug'],
        },
      },

      // ===== Onboarding Tool =====
      {
        name: 'haops_generate_onboarding',
        description: 'Generate a Developer Onboarding Kit (ZIP) for a new developer joining a project. Creates pre-configured agent workspace with memory files, agent definitions, and project configuration. The ZIP is saved to a local temp file and the file path is returned.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: {
              type: 'string',
              description: 'The project slug (URL identifier)',
            },
            developerName: {
              type: 'string',
              description: 'Full name of the developer being onboarded',
            },
            developerEmail: {
              type: 'string',
              description: 'Email of the developer being onboarded',
            },
            framework: {
              type: 'string',
              description: 'Project framework (e.g. "Next.js", "Django", "Rails")',
            },
            programmingLanguage: {
              type: 'string',
              description: 'Primary programming language (e.g. "TypeScript", "Python", "Ruby")',
            },
            database: {
              type: 'string',
              description: 'Database system (e.g. "PostgreSQL", "MySQL", "MongoDB")',
            },
            orm: {
              type: 'string',
              description: 'ORM/query library (e.g. "Sequelize", "Prisma", "ActiveRecord")',
            },
            uiFramework: {
              type: 'string',
              description: 'UI framework (e.g. "MUI", "Tailwind", "Bootstrap")',
            },
            repoPath: {
              type: 'string',
              description: 'Local repository path (e.g. "~/Projects/my-app")',
            },
            dbNameDev: {
              type: 'string',
              description: 'Development database name',
            },
            dbUserDev: {
              type: 'string',
              description: 'Development database user',
            },
            devServerUrl: {
              type: 'string',
              description: 'Local dev server URL (e.g. "http://localhost:3000")',
            },
            language: {
              type: 'string',
              description: 'Language for generated docs (default: "English")',
            },
            dbPasswordDev: {
              type: 'string',
              description: 'Development database password (optional)',
            },
            serverHost: {
              type: 'string',
              description: 'Production server hostname (optional)',
            },
            sshUser: {
              type: 'string',
              description: 'SSH user for production server (optional)',
            },
            sshMethod: {
              type: 'string',
              description: 'SSH auth method: "key" or "password" (optional)',
            },
            appPath: {
              type: 'string',
              description: 'Application path on production server (optional)',
            },
            processManager: {
              type: 'string',
              description: 'Process manager (e.g. "PM2", "systemd") (optional)',
            },
            publicUrl: {
              type: 'string',
              description: 'Public URL of the deployed app (optional)',
            },
            repoUrl: {
              type: 'string',
              description: 'Git repository URL (optional)',
            },
            testFramework: {
              type: 'string',
              description: 'Test framework (e.g. "Jest", "Pytest") (optional)',
            },
            testRunner: {
              type: 'string',
              description: 'Test runner command (e.g. "npm test") (optional)',
            },
            screenshotScript: {
              type: 'string',
              description: 'Screenshot script path (optional)',
            },
            webServer: {
              type: 'string',
              description: 'Web server (e.g. "Nginx", "Apache") (optional)',
            },
            os: {
              type: 'string',
              description: 'Server OS (e.g. "Ubuntu 22.04") (optional)',
            },
            generateApiKey: {
              type: 'boolean',
              description: 'Generate a new HAOps API key for the developer (default: false)',
            },
            haopsApiKey: {
              type: 'string',
              description: 'Existing HAOps API key to include in the kit (optional)',
            },
            outputDir: {
              type: 'string',
              description: 'Directory to save the ZIP file (default: /tmp)',
            },
          },
          required: [
            'projectSlug', 'developerName', 'developerEmail', 'framework',
            'programmingLanguage', 'database', 'orm', 'uiFramework',
            'repoPath', 'dbNameDev', 'dbUserDev', 'devServerUrl',
          ],
        },
      },

      // Agent Memory tools
      {
        name: 'haops_read_memory',
        description: [
          'Read agent memory for a project, module, or feature.',
          '',
          'mode="eager" (default): Returns baseText + full log entry bodies. Full project context in one call.',
          'mode="lazy" (ADR-027): For entityType=project — returns a compact INDEX envelope:',
          '  • baseText (already thin)',
          '  • Architecture doc tree (headers only: title [artifactSlug/sectionSlug])',
          '  • ADR index (headers only)',
          '  • Active work — in-progress modules + features',
          '  • Log headers only (timestamp · tag · author) — NO bodies',
          '  Agent then fetches detail on demand via haops_get_doc_section / haops_read_memory(full:true) / haops_rag_query.',
          '  For entityType=module/feature in lazy mode: falls back to eager (entity baseText is already thin).',
          '',
          'Use full=true (eager mode only) to include integrated (historical) log entries.',
          'Lazy default can be enabled via HAOPS_MEMORY_LAZY_DEFAULT=true env var on the MCP server.',
        ].join('\n'),
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: {
              type: 'string',
              description: 'The project slug (URL identifier)',
            },
            entityType: {
              type: 'string',
              enum: ['project', 'module', 'feature'],
              description: 'Type of entity to read memory for',
            },
            entityId: {
              type: 'string',
              description: 'UUID of the entity (use "self" for project-level memory)',
            },
            full: {
              type: 'boolean',
              description: 'If true, include all log entries (including integrated ones). Default: false (only pending entries). Applies to eager mode only.',
            },
            mode: {
              type: 'string',
              enum: ['eager', 'lazy'],
              description: 'eager (default): full memory dump. lazy (ADR-027): index envelope — baseText + doc headers + active work + log headers only. Reduces boot context by ~80%. Default is eager unless HAOPS_MEMORY_LAZY_DEFAULT=true is set on the MCP server.',
            },
          },
          required: ['projectSlug', 'entityType', 'entityId'],
        },
      },
      {
        name: 'haops_append_memory',
        description: 'Append a tagged log entry to entity agent memory. Author is auto-populated from the API key. Tag must be allowed for the API key\'s agent role (e.g. dev can use: context, decision, progress, issue; qa: review, issue; architect/admin: all tags).',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: {
              type: 'string',
              description: 'The project slug (URL identifier)',
            },
            entityType: {
              type: 'string',
              enum: ['project', 'module', 'feature'],
              description: 'Type of entity to append memory to',
            },
            entityId: {
              type: 'string',
              description: 'UUID of the entity (use "self" for project-level memory)',
            },
            tag: {
              type: 'string',
              enum: ['context', 'decision', 'progress', 'issue', 'review', 'deploy'],
              description: 'Semantic tag for the log entry',
            },
            content: {
              type: 'string',
              description: 'Content of the log entry (markdown supported)',
            },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['projectSlug', 'entityType', 'entityId', 'tag', 'content'],
        },
      },
      {
        name: 'haops_consolidate_memory',
        description: 'Consolidate entity agent memory: replace baseText with updated summary and mark log entries as integrated. Admin and architect roles ONLY. Use this to keep baseText concise by integrating accumulated log entries.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: {
              type: 'string',
              description: 'The project slug (URL identifier)',
            },
            entityType: {
              type: 'string',
              enum: ['project', 'module', 'feature'],
              description: 'Type of entity to consolidate memory for',
            },
            entityId: {
              type: 'string',
              description: 'UUID of the entity (use "self" for project-level memory)',
            },
            newBaseText: {
              type: 'string',
              description: 'The new consolidated baseText (markdown). Should incorporate relevant information from pending log entries.',
            },
            integrateUpTo: {
              type: 'string',
              description: 'ISO timestamp — mark all log entries up to this time as integrated. If omitted, all pending entries are marked.',
            },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['projectSlug', 'entityType', 'entityId', 'newBaseText'],
        },
      },
      // ===== Protocol Tools =====
      {
        name: 'haops_read_protocol',
        description:
          'Read the work protocol for a specific agent role in a project. Protocols define HOW agents should work (scope, workflow, handoff, etc.).\n\n' +
          'OUTPUT SHAPES (v2.6 — F4 composed protocols):\n' +
          '  • Legacy project (templateId IS NULL) — always returns the raw monolithic shape regardless of `mode`: { mode: "legacy", version, bytes, body, content, ... }. The `mode` and `bundle` params have no effect; output is byte-identical to v2.5.\n' +
          '  • Composed project + mode="lazy" (DEFAULT) — { mode: "composed-lazy", version, bytes, body: "", coreContent, skillRefs[], warnings? }. Agent reads coreContent for the boot section, then uses haops_read_skill to fetch individual skill bodies on demand.\n' +
          '  • Composed project + mode="bundle" — { mode: "composed-bundle", version, bytes, body, skillRefs[], warnings? }. Full composed markdown in `body` (template baseBody + each enabled skill body + customContent, joined with "---"). Use this when caching offline or when you need the full document in one round-trip.\n' +
          'When `version` is set, returns that specific historical row (raw DB shape — version history predates composed mode; mode/bundle are ignored).',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: {
              type: 'string',
              description: 'The project slug (URL identifier)',
            },
            role: {
              type: 'string',
              description: 'Agent role to read protocol for (e.g., architect, dev, qa, devops)',
            },
            version: {
              type: 'number',
              description:
                'Specific version number to read. If omitted, returns the current version. When set, mode is ignored (historical snapshots are raw DB rows).',
            },
            mode: {
              type: 'string',
              enum: ['lazy', 'bundle'],
              description:
                "F4: how to resolve composed protocols. 'lazy' (default) returns the boot section + skill manifest; agent fetches skill bodies via haops_read_skill. 'bundle' returns the full composed markdown in one shot. Ignored for legacy projects.",
            },
          },
          required: ['projectSlug', 'role'],
        },
      },
      {
        name: 'haops_update_protocol',
        description: 'Update (create new version of) the work protocol for a specific agent role in a project. Creates a new version and marks the previous as historical. Architect and admin roles ONLY.\n\nPartial-body support: Provide ONLY the fields you want to change. Server carries forward unchanged fields.\n  • Common usage: pass only `templateId` to rebind a role template binding without re-sending the full markdown body.\n  • Common usage: pass only `skillsConfig` to enable/disable skills without re-sending the markdown body.\n  • Pass `content` only when you actually want to update the markdown text.\n\nF3 composed-protocol fields (ENABLE_COMPOSED_PROTOCOLS must be ON):\n  • templateId — UUID of a RoleTemplate to associate, or null to detach. Omit to carry forward current value.\n  • skillsConfig — override which skills are active and inject custom content. Omit to carry forward. Set to null to clear.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: {
              type: 'string',
              description: 'The project slug (URL identifier)',
            },
            role: {
              type: 'string',
              description: 'Agent role to update protocol for (e.g., architect, dev, qa, devops)',
            },
            content: {
              type: 'string',
              description: 'The full protocol document in markdown. OPTIONAL — omit to carry forward the current body and only update other fields (e.g. templateId or skillsConfig).',
            },
            changeSummary: {
              type: 'string',
              description: 'Optional summary of what changed in this version',
            },
            templateId: {
              type: ['string', 'null'],
              description: 'F3: UUID of the RoleTemplate to associate with this protocol slot, or null to detach. When omitted the server carries forward the current value.',
            },
            skillsConfig: {
              type: ['object', 'null'],
              description: 'F3: Override active skills and custom content. Omit to carry forward; set to null to clear entirely.',
              properties: {
                enabledSkillIds: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'UUIDs of non-default skills to force-enable. Must reference existing, non-deprecated skills.',
                },
                disabledSkillIds: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'UUIDs of default skills to suppress. Cannot include required skills.',
                },
                customContent: {
                  type: ['string', 'null'],
                  description: 'Freeform markdown appended after the last skill section in composed mode.',
                },
              },
            },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['projectSlug', 'role'],
        },
      },
      {
        name: 'haops_list_protocol_versions',
        description: 'List all versions of a work protocol for a specific agent role. Returns version numbers, timestamps, change summaries, and who updated each version.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: {
              type: 'string',
              description: 'The project slug (URL identifier)',
            },
            role: {
              type: 'string',
              description: 'Agent role to list protocol versions for (e.g., architect, dev, qa, devops)',
            },
          },
          required: ['projectSlug', 'role'],
        },
      },

      // ===== Protocol Health Tool (P·A·I3) =====
      {
        name: 'haops_get_protocol_health',
        description:
          'Returns per-role composed-protocol health: missing skill UUIDs, deprecated references, skill pack health, snapshot metadata. Surfaces drift programmatically (same data as the Project Settings → Protocol Health panel in HAOps Desktop UI). Requires ENABLE_COMPOSED_PROTOCOLS=true on the server.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: {
              type: 'string',
              description: "Project slug, e.g. 'fdev', 'knf', 'ipro'",
            },
            includeSnapshots: {
              type: 'boolean',
              description: 'Include cached background-scan snapshots (default false)',
            },
            raw: {
              type: 'boolean',
              description: 'Return JSON envelope verbatim instead of formatted table',
            },
          },
          required: ['projectSlug'],
        },
      },

      // ===== Skills Library Tools (F1) =====
      {
        name: 'haops_list_skills',
        description: 'List agent skills (system-wide + optionally project-scoped). Skills are reusable, role-tagged knowledge units (e.g. "out-of-scope-findings", "three-layer-boot") that compose into agent protocols. Filter by scope, category, role, project, or free-text search. Deprecated skills are excluded by default.',
        inputSchema: {
          type: 'object',
          properties: {
            scope: {
              type: 'string',
              enum: ['system', 'project'],
              description: 'Filter by scope. Omit to combine system + project (when projectSlug given) or default to system-only.',
            },
            category: {
              type: 'string',
              enum: ['review', 'planning', 'testing', 'deployment', 'communication', 'memory', 'safety', 'other'],
              description: 'Filter by skill category.',
            },
            role: {
              type: 'string',
              description: 'Filter by applicable role (architect/dev/qa/devops). Matches skills whose applicableRoles includes the role OR the "*" wildcard.',
            },
            projectSlug: {
              type: 'string',
              description: 'Project slug for scope="project" (required when scope=project; widens search when scope omitted).',
            },
            search: {
              type: 'string',
              description: 'Free-text search across name + description.',
            },
            includeDeprecated: {
              type: 'boolean',
              description: 'Include deprecated skills (default: false).',
            },
          },
        },
      },
      {
        name: 'haops_read_skill',
        description:
          'Read a single skill by its kebab-case name. Returns full markdown content + metadata (category, applicableRoles, version, ID, isDeprecated). Use this after haops_list_skills — or after a haops_read_protocol(mode="lazy") response\'s skillRefs[] manifest — to fetch the actual instructions on demand.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Kebab-case skill name (e.g. "out-of-scope-findings").',
            },
            scope: {
              type: 'string',
              enum: ['system', 'project'],
              description: 'Scope to look in. Defaults to "system".',
            },
            projectSlug: {
              type: 'string',
              description: 'Project slug — required when scope="project".',
            },
            version: {
              type: 'number',
              description:
                'F4 (v2.6): specific version number to read. If omitted, returns the current version. Used by lazy-loaded composed protocols to fetch a pinned version of a skill body.',
            },
            raw: {
              type: 'boolean',
              description: 'When true, return the full JSON envelope verbatim (includes UUIDs, audit metadata, skillsConfig, defaultSkills as structured JSON). Useful for programmatic inspection or piping into other tools.',
            },
          },
          required: ['name'],
        },
      },
      {
        name: 'haops_create_skill',
        description:
          'Create a new agent skill (system or project-scoped). Inserts version=1 with isCurrent=true. Admin-only on the server, gated by ENABLE_COMPOSED_PROTOCOLS. Returns the new skill row on success; 409 if a skill with the same name already exists in the target scope (use haops_update_skill to publish a new version instead).',
        inputSchema: {
          type: 'object',
          properties: {
            scope: {
              type: 'string',
              enum: ['system', 'project'],
              description: 'Scope of the new skill. "system" omits projectSlug; "project" requires it.',
            },
            name: {
              type: 'string',
              description: 'Kebab-case skill name (1..100 chars, starts with a letter, e.g. "out-of-scope-findings").',
            },
            description: {
              type: 'string',
              description: 'Short one-line description of what the skill teaches (shown in list views and template pickers).',
            },
            content: {
              type: 'string',
              description: 'Full markdown body of the skill (admin-trusted; no sanitization applied server-side).',
            },
            category: {
              type: 'string',
              enum: ['review', 'planning', 'testing', 'deployment', 'communication', 'memory', 'safety', 'resilience', 'git', 'database', 'other'],
              description: 'Skill category for grouping in the catalogue.',
            },
            applicableRoles: {
              type: 'array',
              items: { type: 'string' },
              description: 'Roles the skill applies to. Non-empty array of {architect, dev, qa, devops} or the wildcard ["*"].',
            },
            projectSlug: {
              type: 'string',
              description: 'Project slug — REQUIRED when scope="project"; MUST be omitted when scope="system".',
            },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['scope', 'name', 'description', 'content', 'category', 'applicableRoles'],
        },
      },
      {
        name: 'haops_update_skill',
        description:
          'Publish a new version of an existing skill (PUT /api/skills/[name]). Server bumps version in a single transaction. A no-op update (no field differs from current) returns the current row WITHOUT a version bump (mirrors prompt PATCH semantics). At least one mutable field must be supplied. Admin-only, gated by ENABLE_COMPOSED_PROTOCOLS.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Kebab-case skill name to update.',
            },
            scope: {
              type: 'string',
              enum: ['system', 'project'],
              description: 'Scope of the target skill. Defaults to "system".',
            },
            projectSlug: {
              type: 'string',
              description: 'Project slug — REQUIRED when scope="project"; MUST be omitted when scope="system".',
            },
            description: {
              type: 'string',
              description: 'New description (non-empty).',
            },
            content: {
              type: 'string',
              description: 'New markdown body (non-empty).',
            },
            category: {
              type: 'string',
              enum: ['review', 'planning', 'testing', 'deployment', 'communication', 'memory', 'safety', 'resilience', 'git', 'database', 'other'],
              description: 'New skill category.',
            },
            applicableRoles: {
              type: 'array',
              items: { type: 'string' },
              description: 'New applicable roles list.',
            },
            isDeprecated: {
              type: 'boolean',
              description: 'Mark the skill as deprecated (the resolver hides deprecated skills from default manifests, but they remain readable).',
            },
            cascade: {
              type: 'boolean',
              description: 'When true, atomically re-wires all consumers (role templates with this skill in defaultSkills, skill packs containing this skill, project protocols with this skill in enabledSkillIds) to the NEW UUID in the same DB transaction. Recommended for any system skill bump. Default: false.',
            },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['name'],
        },
      },
      {
        name: 'haops_deprecate_skill',
        description:
          'Soft-delete + deprecate a skill (DELETE /api/skills/[name]). Cascades the soft-delete across ALL versions (current + historical) and flips isDeprecated=true on the current row. History remains visible via /api/skills/[name]/history for audit context. Admin-only, gated by ENABLE_COMPOSED_PROTOCOLS. Returns {message, versionCount}.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Kebab-case skill name to soft-delete.',
            },
            scope: {
              type: 'string',
              enum: ['system', 'project'],
              description: 'Scope of the target skill. Defaults to "system".',
            },
            projectSlug: {
              type: 'string',
              description: 'Project slug — REQUIRED when scope="project"; MUST be omitted when scope="system".',
            },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['name'],
        },
      },

      // ===== History Tools (P·B·I2) =====
      {
        name: 'haops_get_skill_history',
        description:
          'Returns the full version history of a named skill (GET /api/skills/[name]/history). Each entry contains the version number, publication timestamp, author, lifecycle state, and full content at that point in time. When diff=true the server computes unified diffs between consecutive versions and includes a `diff` field per entry (empty for v1, which has no predecessor). Use to audit content changes, recover from a bad publish, or inspect the lineage before bumping a high-impact skill.\n\nAdministrative note: soft-deleted (deprecated) skills still have their history accessible via this endpoint — paranoid=false on the server join so full audit lineage is preserved.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Kebab-case skill name.',
            },
            scope: {
              type: 'string',
              enum: ['system', 'project'],
              description: 'Scope of the target skill. Defaults to "system".',
            },
            projectSlug: {
              type: 'string',
              description: 'Project slug — REQUIRED when scope="project"; MUST be omitted when scope="system".',
            },
            diff: {
              type: 'boolean',
              description: 'When true, the server computes unified diffs between consecutive versions and includes a `diff` field on each history entry. Omit or set false for metadata-only listing.',
            },
            raw: {
              type: 'boolean',
              description: 'If true, return the raw JSON array verbatim instead of the formatted text table (default: false).',
            },
          },
          required: ['name'],
        },
      },
      {
        name: 'haops_get_role_template_history',
        description:
          'Returns the full version history of a named role template (GET /api/role-templates/[name]/history). Role templates are system-wide (no scope/projectSlug). Each entry contains version, publication timestamp, author, lifecycle state, and the full `baseBody` markdown. When diff=true the server computes unified diffs between consecutive versions and includes a `diff` field per entry.\n\nUse to audit template content over time, recover from a bad publish, or inspect changes before bumping a template with `cascade=true`.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Kebab-case role template name.',
            },
            diff: {
              type: 'boolean',
              description: 'When true, the server computes unified diffs between consecutive versions and includes a `diff` field on each history entry.',
            },
            raw: {
              type: 'boolean',
              description: 'If true, return the raw JSON array verbatim instead of the formatted text table (default: false).',
            },
          },
          required: ['name'],
        },
      },

      // ===== Bulk Publish Skills Tool (P·B·I6) =====
      {
        name: 'haops_bulk_publish_skills',
        description:
          'Atomically publish multiple skills in a single DB transaction (POST /api/skills/bulk-publish). All version bumps happen in one round-trip; when cascade=true, consumer re-wiring (role templates, skill packs, project protocols) runs ONCE at the end — significantly cheaper than N sequential haops_update_skill calls during mass refactors.\n\nPartial-failure semantics: if ANY entry fails validation (unknown skill name, bad scope+projectSlug combo, duplicate entry), the server rolls back the ENTIRE transaction and returns a 400 with a per-entry error list. No skills are published unless ALL entries are valid. Check `totalFailed` in the response — 0 means full success.\n\nAdmin-only, requires ENABLE_COMPOSED_PROTOCOLS=true. Returns 404 when the feature flag is off (the route looks absent by design).\n\nWARNING: cascade=true re-wires ALL consumers of EVERY updated skill in one transaction. Use haops_preview_skill_cascade on high-impact skills before running to estimate blast radius.',
        inputSchema: {
          type: 'object',
          properties: {
            entries: {
              type: 'array',
              description: 'List of skills to publish. Each entry must have name + scope. Only supply the fields you want to change; unchanged fields carry forward (no-op entries return the current row without bumping version).',
              items: {
                type: 'object',
                properties: {
                  name: {
                    type: 'string',
                    description: 'Kebab-case skill name.',
                  },
                  scope: {
                    type: 'string',
                    enum: ['system', 'project'],
                    description: 'Scope of the target skill.',
                  },
                  projectSlug: {
                    type: 'string',
                    description: 'REQUIRED when scope="project"; MUST be omitted when scope="system".',
                  },
                  content: {
                    type: 'string',
                    description: 'New markdown body.',
                  },
                  description: {
                    type: 'string',
                    description: 'New one-line description.',
                  },
                  category: {
                    type: 'string',
                    enum: ['review', 'planning', 'testing', 'deployment', 'communication', 'memory', 'safety', 'resilience', 'git', 'database', 'other'],
                    description: 'New category.',
                  },
                  applicableRoles: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'New applicable roles.',
                  },
                },
                required: ['name', 'scope'],
              },
            },
            cascade: {
              type: 'boolean',
              description: 'When true, atomically re-wires ALL consumers of the updated skills (role templates containing them in defaultSkills, skill packs containing their IDs, project protocols with them in enabledSkillIds) to the NEW UUIDs, all in the same transaction. Recommended for mass refactors. Default: false.',
            },
            verbose: {
              type: 'boolean',
              description: 'If true, include full skill JSON for each entry in the result output. Default: false.',
            },
          },
          required: ['entries'],
        },
      },

      // ===== Project-scope Skill Creation Tool (P·B·I5) =====
      {
        name: 'haops_create_project_skill',
        description:
          'Create a PROJECT-SCOPED skill (POST /api/projects/[slug]/skills). Project-scoped skills are visible only to that project\'s protocol resolver — they cannot be referenced by system role templates or other projects\' protocols. For skills you want reusable across all projects, use haops_create_skill with scope="system" instead.\n\nAdmin-only, requires ENABLE_COMPOSED_PROTOCOLS=true. Returns 409 if a non-deleted project skill with the same name already exists in this project — use haops_update_skill(scope="project", projectSlug=...) to publish a new version instead. Returns 404 when the feature flag is off.\n\nResponse includes id, scope="project", projectId and version=1.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: {
              type: 'string',
              description: 'URL slug of the project this skill belongs to.',
            },
            name: {
              type: 'string',
              description: 'Kebab-case skill name (1..100 chars, starts with a letter). Must be unique among current (non-deleted) project-scoped skills in this project.',
            },
            description: {
              type: 'string',
              description: 'Short one-line description shown in list views and template pickers.',
            },
            content: {
              type: 'string',
              description: 'Full markdown body of the skill (admin-trusted; no sanitization applied server-side).',
            },
            category: {
              type: 'string',
              enum: ['review', 'planning', 'testing', 'deployment', 'communication', 'memory', 'safety', 'resilience', 'git', 'database', 'other'],
              description: 'Skill category for grouping in the catalogue.',
            },
            applicableRoles: {
              type: 'array',
              items: { type: 'string' },
              description: 'Roles the skill applies to. Non-empty array of {architect, dev, qa, devops} or the wildcard ["*"].',
            },
            spawnLine: {
              type: 'string',
              description: 'Optional short text injected into the agent spawn-line when this skill is active. Leave unset to use the default spawn-line assembly.',
            },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false).',
            },
          },
          required: ['projectSlug', 'name', 'description', 'content', 'category', 'applicableRoles'],
        },
      },

      // ===== Spawn Lines Tool (P·B·I4) =====
      {
        name: 'haops_get_protocol_spawn_lines',
        description:
          'Returns the per-role spawn-line text (GET /api/projects/[slug]/protocol/spawn-lines). Spawn lines are short boot-ritual strings injected at agent session start when composed protocols are active. Omit `role` to get spawn lines for ALL configured roles; pass a specific role to narrow to one.\n\nRead-only. Requires ENABLE_COMPOSED_PROTOCOLS=true. Returns 404 when the feature flag is off (the route looks absent by design) — surface this as "Composed protocols feature is disabled" to the user.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: {
              type: 'string',
              description: 'URL slug of the target project.',
            },
            role: {
              type: 'string',
              enum: ['architect', 'dev', 'qa', 'devops', 'researcher', 'custom'],
              description: 'Optional. If specified, returns spawn lines only for this role. Omit to get all roles.',
            },
            raw: {
              type: 'boolean',
              description: 'If true, return the raw JSON envelope verbatim (default: false).',
            },
          },
          required: ['projectSlug'],
        },
      },

      // ===== Protocol Preview Tool (P·B·I3) =====
      {
        name: 'haops_preview_project_protocol',
        description:
          'Dry-run the composed-protocol resolver for a project role — returns the assembled manifest as if PUT had been applied, WITHOUT persisting. Use BEFORE haops_update_protocol to verify that the new templateId / skillsConfig combo resolves correctly and has no warnings.\n\nWhen called with no optional params, previews the current protocol settings (useful for a sanity-check without triggering a version bump).\n\nThe response shape mirrors haops_read_protocol (mode, coreContent/body, skillRefs, warnings). The server adds `preview: true` to distinguish the response from a real read.\n\nRequires ENABLE_COMPOSED_PROTOCOLS=true on the server. Returns 404 when the feature flag is off (the route looks absent, by design) — surface this as "Composed protocols feature is disabled" to the user.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: {
              type: 'string',
              description: 'URL slug of the target project (e.g. "fdev", "knf").',
            },
            role: {
              type: 'string',
              enum: ['architect', 'dev', 'qa', 'devops', 'researcher', 'custom'],
              description: 'Agent role to resolve the protocol for.',
            },
            templateId: {
              type: 'string',
              description: 'Optional. UUID of the role template to resolve against. When omitted, the project\'s current templateId is used.',
            },
            enabledSkillIds: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional. UUIDs of skills to enable in the preview (merged with template defaults). Leave unset to use the project\'s current enabledSkillIds.',
            },
            disabledSkillIds: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional. UUIDs of skills to disable in the preview. Leave unset to use the project\'s current disabledSkillIds.',
            },
            customContent: {
              type: 'string',
              description: 'Optional. Custom markdown appended after the template body. Leave unset to use the project\'s current customContent.',
            },
            raw: {
              type: 'boolean',
              description: 'If true, return the raw JSON envelope verbatim instead of the formatted text summary (default: false).',
            },
          },
          required: ['projectSlug', 'role'],
        },
      },

      // ===== Cascade Preview Tools (P·A·I4) =====
      {
        name: 'haops_preview_skill_cascade',
        description:
          "Preview which consumers (role templates, skill packs, project protocols) would need re-wiring if the named skill is bumped via PUT. Read-only — does not mutate. Use BEFORE calling `haops_update_skill({ ..., cascade: true })` on a high-impact skill to estimate blast radius.",
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Kebab-case skill name to preview cascade impact for.',
            },
            scope: {
              type: 'string',
              enum: ['system', 'project'],
              description: 'Scope of the target skill. Required.',
            },
            projectSlug: {
              type: 'string',
              description: 'Project slug — REQUIRED when scope="project"; MUST be omitted when scope="system".',
            },
            raw: {
              type: 'boolean',
              description: 'If true, return the raw JSON envelope verbatim instead of the formatted text summary (default: false).',
            },
          },
          required: ['name', 'scope'],
        },
      },
      {
        name: 'haops_preview_role_template_cascade',
        description:
          "Preview which project protocols would need re-wiring if the named role template is bumped via PUT. Read-only — does not mutate. Use BEFORE calling `haops_update_role_template({ ..., cascade: true })` on a high-impact template to estimate blast radius.",
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Kebab-case role template name to preview cascade impact for.',
            },
            raw: {
              type: 'boolean',
              description: 'If true, return the raw JSON envelope verbatim instead of the formatted text summary (default: false).',
            },
          },
          required: ['name'],
        },
      },

      // ===== Role Template Tools (F2) =====
      {
        name: 'haops_list_role_templates',
        description: 'List agent role templates. A role template bundles a core `baseBody` (boot + scope + handoff markdown) with a set of default skills, and serves as the starting point for an agent role (architect/dev/qa/devops). System templates are seeded; admins may publish project-specific custom templates.',
        inputSchema: {
          type: 'object',
          properties: {
            baseRole: {
              type: 'string',
              enum: ['architect', 'dev', 'qa', 'devops', 'researcher', 'custom'],
              description: 'Filter by base role bucket.',
            },
            search: {
              type: 'string',
              description: 'Free-text search across name + description.',
            },
          },
        },
      },
      {
        name: 'haops_read_role_template',
        description: 'Read a single role template by its kebab-case name. Returns the current version with `baseBody` (full markdown) + `defaultSkills` hydrated (each entry includes skill name + description) + `ID` UUID. Use after haops_list_role_templates to fetch the full template contents.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Kebab-case template name (e.g. "architect", "dev").',
            },
            raw: {
              type: 'boolean',
              description: 'When true, return the full JSON envelope verbatim (includes UUIDs, audit metadata, defaultSkills as structured JSON). Useful for programmatic inspection or piping into other tools.',
            },
          },
          required: ['name'],
        },
      },
      {
        name: 'haops_create_role_template',
        description: 'Create a new agent role template (admin-only, requires composed-protocols feature flag). Templates are system-wide (no project scope) and always start at version=1, isCurrent=true, isSystem=false. `baseBody` is admin-trusted markdown. `defaultSkills` is the optional bundle of skill IDs auto-enabled when projects adopt the template (`required: true` makes the skill non-disable-able). Returns the created template row.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Kebab-case template name (1..100 chars, starts with a letter). Must be unique among current (non-deleted) templates.',
            },
            baseRole: {
              type: 'string',
              enum: ['architect', 'dev', 'qa', 'devops', 'researcher', 'custom'],
              description: 'Base role bucket the template extends.',
            },
            baseBody: {
              type: 'string',
              description: 'Verbatim markdown for the boot/scope/handoff section. Non-empty. Admin-trusted (no sanitization).',
            },
            description: {
              type: 'string',
              description: 'Optional short description shown in lists. Pass null to leave empty.',
            },
            defaultSkills: {
              type: 'array',
              description: 'Optional list of skill references to bundle with this template. Each entry is {skillId, required}. Duplicate skillIds are rejected. UUIDs must reference current, non-deprecated skills.',
              items: {
                type: 'object',
                properties: {
                  skillId: { type: 'string', description: 'UUID of the skill.' },
                  required: {
                    type: 'boolean',
                    description: 'If true, projects cannot disable this skill when adopting the template.',
                  },
                },
                required: ['skillId', 'required'],
              },
            },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['name', 'baseRole', 'baseBody'],
        },
      },
      {
        name: 'haops_update_role_template',
        description: 'Publish a new version of an existing role template (admin-only, requires composed-protocols feature flag). The server flips the current row to isCurrent=false and inserts a new row at version+1, transactionally. Only supply fields you want to change — a no-op call (no diff) returns the current row unchanged with version untouched. `name` and `isSystem` are immutable post-create.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Kebab-case name of the template to update (path identifier).',
            },
            baseRole: {
              type: 'string',
              enum: ['architect', 'dev', 'qa', 'devops', 'researcher', 'custom'],
              description: 'Optional. New base role bucket.',
            },
            baseBody: {
              type: 'string',
              description: 'Optional. New verbatim markdown — must be non-empty when supplied.',
            },
            description: {
              type: 'string',
              description: 'Optional. New short description. Pass null to clear.',
            },
            defaultSkills: {
              type: 'array',
              description: 'Optional. Replacement bundle of skill references (full set, not a diff). UUIDs must reference current, non-deprecated skills.',
              items: {
                type: 'object',
                properties: {
                  skillId: { type: 'string', description: 'UUID of the skill.' },
                  required: { type: 'boolean' },
                },
                required: ['skillId', 'required'],
              },
            },
            cascade: {
              type: 'boolean',
              description: 'When true, atomically re-wires all project protocols pinned to the current template UUID to the NEW UUID in the same DB transaction. Recommended for any system template bump. Default: false.',
            },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['name'],
        },
      },
      {
        name: 'haops_deprecate_role_template',
        description: 'Soft-delete a role template, cascading across ALL versions (admin-only, requires composed-protocols feature flag). System templates (isSystem=true) cannot be deleted and return 403 — to "deprecate" a system template, publish a new version via haops_update_role_template or alter the seeder. Soft-deleted rows remain visible in the history endpoint for audit context.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Kebab-case name of the template to deprecate.',
            },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['name'],
        },
      },

      // ===== Skill Pack Tools (F7) =====
      {
        name: 'haops_list_skill_packs',
        description:
          'List skill packs — curated bundles of agent skills (e.g. helpdesk-pack, security-pack, mobile-pack) that owners adopt at project onboarding. Each pack groups related skill IDs under a category; the onboarding wizard pre-enables them in one click. System packs are seeded and cannot be deleted. Read-only on the MCP surface; mutations go through the web admin.',
        inputSchema: {
          type: 'object',
          properties: {
            featured: {
              type: 'boolean',
              description: 'Only return packs flagged as featured (the curated set surfaced in onboarding by default).',
            },
            category: {
              type: 'string',
              enum: ['helpdesk', 'security', 'mobile', 'testing', 'communication', 'deployment', 'other'],
              description: 'Filter by pack category.',
            },
            search: {
              type: 'string',
              description: 'Free-text search across name + description (case-insensitive).',
            },
          },
        },
      },
      {
        name: 'haops_create_skill_pack',
        description:
          'Create a new skill pack (admin only, requires ENABLE_COMPOSED_PROTOCOLS=true on the server — returns 404 when the flag is off, by design). Body fields mirror POST /api/skill-packs: kebab-case `name` (1..100, leading letter), non-empty `description`, `category` from the SkillPackCategory enum, and an optional `skillIds` array of UUID strings (NOT skill names) referencing current, non-deprecated, system-scope Skill rows. `isFeatured` defaults to false. isSystem is always false here — system packs are seeded (F7-I6), not created via API. Returns the created entity.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Kebab-case pack name, 1..100 chars, must start with a letter (e.g. "helpdesk-pack", "mobile-shipping").',
            },
            description: {
              type: 'string',
              description: 'Human-readable description of what the pack bundles together. Required.',
            },
            category: {
              type: 'string',
              enum: ['helpdesk', 'security', 'mobile', 'testing', 'communication', 'deployment', 'workflow', 'memory', 'other'],
              description: 'Category bucket the pack belongs to (groups packs in the onboarding picker).',
            },
            skillIds: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional array of skill UUIDs (NOT skill names) to bundle in this pack. Each UUID must reference a current, non-deprecated, system-scope Skill row. Defaults to an empty pack if omitted.',
            },
            isFeatured: {
              type: 'boolean',
              description: 'When true, the pack is surfaced in the curated onboarding default set. Defaults to false.',
            },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['name', 'description', 'category'],
        },
      },
      {
        name: 'haops_update_skill_pack',
        description:
          'Update an existing skill pack in place — no version bump (packs are unversioned; audit log captures the diff). Admin only, requires ENABLE_COMPOSED_PROTOCOLS=true. `name` and `isSystem` are immutable post-create. Supply only the fields you want to change; supplying none (or only same-as-current values) is a no-op that returns the current row unchanged (no audit row written). For `skillIds`, the array is a full replacement, not a patch — pass the complete desired set of UUIDs. Returns the updated entity.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Kebab-case name of the pack to update (lookup key).',
            },
            description: {
              type: 'string',
              description: 'New description (non-empty string).',
            },
            category: {
              type: 'string',
              enum: ['helpdesk', 'security', 'mobile', 'testing', 'communication', 'deployment', 'workflow', 'memory', 'other'],
              description: 'New category bucket. Packs can be re-categorised; audit captures old + new.',
            },
            skillIds: {
              type: 'array',
              items: { type: 'string' },
              description: 'Full replacement set of skill UUIDs (NOT a patch). Each must reference a current, non-deprecated, system-scope Skill row.',
            },
            isFeatured: {
              type: 'boolean',
              description: 'New featured flag.',
            },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['name'],
        },
      },
      {
        name: 'haops_deprecate_skill_pack',
        description:
          'Soft-delete (deprecate) a skill pack — paranoid destroy on a single row (packs are unversioned, no cascade). Admin only, requires ENABLE_COMPOSED_PROTOCOLS=true. System packs (isSystem=true) cannot be deleted — the server returns 403; to "deprecate" a system pack, update its skillIds to empty via haops_update_skill_pack instead, or remove the seeder entry in code. Returns the server confirmation message.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Kebab-case name of the pack to deprecate.',
            },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['name'],
        },
      },

      // ===== Lifecycle Transitions (P2·I8) =====
      //
      // One tool per resource type with an `action` enum, rather than 9
      // separate tools (3 actions × 3 resources). This keeps the MCP surface
      // small and makes the available transitions discoverable from the
      // tool's input schema. The Phase 1 deprecate_* tools (which hit DELETE)
      // remain for back-compat — `action: 'deprecate'` here uses the new
      // POST /[name]/deprecate route which versions + state-transitions
      // instead of soft-cascade-deleting.
      {
        name: 'haops_transition_skill',
        description:
          'Transition a skill through its lifecycle (propose / publish / deprecate). Hits POST /api/skills/[name]/[action]. The server enforces the allowed-from-here state machine — on a disallowed transition you get a 409 with `from`, `to`, and the `allowed` set listed in the response. Admin-only, requires ENABLE_COMPOSED_PROTOCOLS=true on the server. For project-scope skills pass scope="project" + projectSlug.\n\nWARNING: The parameter is named `action` (values: propose/publish/deprecate) — NOT `status` or `targetStatus`. The underlying model field is called `status`, but the transition route uses `action` as the URL segment and the tool param name.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Kebab-case skill name to transition.',
            },
            scope: {
              type: 'string',
              enum: ['system', 'project'],
              description: 'Scope of the target skill. "system" omits projectSlug; "project" requires it.',
            },
            action: {
              type: 'string',
              enum: ['propose', 'publish', 'deprecate'],
              description: 'Lifecycle action to perform. Must be one of: "propose" (draft → proposed), "publish" (proposed → published), "deprecate" (published → deprecated). NOTE: this param is named `action`, NOT `status` or `targetStatus`.',
            },
            projectSlug: {
              type: 'string',
              description: 'Project slug — REQUIRED when scope="project"; MUST be omitted when scope="system".',
            },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['name', 'scope', 'action'],
        },
      },
      {
        name: 'haops_transition_role_template',
        description:
          'Transition a role template through its lifecycle (propose / publish / deprecate). Hits POST /api/role-templates/[name]/[action]. Role templates are system-wide — no scope axis. Server enforces the allowed-from-here state machine and returns 409 with `allowed` on a disallowed transition. System templates (isSystem=true) cannot be deprecated (server returns 403). Admin-only, requires ENABLE_COMPOSED_PROTOCOLS=true.\n\nWARNING: The parameter is named `action` (values: propose/publish/deprecate) — NOT `status` or `targetStatus`. The underlying model field is called `status`, but the transition route uses `action` as the URL segment and the tool param name.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Kebab-case name of the role template to transition.',
            },
            action: {
              type: 'string',
              enum: ['propose', 'publish', 'deprecate'],
              description: 'Lifecycle action to perform. Must be one of: "propose" (draft → proposed), "publish" (proposed → published), "deprecate" (published → deprecated). NOTE: this param is named `action`, NOT `status` or `targetStatus`.',
            },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['name', 'action'],
        },
      },
      {
        name: 'haops_transition_skill_pack',
        description:
          'Transition a skill pack through its lifecycle (propose / publish / deprecate). Hits POST /api/skill-packs/[name]/[action]. Packs are unversioned and system-wide. Server enforces the allowed-from-here state machine and returns 409 with `allowed` on a disallowed transition. System packs (isSystem=true) cannot be deprecated (server returns 403 — update skillIds to [] via haops_update_skill_pack instead). Admin-only, requires ENABLE_COMPOSED_PROTOCOLS=true.\n\nWARNING: The parameter is named `action` (values: propose/publish/deprecate) — NOT `status` or `targetStatus`. The underlying model field is called `status`, but the transition route uses `action` as the URL segment and the tool param name.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Kebab-case name of the skill pack to transition.',
            },
            action: {
              type: 'string',
              enum: ['propose', 'publish', 'deprecate'],
              description: 'Lifecycle action to perform. Must be one of: "propose" (draft → proposed), "publish" (proposed → published), "deprecate" (published → deprecated). NOTE: this param is named `action`, NOT `status` or `targetStatus`.',
            },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['name', 'action'],
        },
      },

      // ===== Testing MCP Tools =====

      {
        name: 'haops_report_test_run',
        description: 'Report test results to HAOps. Creates a TestRun with individual TestResult records. Used by agents to manually report results (Jest/Playwright reporters do this automatically).',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: { type: 'string', description: 'The project slug (URL identifier)' },
            runner: { type: 'string', enum: ['jest', 'playwright', 'manual', 'other'], description: 'Test runner that produced results' },
            environment: { type: 'string', enum: ['localhost', 'production', 'ci', 'other'], description: 'Environment where tests ran (optional)' },
            commitSha: { type: 'string', description: 'Git commit SHA (optional)' },
            branch: { type: 'string', description: 'Git branch name (optional)' },
            summary: {
              type: 'object',
              description: 'Summary counts',
              properties: {
                total: { type: 'number' },
                passed: { type: 'number' },
                failed: { type: 'number' },
                skipped: { type: 'number' },
                durationMs: { type: 'number' },
              },
              required: ['total', 'passed', 'failed', 'skipped', 'durationMs'],
            },
            results: {
              type: 'array',
              description: 'Individual test results',
              items: {
                type: 'object',
                properties: {
                  testName: { type: 'string' },
                  filePath: { type: 'string' },
                  status: { type: 'string', enum: ['passed', 'failed', 'skipped', 'error'] },
                  durationMs: { type: 'number' },
                  errorMessage: { type: 'string' },
                },
                required: ['testName', 'filePath', 'status'],
              },
            },
            coverage: {
              type: 'object',
              description: 'Coverage percentages (optional)',
              properties: {
                lines: { type: 'number' },
                branches: { type: 'number' },
                functions: { type: 'number' },
              },
            },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['projectSlug', 'runner', 'summary', 'results'],
        },
      },
      {
        name: 'haops_get_test_health',
        description: 'Get aggregated test health summary for a project or specific entity. Returns pass rates, trend, recent failures, and coverage data.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: { type: 'string', description: 'The project slug (URL identifier)' },
            entityType: { type: 'string', enum: ['Module', 'Feature', 'Issue'], description: 'Filter by entity type (optional)' },
            entityId: { type: 'string', description: 'UUID of the entity to filter by (optional)' },
          },
          required: ['projectSlug'],
        },
      },
      {
        name: 'haops_list_tests',
        description: 'List tests in a project with optional filters. Returns test records with metadata.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: { type: 'string', description: 'The project slug (URL identifier)' },
            type: { type: 'string', enum: ['unit', 'integration', 'performance', 'e2e'], description: 'Filter by test type (optional)' },
            runner: { type: 'string', enum: ['jest', 'playwright', 'manual', 'generic'], description: 'Filter by test runner (optional)' },
            suiteId: { type: 'string', description: 'Filter by test suite UUID (optional)' },
            entityType: { type: 'string', enum: ['Module', 'Feature', 'Issue'], description: 'Filter by linked entity type (optional)' },
            entityId: { type: 'string', description: 'Filter by linked entity UUID (optional)' },
            limit: { type: 'number', description: 'Max results (default 50)' },
          },
          required: ['projectSlug'],
        },
      },
      {
        name: 'haops_list_test_runs',
        description: 'List recent test runs for a project. Returns run summaries with pass/fail counts.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: { type: 'string', description: 'The project slug (URL identifier)' },
            runner: { type: 'string', enum: ['jest', 'playwright', 'manual', 'other'], description: 'Filter by runner (optional)' },
            environment: { type: 'string', enum: ['localhost', 'production', 'ci', 'other'], description: 'Filter by environment (optional)' },
            limit: { type: 'number', description: 'Max results (default 20)' },
          },
          required: ['projectSlug'],
        },
      },
      {
        name: 'haops_link_tests_to_entity',
        description: 'Link tests to a module, feature, or issue by test IDs or file path pattern. Sets testableType and testableId on matching tests.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: { type: 'string', description: 'The project slug (URL identifier)' },
            entityType: { type: 'string', enum: ['Module', 'Feature', 'Issue'], description: 'Entity type to link tests to' },
            entityId: { type: 'string', description: 'UUID of the entity' },
            testIds: { type: 'array', items: { type: 'string' }, description: 'Explicit test UUIDs to link (optional)' },
            filePathPattern: { type: 'string', description: 'Glob pattern for file paths, e.g. "tests/e2e/auth/*" (optional)' },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['projectSlug', 'entityType', 'entityId'],
        },
      },
      {
        name: 'haops_list_test_suites',
        description: 'List test suites for a project.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: { type: 'string', description: 'The project slug (URL identifier)' },
          },
          required: ['projectSlug'],
        },
      },
      {
        name: 'haops_export_test_suite',
        description: 'Export a test suite as a JSON bundle for cross-project sharing. Includes suite config and all test definitions.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: { type: 'string', description: 'The project slug (URL identifier)' },
            suiteId: { type: 'string', description: 'UUID of the test suite to export' },
          },
          required: ['projectSlug', 'suiteId'],
        },
      },
      {
        name: 'haops_import_test_suite',
        description: 'Import a test suite from a JSON bundle into a project. Creates new suite and test records with fresh UUIDs.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: { type: 'string', description: 'The project slug (URL identifier)' },
            bundle: {
              type: 'object',
              description: 'The exported suite bundle (from haops_export_test_suite)',
              properties: {
                suite: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    description: { type: 'string' },
                    config: { type: 'object' },
                  },
                  required: ['name'],
                },
                tests: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      filePath: { type: 'string' },
                      type: { type: 'string' },
                      runner: { type: 'string' },
                      definition: { type: 'object' },
                      envRequirements: { type: 'array', items: { type: 'string' } },
                    },
                    required: ['name', 'filePath'],
                  },
                },
                sourceProject: { type: 'string' },
              },
              required: ['suite', 'tests'],
            },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['projectSlug', 'bundle'],
        },
      },

      // ===== Git MCP Tools =====

      {
        name: 'haops_git_list_files',
        description: 'List files and directories in a project\'s Git repository at a given path. Returns directory entries with type (file/dir), name, and SHA. Supports multi-repo projects via repositoryName.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: { type: 'string', description: 'The project slug (URL identifier)' },
            path: { type: 'string', description: 'Directory path (default: root)' },
            ref: { type: 'string', description: 'Git ref/branch (default: main)' },
            repositoryName: { type: 'string', description: 'Repository name for multi-repo projects (default: first/main repo)' },
          },
          required: ['projectSlug'],
        },
      },
      {
        name: 'haops_git_read_file',
        description: 'Read file content from a project\'s Git repository. Returns text content for text files, or a "binary file" message for binary files. Supports multi-repo projects via repositoryName.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: { type: 'string', description: 'The project slug (URL identifier)' },
            filePath: { type: 'string', description: 'File path in repository' },
            ref: { type: 'string', description: 'Git ref/branch (default: main)' },
            repositoryName: { type: 'string', description: 'Repository name for multi-repo projects (default: first/main repo)' },
          },
          required: ['projectSlug', 'filePath'],
        },
      },
      {
        name: 'haops_git_commit_log',
        description: 'Get recent commit history from a project\'s Git repository. Returns commits with SHA, author, date, and message. Supports multi-repo projects via repositoryName.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: { type: 'string', description: 'The project slug (URL identifier)' },
            limit: { type: 'number', description: 'Number of commits (default: 20, max: 100)' },
            ref: { type: 'string', description: 'Git ref/branch (default: main)' },
            path: { type: 'string', description: 'Filter commits by file/directory path' },
            repositoryName: { type: 'string', description: 'Repository name for multi-repo projects (default: first/main repo)' },
          },
          required: ['projectSlug'],
        },
      },
      {
        name: 'haops_git_get_remote_url',
        description: 'Get SSH remote URL and setup instructions for pushing to HAOps Git. Returns the SSH URL, default branch, and copy-pasteable setup commands. Supports multi-repo projects via repositoryName.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: { type: 'string', description: 'The project slug (URL identifier)' },
            repositoryName: { type: 'string', description: 'Repository name for multi-repo projects (default: first/main repo)' },
          },
          required: ['projectSlug'],
        },
      },
      {
        name: 'haops_manage_ssh_keys',
        description: 'Manage SSH keys for HAOps Git access (list, add, or revoke). Agents can use this to self-service their SSH keys for git push access.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['list', 'add', 'revoke'],
              description: 'Action to perform',
            },
            name: {
              type: 'string',
              description: 'Key name (required for add)',
            },
            publicKey: {
              type: 'string',
              description: 'SSH public key content (required for add)',
            },
            keyId: {
              type: 'string',
              description: 'Key UUID to revoke (required for revoke)',
            },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['action'],
        },
      },
      // ===== Merge Requests =====
      {
        name: 'haops_create_merge_request',
        description: 'Create a merge request in a HAOps Git repository. Auto-detects conflicts and snapshots commit SHAs. Returns the created MR with status, conflict info, and diff stats.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: { type: 'string', description: 'The project slug (URL identifier)' },
            repositoryName: { type: 'string', description: 'Repository name for multi-repo projects (default: first/main repo)' },
            sourceBranch: { type: 'string', description: 'Source branch to merge from' },
            targetBranch: { type: 'string', description: 'Target branch to merge into' },
            title: { type: 'string', description: 'MR title (max 255 chars)' },
            description: { type: 'string', description: 'MR description (optional)' },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['projectSlug', 'sourceBranch', 'targetBranch', 'title'],
        },
      },
      {
        name: 'haops_get_merge_request',
        description: 'Get merge request detail including diff stats, reviews with verdicts, conflict status, and branch info. Use this to review an MR before approving or merging.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: { type: 'string', description: 'The project slug (URL identifier)' },
            mergeRequestId: { type: 'string', description: 'MR UUID' },
          },
          required: ['projectSlug', 'mergeRequestId'],
        },
      },
      {
        name: 'haops_list_merge_requests',
        description: 'List merge requests for a project with optional filters. Returns MR title, status, branches, author, and timestamps.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: { type: 'string', description: 'The project slug (URL identifier)' },
            repositoryName: { type: 'string', description: 'Filter by repository name' },
            status: { type: 'string', enum: ['draft', 'open', 'approved', 'merged', 'closed'], description: 'Filter by MR status' },
            targetBranch: { type: 'string', description: 'Filter by target branch' },
            limit: { type: 'number', description: 'Max results (default: 20)' },
          },
          required: ['projectSlug'],
        },
      },
      {
        name: 'haops_review_merge_request',
        description: 'Submit a review on a merge request. Verdicts: approved, changes_requested, commented. When enough approvals are met (per branch protection rules), MR status auto-transitions to approved.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: { type: 'string', description: 'The project slug (URL identifier)' },
            mergeRequestId: { type: 'string', description: 'MR UUID' },
            verdict: { type: 'string', enum: ['approved', 'changes_requested', 'commented'], description: 'Review verdict' },
            body: { type: 'string', description: 'Review comment (optional)' },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['projectSlug', 'mergeRequestId', 'verdict'],
        },
      },
      {
        name: 'haops_merge_merge_request',
        description: 'Merge an approved merge request. Checks branch protection rules (required approvals, allowed roles) and conflicts before merging. Supports fast-forward and three-way merge.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: { type: 'string', description: 'The project slug (URL identifier)' },
            mergeRequestId: { type: 'string', description: 'MR UUID' },
            deleteSourceBranch: { type: 'boolean', description: 'Delete source branch after merge (default: false)' },
            mergeCommitMessage: { type: 'string', description: 'Custom merge commit message (optional)' },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['projectSlug', 'mergeRequestId'],
        },
      },
      {
        name: 'haops_get_branch_diff',
        description: 'Compare two branches in a HAOps Git repository. Returns commits ahead/behind, changed files with stats, diff content, and conflict detection. Use before creating an MR to preview changes.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: { type: 'string', description: 'The project slug (URL identifier)' },
            repositoryName: { type: 'string', description: 'Repository name for multi-repo projects (default: first/main repo)' },
            sourceBranch: { type: 'string', description: 'Source branch' },
            targetBranch: { type: 'string', description: 'Target branch' },
          },
          required: ['projectSlug', 'sourceBranch', 'targetBranch'],
        },
      },
      // ===== Distribution & Updates =====
      {
        name: 'haops_list_updates',
        description: 'List available updates for a project. Shows update type, version, status, and date. Use to check for new MCP server versions, protocol changes, test suites, or onboarding templates.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: {
              type: 'string',
              description: 'The project slug (URL identifier)',
            },
            updateType: {
              type: 'string',
              enum: ['mcp_server', 'protocol', 'test_suite', 'onboarding_templates'],
              description: 'Filter by update type (optional)',
            },
            status: {
              type: 'string',
              enum: ['available', 'downloaded', 'applied', 'dismissed'],
              description: 'Filter by status (optional)',
            },
          },
          required: ['projectSlug'],
        },
      },
      {
        name: 'haops_download_update',
        description: 'Download/view an update artifact. For protocols: returns content directly as JSON. For MCP server: returns download instructions with path and size.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: {
              type: 'string',
              description: 'The project slug (URL identifier)',
            },
            updateId: {
              type: 'string',
              description: 'UUID of the update to download',
            },
          },
          required: ['projectSlug', 'updateId'],
        },
      },
      // ===== Image Uploads =====
      {
        name: 'haops_upload_doc_image',
        description: 'Upload an image to a documentation section. Accepts base64-encoded image data. Returns the attachment record with a URL for embedding in content.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: { type: 'string', description: 'The project slug (URL identifier)' },
            artifactSlug: { type: 'string', description: 'The doc artifact slug' },
            sectionSlug: { type: 'string', description: 'The doc section slug' },
            imageBase64: { type: 'string', description: 'Base64-encoded image data' },
            filename: { type: 'string', description: 'Filename with extension (e.g. screenshot.png)' },
            mimeType: {
              type: 'string',
              description: 'Image MIME type',
              enum: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'],
            },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['projectSlug', 'artifactSlug', 'sectionSlug', 'imageBase64', 'filename', 'mimeType'],
        },
      },
      {
        name: 'haops_upload_help_image',
        description: 'Upload an image to a help article. Accepts base64-encoded image data. Admin-only. Returns the attachment record with a URL for embedding in content.',
        inputSchema: {
          type: 'object',
          properties: {
            articleSlug: { type: 'string', description: 'The help article slug' },
            imageBase64: { type: 'string', description: 'Base64-encoded image data' },
            filename: { type: 'string', description: 'Filename with extension (e.g. screenshot.png)' },
            mimeType: {
              type: 'string',
              description: 'Image MIME type',
              enum: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'],
            },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['articleSlug', 'imageBase64', 'filename', 'mimeType'],
        },
      },
      // ===== Work Hierarchy — List & Get =====
      {
        name: 'haops_list_modules',
        description: 'List modules in a HAOps project with optional filters. Returns module ID, title, status, priority, owner, and feature count. Use this to discover module UUIDs.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: { type: 'string', description: 'The project slug (URL identifier)' },
            status: { type: 'string', enum: ['backlog', 'in-progress', 'review', 'done', 'blocked', 'on-hold', 'cancelled'], description: 'Filter by status (optional)' },
            priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: 'Filter by priority (optional)' },
            ownerId: { type: 'string', description: 'Filter by owner UUID (optional)' },
            page: { type: 'number', description: 'Page number (default: 1)' },
            limit: { type: 'number', description: 'Results per page (default: 25, max: 100)' },
          },
          required: ['projectSlug'],
        },
      },
      {
        name: 'haops_get_module',
        description: 'Get full details for a single module including title, status, priority, notes, dates, owner, and child features.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: { type: 'string', description: 'The project slug (URL identifier)' },
            moduleId: { type: 'string', description: 'UUID of the module' },
          },
          required: ['projectSlug', 'moduleId'],
        },
      },
      {
        name: 'haops_list_features',
        description: 'List features in a HAOps project with optional filters. Can filter by moduleId to get features for a specific module. Returns feature ID, title, status, priority, owner, module, and issue count.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: { type: 'string', description: 'The project slug (URL identifier)' },
            moduleId: { type: 'string', description: 'Filter by parent module UUID (optional)' },
            status: { type: 'string', enum: ['backlog', 'in-progress', 'review', 'done', 'blocked', 'on-hold', 'cancelled'], description: 'Filter by status (optional)' },
            priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: 'Filter by priority (optional)' },
            page: { type: 'number', description: 'Page number (default: 1)' },
            limit: { type: 'number', description: 'Results per page (default: 25, max: 100)' },
          },
          required: ['projectSlug'],
        },
      },
      {
        name: 'haops_get_feature',
        description: 'Get full details for a single feature including title, status, priority, notes, dates, owner, parent module, and child issues.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: { type: 'string', description: 'The project slug (URL identifier)' },
            featureId: { type: 'string', description: 'UUID of the feature' },
          },
          required: ['projectSlug', 'featureId'],
        },
      },
      {
        name: 'haops_list_issues',
        description: 'List issues in a HAOps project with optional filters. Can filter by featureId, type, status, priority, and assignee. Returns issue ID, title, status, priority, type, assignee, feature, and dates.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: { type: 'string', description: 'The project slug (URL identifier)' },
            featureId: { type: 'string', description: 'Filter by parent feature UUID (optional)' },
            status: { type: 'string', enum: ['backlog', 'in-progress', 'review', 'done', 'blocked', 'on-hold', 'cancelled'], description: 'Filter by status (optional)' },
            priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: 'Filter by priority (optional)' },
            type: { type: 'string', enum: ['feature', 'bug', 'task', 'improvement', 'documentation'], description: 'Filter by issue type (optional)' },
            assignedTo: { type: 'string', description: 'Filter by assignee UUID (optional)' },
            page: { type: 'number', description: 'Page number (default: 1)' },
            limit: { type: 'number', description: 'Results per page (default: 25, max: 100)' },
          },
          required: ['projectSlug'],
        },
      },
      {
        name: 'haops_get_issue',
        description: 'Get full details for a single issue including title, type, status, priority, notes, points, dates, assignee, and parent feature.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: { type: 'string', description: 'The project slug (URL identifier)' },
            issueId: { type: 'string', description: 'UUID of the issue' },
          },
          required: ['projectSlug', 'issueId'],
        },
      },
      // ===== Teamwork Views =====
      {
        name: 'haops_get_structured_view',
        description: 'Get a structured (nested) view of the project work hierarchy with optional filters. Returns Module→Feature→Issue tree, pre-organized for display.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: { type: 'string', description: 'The project slug (URL identifier)' },
            type: { type: 'string', enum: ['all', 'modules', 'features', 'issues'], description: 'Entity type filter (default: all)' },
            assignee: { type: 'string', description: 'Filter by assignee UUID, or "all" (default: all)' },
            status: { type: 'string', description: 'Filter by status value, or "all" (default: all)' },
          },
          required: ['projectSlug'],
        },
      },
      // ===== Notifications =====
      {
        name: 'haops_list_notifications',
        description: 'List notifications for the authenticated user/agent. Returns paginated notifications with unread count.',
        inputSchema: {
          type: 'object',
          properties: {
            page: { type: 'number', description: 'Page number (default: 1)' },
            limit: { type: 'number', description: 'Results per page (default: 20)' },
          },
          required: [],
        },
      },
      {
        name: 'haops_mark_notification_read',
        description: 'Mark a specific notification as read.',
        inputSchema: {
          type: 'object',
          properties: {
            notificationId: { type: 'string', description: 'UUID of the notification to mark as read' },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['notificationId'],
        },
      },
      // ===== Search & Code Review =====
      {
        name: 'haops_search_discussion',
        description: 'Search messages within a specific discussion thread. Returns matching messages for the given query.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: { type: 'string', description: 'The project slug (URL identifier)' },
            discussionId: { type: 'string', description: 'UUID of the discussion to search' },
            query: { type: 'string', description: 'Search query string' },
          },
          required: ['projectSlug', 'discussionId', 'query'],
        },
      },
      {
        name: 'haops_git_commit_diff',
        description: 'Get the diff output for a specific git commit. Essential for code review — shows exactly what changed in a commit.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: { type: 'string', description: 'The project slug (URL identifier)' },
            sha: { type: 'string', description: 'Git commit SHA' },
            repositoryName: { type: 'string', description: 'Repository name for multi-repo projects (optional)' },
          },
          required: ['projectSlug', 'sha'],
        },
      },
      // ===== Channel Management =====
      {
        name: 'haops_create_channel',
        description: 'Create a new channel in a HAOps project.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: { type: 'string', description: 'The project slug (URL identifier)' },
            name: { type: 'string', description: 'Channel name' },
            description: { type: 'string', description: 'Channel description (optional)' },
            type: { type: 'string', enum: ['general', 'announcements', 'dev', 'custom'], description: 'Channel type (optional, default: custom)' },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['projectSlug', 'name'],
        },
      },
      {
        name: 'haops_update_channel',
        description: 'Update an existing channel in a HAOps project.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: { type: 'string', description: 'The project slug (URL identifier)' },
            channelId: { type: 'string', description: 'UUID of the channel to update' },
            name: { type: 'string', description: 'New channel name (optional)' },
            description: { type: 'string', description: 'New channel description (optional)' },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['projectSlug', 'channelId'],
        },
      },
      {
        name: 'haops_delete_channel',
        description: 'Delete a channel from a HAOps project. This will also delete all discussions in the channel.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: { type: 'string', description: 'The project slug (URL identifier)' },
            channelId: { type: 'string', description: 'UUID of the channel to delete' },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['projectSlug', 'channelId'],
        },
      },
      // ===== Message Actions =====
      {
        name: 'haops_react_to_message',
        description: 'Add or toggle an emoji reaction on a discussion message.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: { type: 'string', description: 'The project slug (URL identifier)' },
            discussionId: { type: 'string', description: 'UUID of the discussion' },
            messageId: { type: 'string', description: 'UUID of the message to react to' },
            emoji: { type: 'string', description: 'Emoji to react with (e.g. "👍", "🎉")' },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['projectSlug', 'discussionId', 'messageId', 'emoji'],
        },
      },
      {
        name: 'haops_pin_message',
        description: 'Pin or unpin a discussion message.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: { type: 'string', description: 'The project slug (URL identifier)' },
            discussionId: { type: 'string', description: 'UUID of the discussion' },
            messageId: { type: 'string', description: 'UUID of the message to pin/unpin' },
            pinned: { type: 'boolean', description: 'true to pin, false to unpin' },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['projectSlug', 'discussionId', 'messageId', 'pinned'],
        },
      },
      // ===== Merge Request Lifecycle =====
      {
        name: 'haops_close_merge_request',
        description: 'Close a merge request without merging. Sets status to "closed".',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: { type: 'string', description: 'The project slug (URL identifier)' },
            mergeRequestId: { type: 'string', description: 'UUID of the merge request to close' },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['projectSlug', 'mergeRequestId'],
        },
      },
      {
        name: 'haops_reopen_merge_request',
        description: 'Reopen a previously closed merge request. Sets status back to "open".',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: { type: 'string', description: 'The project slug (URL identifier)' },
            mergeRequestId: { type: 'string', description: 'UUID of the merge request to reopen' },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['projectSlug', 'mergeRequestId'],
        },
      },
      // ===== Doc Builder Management =====
      {
        name: 'haops_list_doc_sections',
        description: 'List all sections in a documentation artifact. Returns section hierarchy with titles, slugs, and order.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: { type: 'string', description: 'The project slug (URL identifier)' },
            artifactSlug: { type: 'string', description: 'The doc artifact slug' },
          },
          required: ['projectSlug', 'artifactSlug'],
        },
      },
      {
        name: 'haops_delete_doc_section',
        description: 'Delete a section from a documentation artifact.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: { type: 'string', description: 'The project slug (URL identifier)' },
            artifactSlug: { type: 'string', description: 'The doc artifact slug' },
            sectionSlug: { type: 'string', description: 'The section slug to delete' },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['projectSlug', 'artifactSlug', 'sectionSlug'],
        },
      },
      {
        name: 'haops_delete_doc_artifact',
        description: 'Delete a documentation artifact and all its sections.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: { type: 'string', description: 'The project slug (URL identifier)' },
            artifactSlug: { type: 'string', description: 'The doc artifact slug to delete' },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['projectSlug', 'artifactSlug'],
        },
      },
      {
        name: 'haops_generate_changelog',
        description: 'Generate a changelog from audit logs for a project. Returns structured changelog content.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: { type: 'string', description: 'The project slug (URL identifier)' },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['projectSlug'],
        },
      },
      // ===== Help Center Extras =====
      {
        name: 'haops_search_help',
        description: 'Search help articles by keyword. Returns matching articles with titles and snippets.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query string' },
          },
          required: ['query'],
        },
      },
      {
        name: 'haops_delete_help_section',
        description: 'Delete a help center section and all its articles. Admin-only.',
        inputSchema: {
          type: 'object',
          properties: {
            sectionSlug: { type: 'string', description: 'The help section slug to delete' },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['sectionSlug'],
        },
      },
      {
        name: 'haops_delete_help_article',
        description: 'Delete a help article. Admin-only.',
        inputSchema: {
          type: 'object',
          properties: {
            articleSlug: { type: 'string', description: 'The help article slug to delete' },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['articleSlug'],
        },
      },
      // ===== Repository Management =====
      {
        name: 'haops_manage_repositories',
        description: 'Manage Git repositories for a HAOps project (list, get, create, update, delete). HAOps supports multiple repositories per project.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: { type: 'string', description: 'The project slug (URL identifier)' },
            action: { type: 'string', enum: ['list', 'get', 'create', 'update', 'delete'], description: 'Action to perform' },
            repositoryId: { type: 'string', description: 'Repository UUID (required for get, update, delete)' },
            name: { type: 'string', description: 'Repository name (required for create, optional for update)' },
            description: { type: 'string', description: 'Repository description (optional for create/update)' },
            defaultBranch: { type: 'string', description: 'Default branch name (optional for create/update)' },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['projectSlug', 'action'],
        },
      },

      // ===== Helpdesk Tools =====
      {
        name: 'haops_list_tickets',
        description: 'List helpdesk support tickets for a project with optional filters. Returns paginated results.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: { type: 'string', description: 'The project slug (URL identifier)' },
            status: { type: 'string', enum: ['open', 'pending', 'in-progress', 'waiting-customer', 'resolved', 'closed'], description: 'Filter by ticket status' },
            priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'], description: 'Filter by priority' },
            assignedTo: { type: 'string', description: 'Filter by assignee user UUID' },
            category: { type: 'string', description: 'Filter by ticket category' },
            search: { type: 'string', description: 'Search query (searches subject and description)' },
            page: { type: 'number', description: 'Page number (default: 1)' },
            limit: { type: 'number', description: 'Results per page (default: 20, max: 100)' },
          },
          required: ['projectSlug'],
        },
      },
      {
        name: 'haops_get_ticket',
        description: 'Get a helpdesk ticket by ID, including full conversation timeline (inbound, outbound, internal messages).',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: { type: 'string', description: 'The project slug (URL identifier)' },
            ticketId: { type: 'string', description: 'Ticket UUID' },
          },
          required: ['projectSlug', 'ticketId'],
        },
      },
      {
        name: 'haops_create_ticket',
        description: 'Manually create a helpdesk ticket on behalf of a requester (e.g. from an agent, not via public form).',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: { type: 'string', description: 'The project slug (URL identifier)' },
            subject: { type: 'string', description: 'Ticket subject / title' },
            content: { type: 'string', description: 'Initial message content describing the issue (creates the first ticket message)' },
            requesterEmail: { type: 'string', description: 'Email address of the requester (customer)' },
            requesterName: { type: 'string', description: 'Display name of the requester' },
            priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'], description: 'Ticket priority (default: medium)' },
            category: { type: 'string', description: 'Ticket category (must match project helpdesk categories)' },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['projectSlug', 'subject', 'content', 'requesterEmail'],
        },
      },
      {
        name: 'haops_update_ticket',
        description: 'Update helpdesk ticket fields (status, priority, category, assignee, tags). Used for triage and management.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: { type: 'string', description: 'The project slug (URL identifier)' },
            ticketId: { type: 'string', description: 'Ticket UUID' },
            status: { type: 'string', enum: ['open', 'pending', 'in-progress', 'waiting-customer', 'resolved', 'closed'], description: 'New ticket status' },
            priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'], description: 'New priority level' },
            category: { type: 'string', description: 'Ticket category' },
            assignedToId: { type: 'string', description: 'Assignee user UUID' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Array of tag strings to set on the ticket' },
            language: { type: 'string', enum: ['bg', 'en'], description: 'Ticket language for email templates (bg or en)' },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['projectSlug', 'ticketId'],
        },
      },
      {
        name: 'haops_reply_ticket',
        description: 'Send a reply or internal note on a helpdesk ticket. direction=outbound sends an email to the requester; direction=internal creates a private team note (not visible to customer).',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: { type: 'string', description: 'The project slug (URL identifier)' },
            ticketId: { type: 'string', description: 'Ticket UUID' },
            content: { type: 'string', description: 'Message content (plain text or markdown)' },
            direction: { type: 'string', enum: ['outbound', 'internal'], description: 'outbound = email sent to requester; internal = private team note only' },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['projectSlug', 'ticketId', 'content', 'direction'],
        },
      },
      {
        name: 'haops_claim_ticket',
        description: 'Claim or unclaim a helpdesk ticket. Claiming marks it as in-progress and assigns takenBy fields.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: { type: 'string', description: 'The project slug (URL identifier)' },
            ticketId: { type: 'string', description: 'Ticket UUID' },
            action: { type: 'string', enum: ['claim', 'unclaim'], description: 'Action to perform (default: claim)' },
            force: { type: 'boolean', description: 'Force-claim even if already claimed by another user (PM+ only, default: false)' },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['projectSlug', 'ticketId'],
        },
      },
      {
        name: 'haops_close_ticket',
        description: 'Resolve or close a helpdesk ticket, optionally sending a final message to the requester. Sends resolution/closure email to requester if message is provided.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: { type: 'string', description: 'The project slug (URL identifier)' },
            ticketId: { type: 'string', description: 'Ticket UUID' },
            status: { type: 'string', enum: ['resolved', 'closed'], description: 'resolved = fixed, waiting for confirmation; closed = fully closed' },
            resolutionNote: { type: 'string', description: 'Optional resolution note included in the email sent to the requester when status is \'resolved\'.' },
            verbose: {
              type: 'boolean',
              description: 'If true, return the full API response instead of the compact summary (default: false)',
            },
          },
          required: ['projectSlug', 'ticketId', 'status'],
        },
      },
      {
        name: 'haops_rag_query',
        description: 'Hybrid BM25+vector retrieval over a HAOps project corpus. Returns top-K chunks with entity citations. Example: { projectSlug: "fdev", text: "F4 manifest cache", topK: 5 }',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: { type: 'string', description: 'The project slug (URL identifier) of the project to query' },
            text: { type: 'string', description: 'Search query text (1–4096 chars)' },
            topK: { type: 'number', description: 'Maximum chunks to return (1–50, default 8)' },
            entityTypes: {
              type: 'array',
              items: { type: 'string' },
              description: 'Filter by entity types (e.g. ["feature", "module", "issue"]). Omit for all types.',
            },
            mode: {
              type: 'string',
              enum: ['hybrid', 'vector', 'bm25'],
              description: 'Retrieval mode: "hybrid" (default, BM25+vector RRF), "vector" (dense only), "bm25" (keyword only)',
            },
            format: {
              type: 'string',
              enum: ['compact', 'ui'],
              description: '"compact" (default) returns text+entityUrl+score; "ui" adds scoreComponents breakdown',
            },
          },
          required: ['projectSlug', 'text'],
        },
      },
      {
        name: 'haops_discover',
        description: [
          'Metadata-index discovery (ADR-029 P2b): find which doc sections cover a topic BEFORE reading full bodies.',
          '',
          'PRIMARY USAGE — filter by scope then pinpoint:',
          '  1. relevantTo (controlled vocab) — SCOPE filter: narrows to sections tagged for your role/task.',
          '     Roles:      architect | dev | qa | devops',
          '     Task-types: rag | helpdesk | auth | mobile | git | testing | memory | deploy |',
          '                 docs | notifications | livekit | email | distribution | communication',
          '     Pass one or several values; sections matching ANY value are returned.',
          '  2. q (free text, case-insensitive, forgiving) — PINPOINT filter: searched over title + summary.',
          '     Combine with relevantTo for best results.',
          '',
          'SECONDARY USAGE — exact tag match (brittle, prefer relevantTo):',
          '  covers — exact agentMetadata.covers tag match (e.g. "auth-and-roles"). Fails silently if tag',
          '           is misspelled or not yet indexed. Use only when you know the exact tag.',
          '',
          'RETURNS thin rows per matching doc section:',
          '  { entityType, entityId, title, summary, covers, relevantTo, sectionStatus, stale }',
          'Feed entityId into haops_get_doc_section to retrieve the full body.',
          '',
          'Example — find RAG-related docs scoped to dev role:',
          '  { projectSlug: "fdev", relevantTo: ["rag", "dev"], q: "metadata index" }',
        ].join('\n'),
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: {
              type: 'string',
              description: 'The project slug (URL identifier)',
            },
            relevantTo: {
              type: 'array',
              items: { type: 'string' },
              description: 'Scope filter — controlled vocab: roles (architect/dev/qa/devops) + task-types (rag/helpdesk/auth/mobile/git/testing/memory/deploy/docs/notifications/livekit/email/distribution/communication). Sections matching ANY value are returned.',
            },
            q: {
              type: 'string',
              description: 'Free-text search over title + summary (case-insensitive, max 512 chars). Combine with relevantTo for precision.',
            },
            covers: {
              type: 'array',
              items: { type: 'string' },
              description: 'Exact agentMetadata.covers tag filter (brittle — fails silently if tag is wrong). Use relevantTo + q instead when possible.',
            },
            entityTypes: {
              type: 'array',
              items: { type: 'string' },
              description: 'Entity types to search. Default: ["doc_section"]. Reserved for future extension.',
            },
            limit: {
              type: 'number',
              description: 'Maximum results to return (1–200, default 25).',
            },
          },
          required: ['projectSlug'],
        },
      },
    ],
  };
});

/**
 * Execute a tool
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // Telemetry wrapper — executes the inner handler then records bytes
  // fire-and-forget after the response is ready.
  const _runTool = async (): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> => {

  if (name === 'haops_list_projects') {
    try {
      const projects = await apiClient.listProjects();
      return {
        content: [{ type: 'text', text: JSON.stringify(projects, null, 2) }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
      };
    }
  }

  if (name === 'haops_create_module') {
    try {
      const {
        projectSlug,
        title,
        description,
        notes,
        ownerId,
        status,
        priority,
        startDate,
        targetDate,
      } = args as {
        projectSlug: string;
        title: string;
        description?: string;
        notes?: string;
        ownerId: string;
        status?: string;
        priority?: string;
        startDate?: string;
        targetDate?: string;
      };

      // Build the request payload - only include defined fields
      const moduleData: Omit<CreateModuleRequest, 'projectId'> = {
        title,
        ownerId,
      };

      if (description !== undefined) moduleData.description = description;
      if (notes !== undefined) moduleData.notes = notes;
      if (status !== undefined) moduleData.status = status as CreateModuleRequest['status'];
      if (priority !== undefined) moduleData.priority = priority as CreateModuleRequest['priority'];
      if (startDate !== undefined) moduleData.startDate = startDate;
      if (targetDate !== undefined) moduleData.targetDate = targetDate;

      const module = await apiClient.createModule(projectSlug, moduleData);
      const { verbose } = args as { verbose?: boolean };
      return { content: [{ type: 'text', text: formatWriteResult('created', module as unknown as Record<string, unknown>, !!verbose) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error creating module: ${message}` }],
        isError: true,
      };
    }
  }

  if (name === 'haops_update_module') {
    try {
      const {
        moduleId,
        title,
        description,
        notes,
        ownerId,
        status,
        priority,
        startDate,
        targetDate,
      } = args as {
        moduleId: string;
        title?: string;
        description?: string;
        notes?: string;
        ownerId?: string;
        status?: string;
        priority?: string;
        startDate?: string;
        targetDate?: string;
      };

      // Build the update payload - only include defined fields
      const updateData: UpdateModuleRequest = {};

      if (title !== undefined) updateData.title = title;
      if (description !== undefined) updateData.description = description;
      if (notes !== undefined) updateData.notes = notes;
      if (ownerId !== undefined) updateData.ownerId = ownerId;
      if (status !== undefined) updateData.status = status as UpdateModuleRequest['status'];
      if (priority !== undefined) updateData.priority = priority as UpdateModuleRequest['priority'];
      if (startDate !== undefined) updateData.startDate = startDate;
      if (targetDate !== undefined) updateData.targetDate = targetDate;

      const module = await apiClient.updateModule(moduleId, updateData);
      const { verbose } = args as { verbose?: boolean };
      return { content: [{ type: 'text', text: formatWriteResult('updated', module as unknown as Record<string, unknown>, !!verbose) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error updating module: ${message}` }],
        isError: true,
      };
    }
  }

  if (name === 'haops_create_feature') {
    try {
      const {
        moduleId,
        title,
        description,
        notes,
        acceptanceCriteria,
        ownerId,
        status,
        priority,
        startDate,
        targetDate,
      } = args as {
        moduleId: string;
        title: string;
        description?: string;
        notes?: string;
        acceptanceCriteria?: string;
        ownerId: string;
        status?: string;
        priority?: string;
        startDate?: string;
        targetDate?: string;
      };

      // Build the request payload - only include defined fields
      const featureData: CreateFeatureRequest = {
        moduleId,
        title,
        ownerId,
      };

      if (description !== undefined) featureData.description = description;
      if (notes !== undefined) featureData.notes = notes;
      if (acceptanceCriteria !== undefined) featureData.acceptanceCriteria = acceptanceCriteria;
      if (status !== undefined) featureData.status = status as CreateFeatureRequest['status'];
      if (priority !== undefined) featureData.priority = priority as CreateFeatureRequest['priority'];
      if (startDate !== undefined) featureData.startDate = startDate;
      if (targetDate !== undefined) featureData.targetDate = targetDate;

      const feature = await apiClient.createFeature(featureData);
      const { verbose } = args as { verbose?: boolean };
      return { content: [{ type: 'text', text: formatWriteResult('created', feature as unknown as Record<string, unknown>, !!verbose) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error creating feature: ${message}` }],
        isError: true,
      };
    }
  }

  if (name === 'haops_update_feature') {
    try {
      const {
        featureId,
        title,
        description,
        notes,
        acceptanceCriteria,
        ownerId,
        status,
        priority,
        startDate,
        targetDate,
      } = args as {
        featureId: string;
        title?: string;
        description?: string;
        notes?: string;
        acceptanceCriteria?: string;
        ownerId?: string;
        status?: string;
        priority?: string;
        startDate?: string;
        targetDate?: string;
      };

      // Build the update payload - only include defined fields
      const updateData: UpdateFeatureRequest = {};

      if (title !== undefined) updateData.title = title;
      if (description !== undefined) updateData.description = description;
      if (notes !== undefined) updateData.notes = notes;
      if (acceptanceCriteria !== undefined) updateData.acceptanceCriteria = acceptanceCriteria;
      if (ownerId !== undefined) updateData.ownerId = ownerId;
      if (status !== undefined) updateData.status = status as UpdateFeatureRequest['status'];
      if (priority !== undefined) updateData.priority = priority as UpdateFeatureRequest['priority'];
      if (startDate !== undefined) updateData.startDate = startDate;
      if (targetDate !== undefined) updateData.targetDate = targetDate;

      const feature = await apiClient.updateFeature(featureId, updateData);
      const { verbose } = args as { verbose?: boolean };
      return { content: [{ type: 'text', text: formatWriteResult('updated', feature as unknown as Record<string, unknown>, !!verbose) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error updating feature: ${message}` }],
        isError: true,
      };
    }
  }

  if (name === 'haops_create_issue') {
    try {
      const {
        featureId,
        title,
        description,
        acceptanceCriteria,
        notes,
        type,
        status,
        priority,
        targetDate,
        assignedTo,
      } = args as {
        featureId: string;
        title: string;
        description?: string;
        acceptanceCriteria?: string;
        notes?: string;
        type?: string;
        status?: string;
        priority?: string;
        targetDate?: string;
        assignedTo?: string;
      };

      // Build the request payload - only include defined fields
      const issueData: CreateIssueRequest = {
        featureId,
        title,
      };

      if (description !== undefined) issueData.description = description;
      if (acceptanceCriteria !== undefined) issueData.acceptanceCriteria = acceptanceCriteria;
      if (notes !== undefined) issueData.notes = notes;
      if (type !== undefined) issueData.type = type as CreateIssueRequest['type'];
      if (status !== undefined) issueData.status = status as CreateIssueRequest['status'];
      if (priority !== undefined) issueData.priority = priority as CreateIssueRequest['priority'];
      if (targetDate !== undefined) issueData.targetDate = targetDate;
      if (assignedTo !== undefined) issueData.assignedTo = assignedTo;

      const issue = await apiClient.createIssue(issueData);
      const { verbose } = args as { verbose?: boolean };
      return { content: [{ type: 'text', text: formatWriteResult('created', issue as unknown as Record<string, unknown>, !!verbose) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error creating issue: ${message}` }],
        isError: true,
      };
    }
  }

  if (name === 'haops_update_issue') {
    try {
      const {
        issueId,
        title,
        description,
        acceptanceCriteria,
        notes,
        type,
        status,
        priority,
        targetDate,
        assignedTo,
      } = args as {
        issueId: string;
        title?: string;
        description?: string;
        acceptanceCriteria?: string;
        notes?: string;
        type?: string;
        status?: string;
        priority?: string;
        targetDate?: string;
        assignedTo?: string;
      };

      // Build the update payload - only include defined fields
      const updateData: UpdateIssueRequest = {};

      if (title !== undefined) updateData.title = title;
      if (description !== undefined) updateData.description = description;
      if (acceptanceCriteria !== undefined) updateData.acceptanceCriteria = acceptanceCriteria;
      if (notes !== undefined) updateData.notes = notes;
      if (type !== undefined) updateData.type = type as UpdateIssueRequest['type'];
      if (status !== undefined) updateData.status = status as UpdateIssueRequest['status'];
      if (priority !== undefined) updateData.priority = priority as UpdateIssueRequest['priority'];
      if (targetDate !== undefined) updateData.targetDate = targetDate;
      if (assignedTo !== undefined) updateData.assignedTo = assignedTo;

      const issue = await apiClient.updateIssue(issueId, updateData);
      const { verbose } = args as { verbose?: boolean };
      return { content: [{ type: 'text', text: formatWriteResult('updated', issue as unknown as Record<string, unknown>, !!verbose) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error updating issue: ${message}` }],
        isError: true,
      };
    }
  }

  if (name === 'haops_bulk_update_issues') {
    try {
      const { issueIds, updates } = args as {
        issueIds: string[];
        updates: { status?: string; priority?: string; assignedTo?: string };
      };

      if (!issueIds || issueIds.length === 0) {
        return {
          content: [{ type: 'text', text: 'Error: issueIds array must not be empty' }],
          isError: true,
        };
      }

      const result = await apiClient.bulkUpdateIssues(issueIds, updates);
      const fields = Object.entries(updates)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');

      return {
        content: [{
          type: 'text',
          text: `Bulk update complete: ${result.updated} issue(s) updated (${fields}).\n\nUpdated issues:\n${result.issues.map((i: any) => `  - ${i.title} (${i.status})`).join('\n')}`,
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error in bulk update: ${message}` }],
        isError: true,
      };
    }
  }

  if (name === 'haops_delete_module') {
    try {
      const { moduleId, confirm } = args as {
        moduleId: string;
        confirm?: boolean;
      };

      // Get module details first
      const mod = await apiClient.getModule(moduleId);

      // Check for child features
      const { count: featureCount, features } = await apiClient.countFeaturesByModule(moduleId);

      if (featureCount > 0 && !confirm) {
        // Count total issues across all features
        let totalIssues = 0;
        for (const feat of features) {
          const { count } = await apiClient.countIssuesByFeature(feat.id);
          totalIssues += count;
        }
        return {
          content: [{
            type: 'text',
            text: `⚠️ Module "${mod.title}" has ${featureCount} feature(s) and ${totalIssues} issue(s) that will be cascade deleted.\n\nFeatures:\n${features.map(f => `  - ${f.title} (${f.status})`).join('\n')}\n\nTo confirm deletion, call again with confirm=true.`,
          }],
        };
      }

      // Delete child features first (FK is SET NULL, not CASCADE)
      // Deleting features will cascade to their issues (FK IS CASCADE)
      for (const feat of features) {
        await apiClient.deleteFeature(feat.id);
      }
      await apiClient.deleteModule(moduleId);
      return {
        content: [{
          type: 'text',
          text: `Module "${mod.title}" deleted successfully.${featureCount > 0 ? ` Cascade deleted ${featureCount} feature(s) and their issues.` : ''}`,
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error deleting module: ${message}` }],
        isError: true,
      };
    }
  }

  if (name === 'haops_delete_feature') {
    try {
      const { featureId, confirm } = args as {
        featureId: string;
        confirm?: boolean;
      };

      // Get feature details first
      const feature = await apiClient.getFeature(featureId);

      // Check for child issues
      const { count: issueCount, issues } = await apiClient.countIssuesByFeature(featureId);

      if (issueCount > 0 && !confirm) {
        return {
          content: [{
            type: 'text',
            text: `⚠️ Feature "${feature.title}" has ${issueCount} issue(s) that will be cascade deleted.\n\nIssues:\n${issues.map(i => `  - ${i.title} (${i.status})`).join('\n')}\n\nTo confirm deletion, call again with confirm=true.`,
          }],
        };
      }

      await apiClient.deleteFeature(featureId);
      return {
        content: [{
          type: 'text',
          text: `Feature "${feature.title}" deleted successfully.${issueCount > 0 ? ` Cascade deleted ${issueCount} issue(s).` : ''}`,
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error deleting feature: ${message}` }],
        isError: true,
      };
    }
  }

  if (name === 'haops_delete_issue') {
    try {
      const { issueId } = args as { issueId: string };

      // Get issue details first
      const issue = await apiClient.getIssue(issueId);

      await apiClient.deleteIssue(issueId);
      return {
        content: [{
          type: 'text',
          text: `Issue "${issue.title}" deleted successfully.`,
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error deleting issue: ${message}` }],
        isError: true,
      };
    }
  }

  if (name === 'haops_create_discussion') {
    try {
      const {
        projectSlug,
        title,
        type,
        priority,
        channelId,
        discussableType,
        discussableId,
        firstMessage,
        firstMessageContentType,
      } = args as {
        projectSlug: string;
        title: string;
        type?: string;
        priority?: string;
        channelId?: string;
        discussableType?: string;
        discussableId?: string;
        firstMessage?: string;
        firstMessageContentType?: string;
      };

      const data: CreateDiscussionRequest = { title };
      if (type !== undefined) data.type = type as CreateDiscussionRequest['type'];
      if (priority !== undefined) data.priority = priority as 'low' | 'medium' | 'high' | 'critical';
      if (channelId !== undefined) data.channelId = channelId;
      if (discussableType !== undefined) data.discussableType = discussableType as 'Module' | 'Feature' | 'Issue';
      if (discussableId !== undefined) data.discussableId = discussableId;
      if (firstMessage !== undefined) data.firstMessage = firstMessage;
      // Default firstMessageContentType to 'markdown' for agents
      data.firstMessageContentType = (firstMessageContentType || 'markdown') as 'text' | 'markdown' | 'html' | 'code';

      const discussion = await apiClient.createDiscussion(projectSlug, data);
      const { verbose } = args as { verbose?: boolean };
      return { content: [{ type: 'text', text: formatWriteResult('created', discussion as unknown as Record<string, unknown>, !!verbose) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error creating discussion: ${message}` }],
        isError: true,
      };
    }
  }

  if (name === 'haops_list_discussions') {
    try {
      const { projectSlug, entityType, entityId, channelId, status } = args as {
        projectSlug: string;
        entityType?: string;
        entityId?: string;
        channelId?: string;
        status?: string;
      };

      const filters: Record<string, string> = {};
      if (entityType) filters.entityType = entityType;
      if (entityId) filters.entityId = entityId;
      if (channelId) filters.channelId = channelId;
      if (status) filters.status = status;

      const discussions = await apiClient.listDiscussions(projectSlug, filters);
      return {
        content: [{
          type: 'text',
          text: `Found ${discussions.length} discussion(s):\n${JSON.stringify(discussions, null, 2)}`,
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error listing discussions: ${message}` }],
        isError: true,
      };
    }
  }

  if (name === 'haops_list_channels') {
    try {
      const { projectSlug } = args as { projectSlug: string };
      const channels = await apiClient.listChannels(projectSlug);
      return {
        content: [{
          type: 'text',
          text: `Project channels (${channels.length}):\n${JSON.stringify(channels, null, 2)}`,
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error listing channels: ${message}` }],
        isError: true,
      };
    }
  }

  if (name === 'haops_post_message') {
    try {
      const {
        projectSlug,
        discussionId,
        content,
        contentType,
        parentMessageId,
      } = args as {
        projectSlug: string;
        discussionId: string;
        content: string;
        contentType?: string;
        parentMessageId?: string;
      };

      const data: CreateDiscussionMessageRequest = { content };
      // Default to markdown for agent messages
      data.contentType = (contentType || 'markdown') as CreateDiscussionMessageRequest['contentType'];
      if (parentMessageId !== undefined) data.parentMessageId = parentMessageId;

      const msg = await apiClient.postMessage(projectSlug, discussionId, data);
      const { verbose } = args as { verbose?: boolean };
      return { content: [{ type: 'text', text: formatWriteResult('posted', msg as unknown as Record<string, unknown>, !!verbose) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error posting message: ${message}` }],
        isError: true,
      };
    }
  }

  if (name === 'haops_send_dm') {
    try {
      const {
        projectSlug,
        recipientUserId,
        content,
        contentType,
      } = args as {
        projectSlug: string;
        recipientUserId: string;
        content: string;
        contentType?: string;
      };

      const data: CreateDirectMessageRequest = { content };
      if (contentType !== undefined) data.contentType = contentType as CreateDirectMessageRequest['contentType'];

      const dm = await apiClient.sendDM(projectSlug, recipientUserId, data);
      const { verbose } = args as { verbose?: boolean };
      return { content: [{ type: 'text', text: formatWriteResult('sent', dm as unknown as Record<string, unknown>, !!verbose) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error sending DM: ${message}` }],
        isError: true,
      };
    }
  }

  if (name === 'haops_get_discussion') {
    try {
      const { projectSlug, discussionId } = args as {
        projectSlug: string;
        discussionId: string;
      };

      const discussion = await apiClient.getDiscussion(projectSlug, discussionId);
      return {
        content: [{
          type: 'text',
          text: `Discussion details:\n${JSON.stringify(discussion, null, 2)}`,
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error fetching discussion: ${message}` }],
        isError: true,
      };
    }
  }

  if (name === 'haops_get_discussion_messages') {
    try {
      const { projectSlug, discussionId, page, limit } = args as {
        projectSlug: string;
        discussionId: string;
        page?: number;
        limit?: number;
      };

      const result = await apiClient.getDiscussionMessages(
        projectSlug,
        discussionId,
        page || 1,
        limit || 50
      );
      return {
        content: [{
          type: 'text',
          text: `Discussion messages (page ${result.page}/${Math.ceil(result.total / result.limit)}, ${result.total} total):\n${JSON.stringify(result.data, null, 2)}`,
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error fetching discussion messages: ${message}` }],
        isError: true,
      };
    }
  }

  if (name === 'haops_list_dm_conversations') {
    try {
      const { projectSlug } = args as { projectSlug: string };

      const conversations = await apiClient.listDMConversations(projectSlug);
      return {
        content: [{
          type: 'text',
          text: `DM conversations:\n${JSON.stringify(conversations, null, 2)}`,
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error listing DM conversations: ${message}` }],
        isError: true,
      };
    }
  }

  if (name === 'haops_get_dm_history') {
    try {
      const { projectSlug, userId, page, limit } = args as {
        projectSlug: string;
        userId: string;
        page?: number;
        limit?: number;
      };

      const result = await apiClient.getDMHistory(
        projectSlug,
        userId,
        page || 1,
        limit || 50
      );
      return {
        content: [{
          type: 'text',
          text: `DM history (page ${result.page}/${Math.ceil(result.total / result.limit)}, ${result.total} total):\n${JSON.stringify(result.data, null, 2)}`,
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error fetching DM history: ${message}` }],
        isError: true,
      };
    }
  }

  if (name === 'haops_update_discussion') {
    try {
      const {
        projectSlug,
        discussionId,
        title,
        type,
        status,
        priority,
        assignedTo,
        isLocked,
        isPinned,
      } = args as {
        projectSlug: string;
        discussionId: string;
        title?: string;
        type?: string;
        status?: string;
        priority?: string;
        assignedTo?: string;
        isLocked?: boolean;
        isPinned?: boolean;
      };

      const data: UpdateDiscussionRequest = {};
      if (title !== undefined) data.title = title;
      if (type !== undefined) data.type = type as UpdateDiscussionRequest['type'];
      if (status !== undefined) data.status = status as UpdateDiscussionRequest['status'];
      if (priority !== undefined) data.priority = priority as UpdateDiscussionRequest['priority'];
      if (assignedTo !== undefined) data.assignedTo = assignedTo;
      if (isLocked !== undefined) data.isLocked = isLocked;
      if (isPinned !== undefined) data.isPinned = isPinned;

      const discussion = await apiClient.updateDiscussion(projectSlug, discussionId, data);
      const { verbose } = args as { verbose?: boolean };
      return { content: [{ type: 'text', text: formatWriteResult('updated', discussion as unknown as Record<string, unknown>, !!verbose) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error updating discussion: ${message}` }],
        isError: true,
      };
    }
  }

  if (name === 'haops_mark_dm_read') {
    try {
      const { projectSlug, userId } = args as {
        projectSlug: string;
        userId: string;
      };

      const result = await apiClient.markDMRead(projectSlug, userId);
      return {
        content: [{
          type: 'text',
          text: `Marked ${result.count} message(s) as read`,
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error marking DMs as read: ${message}` }],
        isError: true,
      };
    }
  }

  if (name === 'haops_delete_discussion') {
    try {
      const { projectSlug, discussionId } = args as {
        projectSlug: string;
        discussionId: string;
      };

      const result = await apiClient.deleteDiscussion(projectSlug, discussionId);
      return {
        content: [{
          type: 'text',
          text: result.message,
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error deleting discussion: ${message}` }],
        isError: true,
      };
    }
  }

  if (name === 'haops_edit_message') {
    try {
      const { projectSlug, discussionId, messageId, content, contentType } = args as {
        projectSlug: string;
        discussionId: string;
        messageId: string;
        content: string;
        contentType?: string;
      };

      const data: { content: string; contentType?: string } = { content };
      if (contentType) data.contentType = contentType;

      const msg = await apiClient.editMessage(projectSlug, discussionId, messageId, data);
      const { verbose } = args as { verbose?: boolean };
      return { content: [{ type: 'text', text: formatWriteResult('edited', msg as unknown as Record<string, unknown>, !!verbose) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error editing message: ${message}` }],
        isError: true,
      };
    }
  }

  if (name === 'haops_delete_message') {
    try {
      const { projectSlug, discussionId, messageId } = args as {
        projectSlug: string;
        discussionId: string;
        messageId: string;
      };

      const result = await apiClient.deleteMessage(projectSlug, discussionId, messageId);
      return {
        content: [{
          type: 'text',
          text: result.message || 'Message deleted successfully',
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error deleting message: ${message}` }],
        isError: true,
      };
    }
  }

  if (name === 'haops_list_members') {
    try {
      const { projectSlug } = args as { projectSlug: string };

      const members = await apiClient.listMembers(projectSlug);
      return {
        content: [{
          type: 'text',
          text: `Project members (${members.length}):\n${JSON.stringify(members, null, 2)}`,
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error listing members: ${message}` }],
        isError: true,
      };
    }
  }

  if (name === 'haops_add_member') {
    try {
      const { projectSlug, userId, role } = args as {
        projectSlug: string;
        userId: string;
        role?: string;
      };

      const member = await apiClient.addMember(
        projectSlug,
        userId,
        role as ProjectMemberRole | undefined
      );
      const { verbose } = args as { verbose?: boolean };
      return { content: [{ type: 'text', text: formatWriteResult('added', member as unknown as Record<string, unknown>, !!verbose) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error adding member: ${message}` }],
        isError: true,
      };
    }
  }

  if (name === 'haops_update_member_role') {
    try {
      const { projectSlug, userId, role } = args as {
        projectSlug: string;
        userId: string;
        role: string;
      };

      const member = await apiClient.updateMemberRole(
        projectSlug,
        userId,
        role as ProjectMemberRole
      );
      const { verbose } = args as { verbose?: boolean };
      return { content: [{ type: 'text', text: formatWriteResult('updated', member as unknown as Record<string, unknown>, !!verbose) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error updating member role: ${message}` }],
        isError: true,
      };
    }
  }

  if (name === 'haops_get_activity') {
    try {
      const { projectSlug, entityType, entityId } = args as {
        projectSlug: string;
        entityType: string;
        entityId: string;
      };

      const activity = await apiClient.getEntityActivity(projectSlug, entityType, entityId);
      return {
        content: [{
          type: 'text',
          text: `Activity log (${activity.length} entries):\n${JSON.stringify(activity, null, 2)}`,
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error fetching activity: ${message}` }],
        isError: true,
      };
    }
  }

  if (name === 'haops_get_audit_log') {
    try {
      const { page, limit, action, entityType } = args as {
        page?: number;
        limit?: number;
        action?: string;
        entityType?: string;
      };

      const result = await apiClient.getAuditLog({ page, limit, action, entityType });
      return {
        content: [{
          type: 'text',
          text: `Audit log (${result.data.length} of ${result.total}, page ${result.page}):\n${JSON.stringify(result.data, null, 2)}`,
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error fetching audit log: ${message}` }],
        isError: true,
      };
    }
  }

  if (name === 'haops_claim_issue') {
    try {
      const { issueId, checkOnly } = args as {
        issueId: string;
        checkOnly?: boolean;
      };

      const result = await apiClient.claimIssue(issueId, {
        checkOnly: checkOnly || false,
      });
      const { verbose } = args as { verbose?: boolean };
      const r = result as Record<string, unknown>;
      const claimText = verbose
        ? JSON.stringify(result, null, 2)
        : `${r.success ? 'Claimed' : 'Check'} — ${(r.issue as Record<string, unknown>)?.id as string ?? issueId} [${(r.issue as Record<string, unknown>)?.status as string ?? ''}]`;
      return { content: [{ type: 'text', text: claimText }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error claiming issue: ${message}` }],
        isError: true,
      };
    }
  }

  if (name === 'haops_claim_feature') {
    try {
      const { featureId, checkOnly } = args as {
        featureId: string;
        checkOnly?: boolean;
      };

      const result = await apiClient.claimFeature(featureId, {
        checkOnly: checkOnly || false,
      });
      const { verbose } = args as { verbose?: boolean };
      const r = result as Record<string, unknown>;
      const claimText = verbose
        ? JSON.stringify(result, null, 2)
        : `${r.success ? 'Claimed' : 'Check'} — ${(r.feature as Record<string, unknown>)?.id as string ?? featureId} [${(r.feature as Record<string, unknown>)?.status as string ?? ''}]`;
      return { content: [{ type: 'text', text: claimText }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error claiming feature: ${message}` }],
        isError: true,
      };
    }
  }

  if (name === 'haops_claim_module') {
    try {
      const { moduleId, checkOnly } = args as {
        moduleId: string;
        checkOnly?: boolean;
      };

      const result = await apiClient.claimModule(moduleId, {
        checkOnly: checkOnly || false,
      });
      const { verbose } = args as { verbose?: boolean };
      const r = result as Record<string, unknown>;
      const claimText = verbose
        ? JSON.stringify(result, null, 2)
        : `${r.success ? 'Claimed' : 'Check'} — ${(r.module as Record<string, unknown>)?.id as string ?? moduleId} [${(r.module as Record<string, unknown>)?.status as string ?? ''}]`;
      return { content: [{ type: 'text', text: claimText }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error claiming module: ${message}` }],
        isError: true,
      };
    }
  }

  if (name === 'haops_work_entity_health_check') {
    try {
      const {
        projectId,
        entityType,
        checks,
        staleThresholdHours,
        verbosity,
      } = args as {
        projectId?: string;
        entityType?: 'module' | 'feature' | 'issue' | 'all';
        checks?: string[];
        staleThresholdHours?: number;
        verbosity?: 'summary' | 'normal' | 'detailed';
      };

      const result = await apiClient.workEntityHealthCheck({
        projectId,
        entityType,
        checks,
        staleThresholdHours,
        verbosity,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error running health check: ${message}` }],
        isError: true,
      };
    }
  }

  // ===== Help Center Tool Handlers =====

  if (name === 'haops_list_help_sections') {
    try {
      const result = await apiClient.request('GET', '/api/help/sections?published=false');
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  }

  if (name === 'haops_list_help_articles') {
    try {
      const { sectionSlug } = args as { sectionSlug?: string };
      const url = sectionSlug
        ? `/api/help/sections/${sectionSlug}/articles`
        : '/api/help/search?q=&limit=50';
      const result = await apiClient.request('GET', url);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  }

  if (name === 'haops_create_help_article') {
    try {
      const { sectionSlug, title, content, isPublished } = args as {
        sectionSlug: string; title: string; content?: string; isPublished?: boolean;
      };
      const result = await apiClient.request('POST', `/api/help/sections/${sectionSlug}/articles`, {
        title, content, isPublished,
      });
      const { verbose } = args as { verbose?: boolean };
      return { content: [{ type: 'text', text: formatWriteResult('created', result as unknown as Record<string, unknown>, !!verbose) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  }

  if (name === 'haops_get_help_article') {
    try {
      const { slug } = args as { slug: string };
      const result = await apiClient.request('GET', `/api/help/articles/${slug}`);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  }

  if (name === 'haops_update_help_article') {
    try {
      const { slug, title, content, isPublished } = args as {
        slug: string; title?: string; content?: string; isPublished?: boolean;
      };
      const body: Record<string, unknown> = {};
      if (title !== undefined) body.title = title;
      if (content !== undefined) body.content = content;
      if (isPublished !== undefined) body.isPublished = isPublished;
      const result = await apiClient.request('PUT', `/api/help/articles/${slug}`, body);
      const { verbose } = args as { verbose?: boolean };
      return { content: [{ type: 'text', text: formatWriteResult('updated', result as unknown as Record<string, unknown>, !!verbose) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  }

  // ===== Documentation Builder Tool Handlers =====

  if (name === 'haops_list_doc_artifacts') {
    try {
      const { projectSlug } = args as { projectSlug: string };
      const result = await apiClient.request('GET', `/api/projects/${projectSlug}/docs`);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  }

  if (name === 'haops_create_doc_artifact') {
    try {
      const { projectSlug, type, title, description } = args as {
        projectSlug: string; type: string; title: string; description?: string;
      };
      const { verbose } = args as { verbose?: boolean };
      const result = await apiClient.request('POST', `/api/projects/${projectSlug}/docs`, {
        type, title, description,
      });
      return { content: [{ type: 'text', text: formatWriteResult('created', result as unknown as Record<string, unknown>, !!verbose) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  }

  if (name === 'haops_update_doc_artifact') {
    try {
      const { projectSlug, artifactSlug, title, description, status, version } = args as {
        projectSlug: string; artifactSlug: string; title?: string; description?: string; status?: string; version?: string;
      };
      const body: Record<string, unknown> = {};
      if (title !== undefined) body.title = title;
      if (description !== undefined) body.description = description;
      if (status !== undefined) body.status = status;
      if (version !== undefined) body.version = version;
      const result = await apiClient.request('PUT', `/api/projects/${projectSlug}/docs/${artifactSlug}`, body);
      const { verbose } = args as { verbose?: boolean };
      return { content: [{ type: 'text', text: formatWriteResult('updated', result as unknown as Record<string, unknown>, !!verbose) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  }

  if (name === 'haops_create_doc_section') {
    try {
      const { projectSlug, artifactSlug, title, content, parentId, sourceHint } = args as {
        projectSlug: string; artifactSlug: string; title: string; content?: string; parentId?: string; sourceHint?: string;
      };
      const result = await apiClient.request('POST', `/api/projects/${projectSlug}/docs/${artifactSlug}/sections`, {
        title, content, parentId, sourceHint,
      });
      const { verbose } = args as { verbose?: boolean };
      return { content: [{ type: 'text', text: formatWriteResult('created', result as unknown as Record<string, unknown>, !!verbose) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  }

  if (name === 'haops_update_doc_section') {
    try {
      const { projectSlug, artifactSlug, sectionSlug, title, content, sourceHint, slug } = args as {
        projectSlug: string; artifactSlug: string; sectionSlug: string; title?: string; content?: string; sourceHint?: string; slug?: string;
      };
      const body: Record<string, unknown> = {};
      if (title !== undefined) body.title = title;
      if (content !== undefined) body.content = content;
      if (sourceHint !== undefined) body.sourceHint = sourceHint;
      if (slug !== undefined) body.slug = slug;
      const result = await apiClient.request('PUT', `/api/projects/${projectSlug}/docs/${artifactSlug}/sections/${sectionSlug}`, body);
      const { verbose } = args as { verbose?: boolean };
      return { content: [{ type: 'text', text: formatWriteResult('updated', result as unknown as Record<string, unknown>, !!verbose) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  }

  if (name === 'haops_get_doc_section') {
    try {
      const { projectSlug, artifactSlug, sectionSlug } = args as {
        projectSlug: string; artifactSlug: string; sectionSlug: string;
      };
      const result = await apiClient.request('GET', `/api/projects/${projectSlug}/docs/${artifactSlug}/sections/${sectionSlug}`);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  }

  if (name === 'haops_export_doc_markdown') {
    try {
      const { projectSlug, artifactSlug } = args as {
        projectSlug: string; artifactSlug: string;
      };
      const markdown = await apiClient.requestText('GET', `/api/projects/${projectSlug}/docs/${artifactSlug}/export/markdown`);
      return {
        content: [{ type: 'text', text: markdown }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  }

  // ===== Onboarding Tool Handler =====

  if (name === 'haops_generate_onboarding') {
    try {
      const {
        projectSlug,
        developerName,
        developerEmail,
        framework,
        programmingLanguage,
        database,
        orm,
        uiFramework,
        repoPath,
        dbNameDev,
        dbUserDev,
        devServerUrl,
        language,
        dbPasswordDev,
        serverHost,
        sshUser,
        sshMethod,
        appPath,
        processManager,
        publicUrl,
        repoUrl,
        testFramework,
        testRunner,
        screenshotScript,
        webServer,
        os: serverOs,
        generateApiKey,
        haopsApiKey,
        outputDir,
      } = args as {
        projectSlug: string;
        developerName: string;
        developerEmail: string;
        framework: string;
        programmingLanguage: string;
        database: string;
        orm: string;
        uiFramework: string;
        repoPath: string;
        dbNameDev: string;
        dbUserDev: string;
        devServerUrl: string;
        language?: string;
        dbPasswordDev?: string;
        serverHost?: string;
        sshUser?: string;
        sshMethod?: string;
        appPath?: string;
        processManager?: string;
        publicUrl?: string;
        repoUrl?: string;
        testFramework?: string;
        testRunner?: string;
        screenshotScript?: string;
        webServer?: string;
        os?: string;
        generateApiKey?: boolean;
        haopsApiKey?: string;
        outputDir?: string;
      };

      // Build request body (same shape as the API endpoint)
      const body: Record<string, unknown> = {
        developerName,
        developerEmail,
        framework,
        programmingLanguage,
        database,
        orm,
        uiFramework,
        repoPath,
        dbNameDev,
        dbUserDev,
        devServerUrl,
      };

      if (language !== undefined) body.language = language;
      if (dbPasswordDev !== undefined) body.dbPasswordDev = dbPasswordDev;
      if (serverHost !== undefined) body.serverHost = serverHost;
      if (sshUser !== undefined) body.sshUser = sshUser;
      if (sshMethod !== undefined) body.sshMethod = sshMethod;
      if (appPath !== undefined) body.appPath = appPath;
      if (processManager !== undefined) body.processManager = processManager;
      if (publicUrl !== undefined) body.publicUrl = publicUrl;
      if (repoUrl !== undefined) body.repoUrl = repoUrl;
      if (testFramework !== undefined) body.testFramework = testFramework;
      if (testRunner !== undefined) body.testRunner = testRunner;
      if (screenshotScript !== undefined) body.screenshotScript = screenshotScript;
      if (webServer !== undefined) body.webServer = webServer;
      if (serverOs !== undefined) body.os = serverOs;
      if (generateApiKey !== undefined) body.generateApiKey = generateApiKey;
      if (haopsApiKey !== undefined) body.haopsApiKey = haopsApiKey;

      // Call the onboarding API (returns ZIP binary)
      const zipBuffer = await apiClient.requestBinary(
        'POST',
        `/api/projects/${projectSlug}/onboarding/generate`,
        body,
      );

      // Save to file
      const dir = outputDir || os.tmpdir();
      const safeName = developerName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      const filename = `${projectSlug}-${safeName}-workspace.zip`;
      const filePath = path.join(dir, filename);

      await fs.writeFile(filePath, zipBuffer);

      const sizeKB = Math.round(zipBuffer.length / 1024);

      return {
        content: [{
          type: 'text',
          text: [
            `Onboarding kit generated successfully!`,
            ``,
            `File: ${filePath}`,
            `Size: ${sizeKB} KB`,
            `Developer: ${developerName} (${developerEmail})`,
            `Project: ${projectSlug}`,
            ``,
            `Setup instructions:`,
            `1. Extract the ZIP to the project root: unzip "${filePath}" -d "${repoPath}"`,
            `2. Review and customize .claude/settings.local.json`,
            `3. Update private/PROJECT-INFO.md with credentials`,
            `4. Run scripts/setup.sh for environment bootstrapping`,
          ].join('\n'),
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error generating onboarding kit: ${message}` }],
        isError: true,
      };
    }
  }

  // Agent Memory tools

  if (name === 'haops_read_memory') {
    try {
      const { projectSlug, entityType, entityId, full } = args as {
        projectSlug: string;
        entityType: 'project' | 'module' | 'feature';
        entityId: string;
        full?: boolean;
      };

      // Determine effective mode (ADR-027 I6):
      // Caller can pass mode:"lazy" explicitly; or set HAOPS_MEMORY_LAZY_DEFAULT=true
      // on the MCP server to flip the default. Eager is the default otherwise.
      const { mode: modeArg } = args as { mode?: 'eager' | 'lazy' };
      const lazyDefault = process.env.HAOPS_MEMORY_LAZY_DEFAULT === 'true';
      const effectiveMode: 'eager' | 'lazy' = modeArg ?? (lazyDefault ? 'lazy' : 'eager');

      const CONSOLIDATE_THRESHOLD = parseInt(process.env.HAOPS_MEMORY_CONSOLIDATE_THRESHOLD ?? '15', 10);

      const memory = await apiClient.readMemory(projectSlug, entityType, entityId, full);

      const pendingEntries = memory.log.filter(e => !e.integrated);

      // Soft-gate consolidation banner (both modes) — fires when pending log count exceeds threshold.
      const consolidationBanner =
        pendingEntries.length > CONSOLIDATE_THRESHOLD
          ? `⚠️ ${pendingEntries.length} pending log entries — consolidation overdue`
          : null;

      // ── Lazy mode: project entity only (ADR-027 §2) ──────────────────────────
      // For module/feature, lazy falls back to eager — entity baseText is already
      // thin and there are no doc artifacts to index at that level.
      if (effectiveMode === 'lazy' && entityType === 'project') {
        const lines: string[] = [
          `Agent memory INDEX for ${entityType} ${entityId} (lazy mode — ADR-027):`,
          '',
          '## Base Text',
          memory.baseText || '(empty)',
          '',
        ];

        if (consolidationBanner) {
          lines.push(consolidationBanner, '');
        }

        // ── Doc artifacts compact pointer (ADR-027 I6 — counts only, no section fetch) ──
        // One line per artifact: title [slug] · N sections
        // Eliminates section header dumps that inflated lazy > eager at steady state.
        // Agents drill in via haops_list_doc_sections / haops_get_doc_section / haops_rag_query.
        try {
          const artifacts = await apiClient.request('GET', `/api/projects/${projectSlug}/docs`) as Array<{
            id: string; slug: string; title: string; type?: string; sectionCount?: number | string;
          }>;

          lines.push('## Doc artifacts');
          if (Array.isArray(artifacts) && artifacts.length > 0) {
            for (const a of artifacts) {
              const count = a.sectionCount != null ? ` · ${a.sectionCount} sections` : '';
              lines.push(`- ${a.title} [${a.slug}]${count}`);
            }
          } else {
            lines.push('(none)');
          }
          lines.push('(browse: haops_list_doc_sections(projectSlug, artifactSlug) · search: haops_rag_query)', '');
        } catch {
          lines.push('## Doc artifacts', '(unavailable — HAOps docs API error)', '');
        }

        // ── Active work: in-progress modules + features ────────────────────────
        lines.push('## Active work (status=in-progress)');
        try {
          const [inProgressModules, inProgressFeatures] = await Promise.all([
            apiClient.listModules(projectSlug, { status: 'in-progress' }),
            apiClient.listFeatures(projectSlug, { status: 'in-progress' }),
          ]);

          if (inProgressModules.length === 0 && inProgressFeatures.length === 0) {
            lines.push('(none currently in progress)');
          }
          if (inProgressModules.length > 0) {
            lines.push('Modules:');
            for (const m of inProgressModules) {
              lines.push(`  ${m.title} [${m.id}]`);
            }
          }
          if (inProgressFeatures.length > 0) {
            lines.push('Features:');
            for (const f of inProgressFeatures) {
              lines.push(`  ${f.title} [${f.id}]`);
            }
          }
        } catch {
          lines.push('(unavailable — active work fetch error)');
        }
        lines.push('');

        // ── Log headers only (no bodies) ───────────────────────────────────────
        lines.push(`## Unconsolidated log headers (${pendingEntries.length})`);
        lines.push('(headers only — fetch body via haops_read_memory(full:true) for a specific entity)');
        for (const entry of pendingEntries) {
          lines.push(`- [${entry.timestamp}] [${entry.tag}] by ${entry.author}`);
        }
        if (memory.meta.lastConsolidated) {
          lines.push('', `Last consolidated: ${memory.meta.lastConsolidated} by ${memory.meta.consolidatedBy}`);
        }
        lines.push('');
        lines.push(
          '─── Fetch detail on demand ───────────────────────────────────────────────────',
          '• Doc section body:  haops_get_doc_section(projectSlug, artifactSlug, sectionSlug)',
          '• Full memory+logs:  haops_read_memory(entityType, entityId, full:true)',
          '• Semantic search:   haops_rag_query(projectSlug, query)',
        );

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
        };
      }

      // ── Eager mode (default) ──────────────────────────────────────────────────
      const lines = [
        `Agent memory for ${entityType} ${entityId}:`,
        '',
        '## Base Text',
        memory.baseText || '(empty)',
        '',
      ];

      if (consolidationBanner) {
        lines.push(consolidationBanner, '');
      }

      lines.push(`## Log Entries (${full ? 'all' : 'pending only'}: ${full ? memory.log.length : pendingEntries.length})`);

      const entries = full ? memory.log : pendingEntries;
      for (const entry of entries) {
        lines.push(`- [${entry.timestamp}] [${entry.tag}] by ${entry.author}${entry.integrated ? ' (integrated)' : ''}`);
        lines.push(`  ${entry.content}`);
      }

      if (memory.meta.lastConsolidated) {
        lines.push('', `Last consolidated: ${memory.meta.lastConsolidated} by ${memory.meta.consolidatedBy}`);
      }

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error reading memory: ${message}` }],
        isError: true,
      };
    }
  }

  if (name === 'haops_append_memory') {
    try {
      const { projectSlug, entityType, entityId, tag, content } = args as {
        projectSlug: string;
        entityType: 'project' | 'module' | 'feature';
        entityId: string;
        tag: string;
        content: string;
      };

      const { verbose } = args as { verbose?: boolean };
      const entry = await apiClient.appendMemoryLog(
        projectSlug, entityType, entityId, tag as 'context' | 'decision' | 'progress' | 'issue' | 'review' | 'deploy', content,
      );
      // Compact: {id, timestamp, tag} only — no content echo (M1+M5)
      const e = entry as unknown as Record<string, unknown>;
      const compactText = verbose
        ? `Memory log entry appended:\n${JSON.stringify(entry, null, 2)}`
        : `Memory appended — ${e.id as string} [${e.tag as string}] ${e.timestamp as string}`;
      return { content: [{ type: 'text', text: compactText }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error appending memory: ${message}` }],
        isError: true,
      };
    }
  }

  if (name === 'haops_consolidate_memory') {
    try {
      const { projectSlug, entityType, entityId, newBaseText, integrateUpTo } = args as {
        projectSlug: string;
        entityType: 'project' | 'module' | 'feature';
        entityId: string;
        newBaseText: string;
        integrateUpTo?: string;
      };

      const result = await apiClient.consolidateMemory(
        projectSlug, entityType, entityId, newBaseText, integrateUpTo,
      );

      return {
        content: [{
          type: 'text',
          text: `Memory consolidated successfully by ${result.consolidatedBy}.${integrateUpTo ? ` Entries up to ${integrateUpTo} marked as integrated.` : ' All pending entries marked as integrated.'}`,
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error consolidating memory: ${message}` }],
        isError: true,
      };
    }
  }

  // ===== Protocol Tool Handlers =====

  if (name === 'haops_read_protocol') {
    try {
      const { projectSlug, role, version, mode } = args as {
        projectSlug: string;
        role: string;
        version?: number;
        mode?: 'lazy' | 'bundle';
      };

      // Default to lazy when no mode is given AND no historical version is
      // requested. When a version is requested we leave mode undefined so the
      // server returns the raw historical shape.
      const effectiveMode: 'lazy' | 'bundle' | undefined =
        version !== undefined
          ? undefined
          : (mode ?? 'lazy');

      const result = await apiClient.readProtocol(
        projectSlug,
        role,
        version,
        effectiveMode,
      );

      // F4: the response shape depends on the resolver mode. We render each
      // shape into the same human-readable text envelope so the agent gets
      // consistent framing, but the body/manifest layout differs.
      const protocolMode = (result.mode as string | undefined) ?? 'legacy';
      const bytes = (result.bytes as number | undefined) ?? 0;
      const versionStr = String(result.version ?? 'N/A');

      const headerLines: string[] = [
        `Protocol for role "${role}" in project "${projectSlug}":`,
      ];

      if (protocolMode === 'legacy') {
        // Legacy rendering — byte-identical to v2.5 so existing agents +
        // hand-written snapshots keep matching. Order: Version → Updated →
        // (optional Updated by) → (optional Change summary) → '' → '---' → ''
        // → content.
        headerLines.push(`Version: ${versionStr}`);
        headerLines.push(`Updated: ${result.createdAt || 'N/A'}`);
        if (result.updatedByKey) headerLines.push(`Updated by: ${result.updatedByKey}`);
        if (result.changeSummary) headerLines.push(`Change summary: ${result.changeSummary}`);
        headerLines.push('');
        headerLines.push('---');
        headerLines.push('');
        headerLines.push(
          (result.body as string) ?? (result.content as string) ?? '(empty)',
        );

        return {
          content: [{ type: 'text', text: headerLines.filter((l) => l !== undefined).join('\n') }],
        };
      }

      // Composed rendering — new in F4. We add Mode + Bytes for visibility
      // since these shapes are unfamiliar to agents seeing them for the first
      // time. Warnings render before the body so the agent sees them upfront.
      headerLines.push(`Mode: ${protocolMode}`);
      headerLines.push(`Version: ${versionStr}`);
      if (bytes) headerLines.push(`Bytes: ${bytes}`);
      if (result.updatedByKey) headerLines.push(`Updated by: ${result.updatedByKey}`);
      if (result.changeSummary) headerLines.push(`Change summary: ${result.changeSummary}`);
      // F3 raw fields — surface templateId + skillsConfig so callers can compute
      // precise deltas (e.g. composed-mode refresh workflows that need the current
      // enabledSkillIds/disabledSkillIds before issuing an update_protocol call).
      if (result.templateId != null) headerLines.push(`Template ID: ${result.templateId as string}`);
      const sc = result.skillsConfig as Record<string, unknown> | null | undefined;
      if (sc != null) {
        const enabled = (sc.enabledSkillIds as string[] | undefined) ?? [];
        const disabled = (sc.disabledSkillIds as string[] | undefined) ?? [];
        const custom = sc.customContent as string | undefined;
        if (enabled.length > 0) headerLines.push(`Skills enabled: ${enabled.join(', ')}`);
        if (disabled.length > 0) headerLines.push(`Skills disabled: ${disabled.join(', ')}`);
        if (custom) headerLines.push(`Custom content: (present, ${custom.length} chars)`);
      }

      const warnings = result.warnings as string[] | undefined;
      if (warnings && warnings.length > 0) {
        headerLines.push('');
        headerLines.push('Warnings:');
        for (const w of warnings) headerLines.push(`  - ${w}`);
      }

      if (protocolMode === 'composed-lazy') {
        // Lazy: show coreContent + manifest. Agent fetches skill bodies via
        // haops_read_skill on demand.
        const skillRefs = (result.skillRefs as Array<Record<string, unknown>> | undefined) ?? [];
        headerLines.push('');
        headerLines.push(`Skill manifest (${skillRefs.length} skills — use haops_read_skill to fetch bodies):`);
        for (const ref of skillRefs) {
          const flags: string[] = [];
          if (ref.required) flags.push('REQUIRED');
          if (ref.deprecated) flags.push('DEPRECATED');
          if (ref.missing) flags.push('MISSING');
          if (ref.shadowedSystemId) flags.push('shadows-system');
          const flagStr = flags.length ? ` [${flags.join(', ')}]` : '';
          headerLines.push(
            `  - ${ref.name as string} (${ref.scope as string} v${ref.version})${flagStr}`,
          );
        }
        headerLines.push('');
        headerLines.push('--- Core protocol (boot section + customContent) ---');
        headerLines.push('');
        headerLines.push((result.coreContent as string) || '(empty)');
      } else if (protocolMode === 'composed-bundle') {
        // Bundle: full composed body. Manifest also returned for transparency.
        const skillRefs = (result.skillRefs as Array<Record<string, unknown>> | undefined) ?? [];
        headerLines.push('');
        headerLines.push(`Composed from ${skillRefs.length} skills (manifest below body)`);
        headerLines.push('');
        headerLines.push('--- Composed protocol body ---');
        headerLines.push('');
        headerLines.push((result.body as string) || '(empty)');
        if (skillRefs.length > 0) {
          headerLines.push('');
          headerLines.push('--- Manifest ---');
          for (const ref of skillRefs) {
            const flags: string[] = [];
            if (ref.required) flags.push('REQUIRED');
            if (ref.deprecated) flags.push('DEPRECATED');
            if (ref.missing) flags.push('MISSING');
            if (ref.shadowedSystemId) flags.push('shadows-system');
            const flagStr = flags.length ? ` [${flags.join(', ')}]` : '';
            headerLines.push(
              `  - ${ref.name as string} (${ref.scope as string} v${ref.version})${flagStr}`,
            );
          }
        }
      } else {
        // Unknown mode (forward-compat) — render whatever body we got and tag
        // it so we notice if the server ships a new mode without an MCP bump.
        headerLines.push('');
        headerLines.push(`(unknown protocol mode "${protocolMode}" — rendering body verbatim)`);
        headerLines.push('');
        headerLines.push(
          (result.body as string) ?? (result.content as string) ?? '(empty)',
        );
      }

      return {
        content: [{ type: 'text', text: headerLines.filter((l) => l !== undefined).join('\n') }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error reading protocol: ${message}` }],
        isError: true,
      };
    }
  }

  if (name === 'haops_update_protocol') {
    try {
      const { projectSlug, role, content, changeSummary, templateId, skillsConfig } = args as {
        projectSlug: string;
        role: string;
        content?: string;
        changeSummary?: string;
        templateId?: string | null;
        skillsConfig?: {
          enabledSkillIds?: string[];
          disabledSkillIds?: string[];
          customContent?: string | null;
        } | null;
      };

      const result = await apiClient.updateProtocol(
        projectSlug,
        role,
        content,
        changeSummary,
        templateId,
        skillsConfig,
      );

      return {
        content: [{ type: 'text', text: `Protocol updated successfully.\nRole: ${role}\nVersion: ${result.version}\nID: ${result.id}` }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error updating protocol: ${message}` }],
        isError: true,
      };
    }
  }

  if (name === 'haops_list_protocol_versions') {
    try {
      const { projectSlug, role } = args as {
        projectSlug: string;
        role: string;
      };

      const result = await apiClient.listProtocolVersions(projectSlug, role);

      if (!result.versions || result.versions.length === 0) {
        return {
          content: [{ type: 'text', text: `No protocol versions found for role "${role}" in project "${projectSlug}".` }],
        };
      }

      const lines = [
        `Protocol versions for role "${role}" (${result.versions.length} total):`,
        '',
      ];

      for (const v of result.versions) {
        const current = v.isCurrent ? ' ← CURRENT' : '';
        const summary = v.changeSummary ? ` — ${v.changeSummary}` : '';
        const author = v.updatedByKey || (v.updatedBy as Record<string, unknown>)?.name || 'unknown';
        lines.push(`- v${v.version}${current}: ${v.createdAt} by ${author}${summary}`);
      }

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error listing protocol versions: ${message}` }],
        isError: true,
      };
    }
  }

  // ===== Protocol Health Handler (P·A·I3) =====

  if (name === 'haops_get_protocol_health') {
    try {
      const { projectSlug, includeSnapshots, raw } = args as {
        projectSlug: string;
        includeSnapshots?: boolean;
        raw?: boolean;
      };

      const health = await apiClient.getProtocolHealth(projectSlug, { includeSnapshots });

      if (raw) {
        return {
          content: [{ type: 'text', text: JSON.stringify(health, null, 2) }],
        };
      }

      // Formatted table output
      const ROLES = ['architect', 'dev', 'qa', 'devops'] as const;
      type RoleKey = (typeof ROLES)[number];

      const pad = (s: string, n: number) => s.padEnd(n);
      const header =
        `${pad('Role', 13)}| ${pad('Status', 8)}| ${pad('Skills', 7)}| ${pad('Missing', 8)}| ${pad('Deprecated', 11)}| Size`;
      const divider =
        `${'-'.repeat(13)}|${'-'.repeat(9)}|${'-'.repeat(8)}|${'-'.repeat(9)}|${'-'.repeat(12)}|------`;

      const rows: string[] = [header, divider];
      const missingDetails: string[] = [];
      const deprecatedDetails: string[] = [];

      for (const role of ROLES) {
        const r = health.roles[role as RoleKey];
        // Determine per-role status
        let roleStatus: string;
        if (r.error) {
          roleStatus = 'error';
        } else if (r.missingCount > 0) {
          roleStatus = 'error';
        } else if (r.deprecatedCount > 0 || r.warnings.length > 0) {
          roleStatus = 'warn';
        } else if (r.isLegacy) {
          roleStatus = 'legacy';
        } else {
          roleStatus = 'ok';
        }

        const sizeKb = r.bytes > 0 ? `${(r.bytes / 1024).toFixed(1)} KB` : '—';
        rows.push(
          `${pad(role, 13)}| ${pad(roleStatus, 8)}| ${pad(String(r.skillCount), 7)}| ${pad(String(r.missingCount), 8)}| ${pad(String(r.deprecatedCount), 11)}| ${sizeKb}`,
        );

        if (r.missingCount > 0 && r.warnings.length > 0) {
          const missingWarnings = r.warnings.filter((w) => w.startsWith('missing:') || w.includes('missing'));
          if (missingWarnings.length > 0) {
            missingDetails.push(`  ${role}: ${missingWarnings.join(', ')}`);
          } else {
            missingDetails.push(`  ${role}: ${r.missingCount} missing skill(s) — see raw output for UUIDs`);
          }
        }

        if (r.deprecatedCount > 0) {
          const deprecatedWarnings = r.warnings.filter((w) => w.startsWith('deprecated:') || w.includes('deprecated'));
          if (deprecatedWarnings.length > 0) {
            deprecatedDetails.push(`  ${role}: ${deprecatedWarnings.join(', ')}`);
          } else {
            deprecatedDetails.push(`  ${role}: ${r.deprecatedCount} deprecated reference(s)`);
          }
        }
      }

      // Summary line
      const summaryStatus = health.summary.status.toUpperCase();
      rows.push('');
      rows.push(`Summary: ${summaryStatus} — warnings=${health.summary.totalWarnings}, missing=${health.summary.totalMissing}, deprecated=${health.summary.totalDeprecated}`);

      // Pack health
      if (health.packHealth.warnings.length > 0) {
        rows.push('');
        rows.push(`Pack health: ${health.packHealth.warnings.length} warning(s) across ${health.packHealth.totalPacksScanned} pack(s) scanned`);
        for (const w of health.packHealth.warnings) {
          rows.push(`  ${w.packName} (${w.packId}): skill ${w.skillId} is ${w.reason}`);
        }
      }

      // Detail blocks
      if (missingDetails.length > 0) {
        rows.push('');
        rows.push('Missing skills:');
        rows.push(...missingDetails);
      }

      if (deprecatedDetails.length > 0) {
        rows.push('');
        rows.push('Deprecated references:');
        rows.push(...deprecatedDetails);
      }

      // Snapshot info
      if (includeSnapshots && health.previousSnapshot) {
        rows.push('');
        rows.push(`Last background scan: ${health.previousSnapshot.scannedAt}`);
      }

      return {
        content: [{ type: 'text', text: rows.join('\n') }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error getting protocol health: ${message}` }],
        isError: true,
      };
    }
  }

  // ===== Skills Library Tool Handlers (F1) =====

  if (name === 'haops_list_skills') {
    try {
      const opts = args as {
        scope?: 'system' | 'project';
        category?: string;
        role?: string;
        projectSlug?: string;
        search?: string;
        includeDeprecated?: boolean;
      };

      const skills = await apiClient.listSkills(opts);

      if (skills.length === 0) {
        return {
          content: [{ type: 'text', text: 'No skills found for the given filters.' }],
        };
      }

      // One line per skill — name, scope, category, applicable roles, id, deprecated flag.
      // The full content is fetched on demand via haops_read_skill so we don't blow
      // the agent's context window on every list.
      const lines = [`Found ${skills.length} skill(s):`, ''];
      for (const s of skills) {
        const scope = s.scope as string;
        const category = s.category as string;
        const roles = Array.isArray(s.applicableRoles)
          ? (s.applicableRoles as string[]).join(', ')
          : 'unknown';
        const dep = s.isDeprecated ? ' [DEPRECATED]' : '';
        const ver = s.version ? ` v${s.version}` : '';
        const desc = s.description ? ` — ${s.description}` : '';
        const id = s.id ? ` (id: ${s.id as string})` : '';
        lines.push(`- ${s.name as string} (${scope}/${category}${ver}) roles=[${roles}]${dep}${desc}${id}`);
      }

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error listing skills: ${message}` }],
        isError: true,
      };
    }
  }

  if (name === 'haops_read_skill') {
    try {
      const { name: skillName, scope, projectSlug, version, raw } = args as {
        name: string;
        scope?: 'system' | 'project';
        projectSlug?: string;
        version?: number;
        raw?: boolean;
      };

      const skill = await apiClient.readSkill(skillName, { scope, projectSlug, version });

      if (raw) {
        return {
          content: [{ type: 'text', text: JSON.stringify(skill, null, 2) }],
        };
      }

      const roles = Array.isArray(skill.applicableRoles)
        ? (skill.applicableRoles as string[]).join(', ')
        : 'unknown';
      const header = [
        `Skill: ${skill.name as string}`,
        `ID: ${skill.id as string}`,
        `Scope: ${skill.scope as string}`,
        `Category: ${skill.category as string}`,
        `Version: ${skill.version ?? 'N/A'}`,
        `Applicable roles: ${roles}`,
        skill.isDeprecated ? 'Status: DEPRECATED' : '',
        skill.description ? `Description: ${skill.description as string}` : '',
        '',
        '---',
        '',
        (skill.content as string) || '(empty)',
      ].filter(Boolean);

      return {
        content: [{ type: 'text', text: header.join('\n') }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error reading skill: ${message}` }],
        isError: true,
      };
    }
  }

  // ===== Skills Library Mutation Handlers (P1·I1) =====
  //
  // Server-side notes (mirrored from app/api/skills/{route.ts,[name]/route.ts}):
  //   - Admin-only — non-admin API keys get 403.
  //   - Feature-flagged via ENABLE_COMPOSED_PROTOCOLS. When OFF, the routes
  //     return a bare {error:'Not found'} 404 by design ("looks absent"). We
  //     detect that specific shape and rewrite the message so the agent gets a
  //     useful hint instead of a generic 404 ("did I typo the skill name?").
  //   - PUT diffs against the current row and returns the current row WITHOUT a
  //     version bump when nothing changed (noop). We mirror that signal by
  //     showing the returned version in the success message.
  //   - DELETE soft-cascades across all versions and returns {message,versionCount}.

  const formatSkillMutationError = (error: unknown, action: string): string => {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    // The flag-off 404 has the exact body `{error:'Not found'}`, surfaced as the
    // message 'Not found' by HAOpsApiClient.handleError. Treat that as a hint.
    if (msg === 'Not found') {
      return `Error ${action}: Composed protocols feature is disabled on the server (ENABLE_COMPOSED_PROTOCOLS=false). Ask the admin to enable it before retrying.`;
    }
    return `Error ${action}: ${msg}`;
  };

  if (name === 'haops_create_skill') {
    try {
      const {
        scope,
        name: skillName,
        description,
        content,
        category,
        applicableRoles,
        projectSlug,
      } = args as {
        scope: 'system' | 'project';
        name: string;
        description: string;
        content: string;
        category: string;
        applicableRoles: string[];
        projectSlug?: string;
      };

      const skill = await apiClient.createSkill({
        scope,
        name: skillName,
        description,
        content,
        category: category as never, // narrowed by server-side validation
        applicableRoles,
        projectSlug,
      });

      const roles = Array.isArray(skill.applicableRoles)
        ? (skill.applicableRoles as string[]).join(', ')
        : 'unknown';
      const lines = [
        `Skill created: ${skill.name as string}`,
        `Scope: ${skill.scope as string}${skill.projectId ? ` (projectId=${skill.projectId as string})` : ''}`,
        `Category: ${skill.category as string}`,
        `Version: ${skill.version ?? 1}`,
        `Applicable roles: ${roles}`,
        `Skill ID: ${skill.id as string}`,
      ];
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: formatSkillMutationError(error, 'creating skill') }],
        isError: true,
      };
    }
  }

  // ===== History Handlers (P·B·I2) =====

  if (name === 'haops_get_skill_history') {
    try {
      const { name: skillName, scope, projectSlug, diff, raw } = args as {
        name: string;
        scope?: 'system' | 'project';
        projectSlug?: string;
        diff?: boolean;
        raw?: boolean;
      };

      const history = await apiClient.getSkillHistory(skillName, { scope, projectSlug, diff });

      if (raw) {
        return { content: [{ type: 'text', text: JSON.stringify(history, null, 2) }] };
      }

      if (history.length === 0) {
        return { content: [{ type: 'text', text: `No history found for skill "${skillName}".` }] };
      }

      const lines = [
        `Skill history: ${skillName} (${history.length} version(s))`,
        '',
      ];
      for (const entry of history) {
        lines.push(`Version ${entry.version ?? '?'} — ${entry.createdAt ?? entry.publishedAt ?? 'unknown date'}`);
        if (entry.publishedBy ?? entry.createdBy) lines.push(`  Author: ${entry.publishedBy ?? entry.createdBy}`);
        if (entry.lifecycleState ?? entry.status) lines.push(`  State: ${entry.lifecycleState ?? entry.status}`);
        if (entry.description) lines.push(`  Description: ${entry.description as string}`);
        if (diff && entry.diff) {
          lines.push('  Diff:');
          lines.push('  ```diff');
          lines.push(`  ${(entry.diff as string).replace(/\n/g, '\n  ')}`);
          lines.push('  ```');
        }
        lines.push('');
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error getting skill history: ${message}` }],
        isError: true,
      };
    }
  }

  if (name === 'haops_get_role_template_history') {
    try {
      const { name: templateName, diff, raw } = args as {
        name: string;
        diff?: boolean;
        raw?: boolean;
      };

      const history = await apiClient.getRoleTemplateHistory(templateName, { diff });

      if (raw) {
        return { content: [{ type: 'text', text: JSON.stringify(history, null, 2) }] };
      }

      if (history.length === 0) {
        return { content: [{ type: 'text', text: `No history found for role template "${templateName}".` }] };
      }

      const lines = [
        `Role template history: ${templateName} (${history.length} version(s))`,
        '',
      ];
      for (const entry of history) {
        lines.push(`Version ${entry.version ?? '?'} — ${entry.createdAt ?? entry.publishedAt ?? 'unknown date'}`);
        if (entry.publishedBy ?? entry.createdBy) lines.push(`  Author: ${entry.publishedBy ?? entry.createdBy}`);
        if (entry.lifecycleState ?? entry.status) lines.push(`  State: ${entry.lifecycleState ?? entry.status}`);
        if (entry.baseRole) lines.push(`  Base role: ${entry.baseRole as string}`);
        if (entry.description) lines.push(`  Description: ${entry.description as string}`);
        if (diff && entry.diff) {
          lines.push('  Diff:');
          lines.push('  ```diff');
          lines.push(`  ${(entry.diff as string).replace(/\n/g, '\n  ')}`);
          lines.push('  ```');
        }
        lines.push('');
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error getting role template history: ${message}` }],
        isError: true,
      };
    }
  }

  // ===== Bulk Publish Skills Handler (P·B·I6) =====

  if (name === 'haops_bulk_publish_skills') {
    try {
      const { entries, cascade, verbose } = args as {
        entries: Array<{
          name: string;
          scope: 'system' | 'project';
          projectSlug?: string;
          content?: string;
          description?: string;
          category?: string;
          applicableRoles?: string[];
        }>;
        cascade?: boolean;
        verbose?: boolean;
      };

      const result = await apiClient.bulkPublishSkills(entries, { cascade });

      const lines: string[] = [
        `Bulk publish: ${result.totalUpdated} updated, ${result.totalFailed} failed (${entries.length} entries total)`,
        '',
      ];

      if (result.totalFailed > 0) {
        lines.push('FAILURES:');
        for (const r of result.results) {
          if (!r.success) {
            lines.push(`  FAIL  ${r.name} (${r.scope}): ${r.error ?? 'unknown error'}`);
          }
        }
        lines.push('');
        lines.push('NOTE: entire transaction was rolled back — no skills were published.');
        lines.push('');
      }

      lines.push('Results per entry:');
      for (const r of result.results) {
        const status = r.success ? 'OK  ' : 'FAIL';
        const ver = r.version !== undefined ? ` → v${r.version}` : '';
        const err = !r.success && r.error ? ` (${r.error})` : '';
        lines.push(`  ${status}  ${r.name} (${r.scope})${ver}${err}`);
        if (verbose && r.skill) {
          lines.push(`        ${JSON.stringify(r.skill)}`);
        }
      }

      if (result.cascadeReport) {
        lines.push('');
        lines.push('Cascade report:');
        lines.push(JSON.stringify(result.cascadeReport, null, 2).replace(/^/gm, '  '));
      }

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        isError: result.totalFailed > 0,
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: formatSkillMutationError(error, 'bulk publishing skills') }],
        isError: true,
      };
    }
  }

  // ===== Project-scope Skill Creation Handler (P·B·I5) =====

  if (name === 'haops_create_project_skill') {
    try {
      const {
        projectSlug,
        name: skillName,
        description,
        content,
        category,
        applicableRoles,
        spawnLine,
        verbose,
      } = args as {
        projectSlug: string;
        name: string;
        description: string;
        content: string;
        category: string;
        applicableRoles: string[];
        spawnLine?: string;
        verbose?: boolean;
      };

      const skill = await apiClient.createProjectSkill(projectSlug, {
        name: skillName,
        description,
        content,
        category,
        applicableRoles,
        spawnLine,
      });

      if (verbose) {
        return { content: [{ type: 'text', text: JSON.stringify(skill, null, 2) }] };
      }

      const roles = Array.isArray(skill.applicableRoles)
        ? (skill.applicableRoles as string[]).join(', ')
        : 'unknown';
      const lines = [
        `Project skill created: ${skill.name as string}`,
        `Project: ${projectSlug}${skill.projectId ? ` (projectId=${skill.projectId as string})` : ''}`,
        `Scope: project`,
        `Category: ${skill.category as string}`,
        `Version: ${skill.version ?? 1}`,
        `Applicable roles: ${roles}`,
        `Skill ID: ${skill.id as string}`,
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: formatSkillMutationError(error, 'creating project skill') }],
        isError: true,
      };
    }
  }

  // ===== Spawn Lines Handler (P·B·I4) =====

  if (name === 'haops_get_protocol_spawn_lines') {
    try {
      const { projectSlug, role, raw } = args as {
        projectSlug: string;
        role?: string;
        raw?: boolean;
      };

      const result = await apiClient.getProtocolSpawnLines(projectSlug, { role });

      if (raw) {
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      const lines: string[] = [
        `Spawn lines for project "${projectSlug}"${role ? ` (role: ${role})` : ' (all roles)'}:`,
        '',
      ];

      // The server may return either { [role]: spawnLine } map or an array
      // of { role, spawnLine } objects — handle both shapes defensively.
      if (Array.isArray(result)) {
        for (const entry of result as Array<Record<string, unknown>>) {
          lines.push(`${entry.role as string}:`);
          lines.push(`  ${entry.spawnLine as string}`);
          lines.push('');
        }
      } else {
        // Object map: { architect: '...', dev: '...', ... } or
        // single { role, spawnLine } when a specific role was requested.
        if (typeof result.spawnLine === 'string') {
          // Single role response
          lines.push(`${result.role as string}:`);
          lines.push(`  ${result.spawnLine}`);
        } else {
          for (const [r, spawnLine] of Object.entries(result)) {
            if (typeof spawnLine === 'string') {
              lines.push(`${r}:`);
              lines.push(`  ${spawnLine}`);
              lines.push('');
            }
          }
        }
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      const hint = message === 'Not found'
        ? 'Error getting spawn lines: Composed protocols feature is disabled on the server (ENABLE_COMPOSED_PROTOCOLS=false). Ask the admin to enable it before retrying.'
        : `Error getting spawn lines: ${message}`;
      return { content: [{ type: 'text', text: hint }], isError: true };
    }
  }

  // ===== Protocol Preview Handler (P·B·I3) =====

  if (name === 'haops_preview_project_protocol') {
    try {
      const { projectSlug, role, templateId, enabledSkillIds, disabledSkillIds, customContent, raw } = args as {
        projectSlug: string;
        role: string;
        templateId?: string;
        enabledSkillIds?: string[];
        disabledSkillIds?: string[];
        customContent?: string;
        raw?: boolean;
      };

      const result = await apiClient.previewProjectProtocol(projectSlug, role, {
        templateId,
        enabledSkillIds,
        disabledSkillIds,
        customContent,
      });

      if (raw) {
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      // Reuse the same rendering logic as haops_read_protocol but prefix with
      // a [DRY-RUN] banner so the agent cannot confuse this with a persisted read.
      const protocolMode = (result.mode as string | undefined) ?? 'composed-lazy';
      const versionStr = String(result.version ?? 'preview');
      const bytes = (result.bytes as number | undefined) ?? 0;

      const lines: string[] = [
        `[DRY-RUN] Protocol preview for role "${role}" in project "${projectSlug}":`,
        `Mode: ${protocolMode}`,
        `Version (current): ${versionStr}`,
      ];
      if (bytes) lines.push(`Estimated bytes: ${bytes}`);
      if (result.templateId != null) lines.push(`Template ID: ${result.templateId as string}`);

      const sc = result.skillsConfig as Record<string, unknown> | null | undefined;
      if (sc != null) {
        const enabled = (sc.enabledSkillIds as string[] | undefined) ?? [];
        const disabled = (sc.disabledSkillIds as string[] | undefined) ?? [];
        const custom = sc.customContent as string | undefined;
        if (enabled.length > 0) lines.push(`Skills enabled: ${enabled.join(', ')}`);
        if (disabled.length > 0) lines.push(`Skills disabled: ${disabled.join(', ')}`);
        if (custom) lines.push(`Custom content: (present, ${custom.length} chars)`);
      }

      const warnings = result.warnings as string[] | undefined;
      if (warnings && warnings.length > 0) {
        lines.push('');
        lines.push('Warnings:');
        for (const w of warnings) lines.push(`  - ${w}`);
      }

      const skillRefs = (result.skillRefs as Array<Record<string, unknown>> | undefined) ?? [];
      if (skillRefs.length > 0) {
        lines.push('');
        lines.push(`Skill manifest (${skillRefs.length} skills — preview, NOT persisted):`);
        for (const ref of skillRefs) {
          const flags: string[] = [];
          if (ref.required) flags.push('REQUIRED');
          if (ref.deprecated) flags.push('DEPRECATED');
          if (ref.missing) flags.push('MISSING');
          const flagStr = flags.length ? ` [${flags.join(', ')}]` : '';
          lines.push(`  - ${ref.name as string} (${ref.scope as string} v${ref.version})${flagStr}`);
        }
      }

      lines.push('');
      lines.push('--- Protocol body preview ---');
      lines.push('');
      const body = (result.coreContent as string) ?? (result.body as string) ?? '(empty)';
      lines.push(body);

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      const hint = message === 'Not found'
        ? 'Error previewing protocol: Composed protocols feature is disabled on the server (ENABLE_COMPOSED_PROTOCOLS=false). Ask the admin to enable it before retrying.'
        : `Error previewing protocol: ${message}`;
      return { content: [{ type: 'text', text: hint }], isError: true };
    }
  }

  // ===== Cascade Preview Handlers (P·A·I4) =====

  if (name === 'haops_preview_skill_cascade') {
    try {
      const { name: skillName, scope, projectSlug, raw } = args as {
        name: string;
        scope: 'system' | 'project';
        projectSlug?: string;
        raw?: boolean;
      };

      const preview = await apiClient.previewSkillCascade(skillName, scope, projectSlug);

      if (raw) {
        return {
          content: [{ type: 'text', text: JSON.stringify(preview, null, 2) }],
        };
      }

      const cp = preview.cascadePreview;
      const lines: string[] = [
        `If skill ${preview.skillName} (current UUID ${preview.skillId}) is bumped, the following consumers reference the CURRENT UUID and would need rewiring:`,
        '',
        `Role Templates (${cp.templates.length}):`,
      ];
      if (cp.templates.length === 0) {
        lines.push('  (none)');
      } else {
        for (const t of cp.templates) {
          const req = t.required ? ' [REQUIRED]' : '';
          lines.push(`  - ${t.templateName} (defaultSkills[].skillId)${req}`);
        }
      }
      lines.push('');
      lines.push(`Skill Packs (${cp.packs.length}):`);
      if (cp.packs.length === 0) {
        lines.push('  (none)');
      } else {
        for (const p of cp.packs) {
          lines.push(`  - ${p.packName} (skillIds[])`);
        }
      }
      lines.push('');
      lines.push(`Project Protocols (${cp.protocolsBySkill.length}):`);
      if (cp.protocolsBySkill.length === 0) {
        lines.push('  (none)');
      } else {
        for (const proto of cp.protocolsBySkill) {
          lines.push(`  - project:${proto.projectId} role:${proto.role} v${proto.version} (skillsConfig.enabledSkillIds[])`);
        }
      }
      if (cp.warnings.length > 0) {
        lines.push('');
        lines.push('Warnings:');
        for (const w of cp.warnings) {
          lines.push(`  ⚠  ${w}`);
        }
      }
      lines.push('');
      lines.push(`Total consumers: ${cp.count}`);
      if (cp.count > 0) {
        lines.push(`→ Run haops_update_skill({ name: "${skillName}", ..., cascade: true }) to re-wire atomically.`);
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      const hint =
        error instanceof Error && /404|not found/i.test(error.message)
          ? ' (skill not found, or composed-protocols feature is disabled on the server)'
          : '';
      return {
        content: [{ type: 'text', text: `Error previewing skill cascade: ${message}${hint}` }],
        isError: true,
      };
    }
  }

  if (name === 'haops_preview_role_template_cascade') {
    try {
      const { name: templateName, raw } = args as {
        name: string;
        raw?: boolean;
      };

      const preview = await apiClient.previewRoleTemplateCascade(templateName);

      if (raw) {
        return {
          content: [{ type: 'text', text: JSON.stringify(preview, null, 2) }],
        };
      }

      const cp = preview.cascadePreview;
      const lines: string[] = [
        `If role template ${preview.templateName} (current UUID ${preview.templateId}) is bumped, the following consumers reference the CURRENT UUID and would need rewiring:`,
        '',
        `Project Protocols (${cp.protocolsByTemplate.length}):`,
      ];
      if (cp.protocolsByTemplate.length === 0) {
        lines.push('  (none)');
      } else {
        for (const proto of cp.protocolsByTemplate) {
          lines.push(`  - project:${proto.projectId} role:${proto.role} v${proto.version} (templateId)`);
        }
      }
      lines.push('');
      lines.push(`Total consumers: ${cp.count}`);
      if (cp.count > 0) {
        lines.push(`→ Run haops_update_role_template({ name: "${templateName}", ..., cascade: true }) to re-wire atomically.`);
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      const hint =
        error instanceof Error && /404|not found/i.test(error.message)
          ? ' (template not found, or composed-protocols feature is disabled on the server)'
          : '';
      return {
        content: [{ type: 'text', text: `Error previewing role template cascade: ${message}${hint}` }],
        isError: true,
      };
    }
  }

  if (name === 'haops_update_skill') {
    try {
      const {
        name: skillName,
        scope,
        projectSlug,
        description,
        content,
        category,
        applicableRoles,
        isDeprecated,
        cascade,
      } = args as {
        name: string;
        scope?: 'system' | 'project';
        projectSlug?: string;
        description?: string;
        content?: string;
        category?: string;
        applicableRoles?: string[];
        isDeprecated?: boolean;
        cascade?: boolean;
      };

      // Build the payload from supplied fields only. The server requires at
      // least one mutable field — we forward whatever the caller gave us and
      // let the server diff against the current row to decide noop vs publish.
      const payload: Record<string, unknown> = {};
      if (description !== undefined) payload.description = description;
      if (content !== undefined) payload.content = content;
      if (category !== undefined) payload.category = category;
      if (applicableRoles !== undefined) payload.applicableRoles = applicableRoles;
      if (isDeprecated !== undefined) payload.isDeprecated = isDeprecated;

      const skill = await apiClient.updateSkill(
        skillName,
        { scope, projectSlug, cascade },
        payload as never,
      );

      const roles = Array.isArray(skill.applicableRoles)
        ? (skill.applicableRoles as string[]).join(', ')
        : 'unknown';
      const lines = [
        `Skill updated: ${skill.name as string}`,
        `Scope: ${skill.scope as string}`,
        `Category: ${skill.category as string}`,
        `Version: ${skill.version ?? 'N/A'} (no version bump = no-op update; new value = published new version)`,
        `Applicable roles: ${roles}`,
        skill.isDeprecated ? 'Status: DEPRECATED' : 'Status: active',
        `Skill ID: ${skill.id as string}`,
      ];
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: formatSkillMutationError(error, 'updating skill') }],
        isError: true,
      };
    }
  }

  if (name === 'haops_deprecate_skill') {
    try {
      const { name: skillName, scope, projectSlug } = args as {
        name: string;
        scope?: 'system' | 'project';
        projectSlug?: string;
      };

      const result = await apiClient.deprecateSkill(skillName, { scope, projectSlug });

      const lines = [
        `Skill deprecated: ${skillName}`,
        `Scope: ${scope ?? 'system'}${projectSlug ? ` (projectSlug=${projectSlug})` : ''}`,
        `Soft-deleted ${result.versionCount} version(s) (current + historical).`,
        `Server message: ${result.message}`,
        '',
        'Note: history rows remain readable via /api/skills/[name]/history for audit context.',
      ];
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: formatSkillMutationError(error, 'deprecating skill') }],
        isError: true,
      };
    }
  }

  // ===== Role Template Tool Handlers (F2) =====

  if (name === 'haops_list_role_templates') {
    try {
      const opts = args as { baseRole?: string; search?: string };
      const templates = await apiClient.listRoleTemplates(opts);

      if (templates.length === 0) {
        return {
          content: [{ type: 'text', text: 'No role templates found for the given filters.' }],
        };
      }

      // One line per template — name, base role, system flag, default-skill
      // count, id. The full baseBody is fetched on demand via
      // haops_read_role_template so we don't blow the agent's context window
      // on every list (baseBody can be 50-200 lines per template).
      const lines = [`Found ${templates.length} role template(s):`, ''];
      for (const t of templates) {
        const baseRole = (t.baseRole as string) ?? 'unknown';
        const system = t.isSystem ? ' [system]' : '';
        const ver = t.version ? ` v${t.version}` : '';
        const skills = Array.isArray(t.defaultSkills)
          ? (t.defaultSkills as unknown[]).length
          : 0;
        const desc = t.description ? ` — ${t.description as string}` : '';
        const id = t.id ? ` (id: ${t.id as string})` : '';
        lines.push(`- ${t.name as string} (${baseRole}${ver})${system} defaultSkills=${skills}${desc}${id}`);
      }

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error listing role templates: ${message}` }],
        isError: true,
      };
    }
  }

  if (name === 'haops_read_role_template') {
    try {
      const { name: templateName, raw } = args as { name: string; raw?: boolean };
      const template = await apiClient.readRoleTemplate(templateName);

      if (raw) {
        return {
          content: [{ type: 'text', text: JSON.stringify(template, null, 2) }],
        };
      }

      // Default skills come back hydrated from the API (name + description
      // included). Render one line per skill so the agent gets the full
      // bundle context without a second round-trip.
      const skillLines: string[] = [];
      if (Array.isArray(template.defaultSkills)) {
        for (const entry of template.defaultSkills as Array<Record<string, unknown>>) {
          const required = entry.required ? '*' : ' ';
          const skill = (entry.skill as Record<string, unknown> | undefined) ?? {};
          const sname = (skill.name as string) ?? `(missing skillId ${entry.skillId as string})`;
          const sdesc = skill.description ? ` — ${skill.description as string}` : '';
          skillLines.push(`  ${required} ${sname}${sdesc}`);
        }
      }

      const header = [
        `Role Template: ${template.name as string}`,
        `ID: ${template.id as string}`,
        `Base role: ${template.baseRole as string}`,
        `Version: ${template.version ?? 'N/A'}`,
        template.isSystem ? 'System: true (DELETE blocked at API)' : 'System: false',
        template.description ? `Description: ${template.description as string}` : '',
        '',
        skillLines.length > 0
          ? `Default skills (* = required):\n${skillLines.join('\n')}`
          : 'Default skills: (none)',
        '',
        '---',
        '',
        (template.baseBody as string) || '(empty)',
      ].filter(Boolean);

      return {
        content: [{ type: 'text', text: header.join('\n') }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error reading role template: ${message}` }],
        isError: true,
      };
    }
  }

  if (name === 'haops_create_role_template') {
    try {
      const {
        name: templateName,
        baseRole,
        baseBody,
        description,
        defaultSkills,
      } = args as {
        name: string;
        baseRole: string;
        baseBody: string;
        description?: string | null;
        defaultSkills?: Array<{ skillId: string; required: boolean }>;
      };

      const body: {
        name: string;
        baseRole: string;
        baseBody: string;
        description?: string | null;
        defaultSkills?: Array<{ skillId: string; required: boolean }>;
      } = { name: templateName, baseRole, baseBody };
      if (description !== undefined) body.description = description;
      if (defaultSkills !== undefined) body.defaultSkills = defaultSkills;

      const template = await apiClient.createRoleTemplate(body);

      const skills = Array.isArray(template.defaultSkills)
        ? (template.defaultSkills as unknown[]).length
        : 0;
      const lines = [
        `Role template created: ${template.name as string}`,
        `ID: ${template.id as string}`,
        `Base role: ${template.baseRole as string}`,
        `Version: ${template.version ?? 1}`,
        `Default skills: ${skills}`,
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      // The composed-protocols flag flips POST → 404 by design. Surface a
      // user-friendly hint so agents don't chase a missing-route bug when
      // the surface is intentionally dormant.
      const hint =
        error instanceof Error && /404|not found/i.test(error.message)
          ? ' (the composed-protocols feature may be disabled on the server)'
          : '';
      return {
        content: [{ type: 'text', text: `Error creating role template: ${message}${hint}` }],
        isError: true,
      };
    }
  }

  if (name === 'haops_update_role_template') {
    try {
      const {
        name: templateName,
        baseRole,
        description,
        baseBody,
        defaultSkills,
        cascade,
      } = args as {
        name: string;
        baseRole?: string;
        description?: string | null;
        baseBody?: string;
        defaultSkills?: Array<{ skillId: string; required: boolean }>;
        cascade?: boolean;
      };

      const body: {
        baseRole?: string;
        description?: string | null;
        baseBody?: string;
        defaultSkills?: Array<{ skillId: string; required: boolean }>;
      } = {};
      if (baseRole !== undefined) body.baseRole = baseRole;
      if (description !== undefined) body.description = description;
      if (baseBody !== undefined) body.baseBody = baseBody;
      if (defaultSkills !== undefined) body.defaultSkills = defaultSkills;

      const template = await apiClient.updateRoleTemplate(templateName, body, { cascade });

      // Server returns the (possibly new) raw row — version bump signals a
      // real publish vs. a no-op PUT. Surface both outcomes plainly so the
      // agent knows whether a new version was created.
      const skills = Array.isArray(template.defaultSkills)
        ? (template.defaultSkills as unknown[]).length
        : 0;
      const lines = [
        `Role template updated: ${template.name as string}`,
        `ID: ${template.id as string}`,
        `Base role: ${template.baseRole as string}`,
        `Version: ${template.version ?? 'N/A'}`,
        `Default skills: ${skills}`,
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      const hint =
        error instanceof Error && /404|not found/i.test(error.message)
          ? ' (the template name may be wrong, or the composed-protocols feature may be disabled on the server)'
          : '';
      return {
        content: [{ type: 'text', text: `Error updating role template: ${message}${hint}` }],
        isError: true,
      };
    }
  }

  if (name === 'haops_deprecate_role_template') {
    try {
      const { name: templateName } = args as { name: string };
      const result = await apiClient.deprecateRoleTemplate(templateName);
      const lines = [
        `Role template deprecated: ${templateName}`,
        `Soft-deleted ${result.versionCount} version(s) (cascade)`,
        result.message,
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      const hint =
        error instanceof Error && /404|not found/i.test(error.message)
          ? ' (the template name may be wrong, or the composed-protocols feature may be disabled on the server)'
          : '';
      return {
        content: [{ type: 'text', text: `Error deprecating role template: ${message}${hint}` }],
        isError: true,
      };
    }
  }

  // ===== Skill Pack Tool Implementations (F7) =====

  if (name === 'haops_list_skill_packs') {
    try {
      const opts = args as { featured?: boolean; category?: string; search?: string };
      const packs = await apiClient.listSkillPacks(opts);

      if (packs.length === 0) {
        return {
          content: [{ type: 'text', text: 'No skill packs found for the given filters.' }],
        };
      }

      // One line per pack — name, category, system flag, featured flag,
      // skillCount, short description tail, id. Skill IDs themselves are NOT
      // hydrated server-side on the list endpoint (mirrors role-templates
      // pattern); agents can call GET /api/skill-packs/[name] via the admin
      // UI for hydration. Keeps the MCP response under any reasonable
      // context budget even when there are 50+ packs in the catalogue.
      const lines = [`Found ${packs.length} skill pack(s):`, ''];
      for (const p of packs) {
        const cat = (p.category as string) ?? 'unknown';
        const system = p.isSystem ? ' [system]' : '';
        const featured = p.isFeatured ? ' [featured]' : '';
        const skillIds = Array.isArray(p.skillIds) ? (p.skillIds as unknown[]).length : 0;
        const desc = p.description ? ` — ${p.description as string}` : '';
        const id = p.id ? ` (id: ${p.id as string})` : '';
        lines.push(`- ${p.name as string} (${cat})${featured}${system} skills=${skillIds}${desc}${id}`);
      }

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error listing skill packs: ${message}` }],
        isError: true,
      };
    }
  }

  if (name === 'haops_create_skill_pack') {
    try {
      const { name: packName, description, category, skillIds, isFeatured } = args as {
        name: string;
        description: string;
        category: string;
        skillIds?: string[];
        isFeatured?: boolean;
      };

      const body: {
        name: string;
        description: string;
        category: string;
        skillIds?: string[];
        isFeatured?: boolean;
      } = { name: packName, description, category };
      if (skillIds !== undefined) body.skillIds = skillIds;
      if (isFeatured !== undefined) body.isFeatured = isFeatured;

      const pack = await apiClient.createSkillPack(body);
      const idCount = Array.isArray(pack.skillIds)
        ? (pack.skillIds as unknown[]).length
        : 0;
      const { verbose } = args as { verbose?: boolean };
      return { content: [{ type: 'text', text: verbose
        ? `Skill pack created: ${pack.name as string} (${pack.category as string}, ${idCount} skill(s))\n${JSON.stringify(pack, null, 2)}`
        : `Created — ${pack.id as string} "${pack.name as string}" (${idCount} skills)` }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      // 404 from the gated POST means the feature flag is off on the server
      // — translate to a user-friendly message instead of leaking the bare
      // "Not found" the route returns by design.
      const statusCode =
        (error as { statusCode?: number } | null | undefined)?.statusCode;
      const friendly =
        statusCode === 404
          ? 'Composed protocols feature is disabled on the server (ENABLE_COMPOSED_PROTOCOLS=false). Skill pack mutations are unavailable until the flag is enabled.'
          : `Error creating skill pack: ${message}`;
      return {
        content: [{ type: 'text', text: friendly }],
        isError: true,
      };
    }
  }

  if (name === 'haops_update_skill_pack') {
    try {
      const { name: packName, description, category, skillIds, isFeatured } = args as {
        name: string;
        description?: string;
        category?: string;
        skillIds?: string[];
        isFeatured?: boolean;
      };

      const body: {
        description?: string;
        category?: string;
        skillIds?: string[];
        isFeatured?: boolean;
      } = {};
      if (description !== undefined) body.description = description;
      if (category !== undefined) body.category = category;
      if (skillIds !== undefined) body.skillIds = skillIds;
      if (isFeatured !== undefined) body.isFeatured = isFeatured;

      const pack = await apiClient.updateSkillPack(packName, body);
      const idCount = Array.isArray(pack.skillIds)
        ? (pack.skillIds as unknown[]).length
        : 0;
      const { verbose } = args as { verbose?: boolean };
      return { content: [{ type: 'text', text: verbose
        ? `Skill pack updated: ${pack.name as string} (${pack.category as string}, ${idCount} skill(s))\n${JSON.stringify(pack, null, 2)}`
        : `Updated — ${pack.id as string} "${pack.name as string}" (${idCount} skills)` }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      const statusCode =
        (error as { statusCode?: number } | null | undefined)?.statusCode;
      const friendly =
        statusCode === 404 && message === 'Not found'
          ? 'Composed protocols feature is disabled on the server (ENABLE_COMPOSED_PROTOCOLS=false). Skill pack mutations are unavailable until the flag is enabled.'
          : `Error updating skill pack: ${message}`;
      return {
        content: [{ type: 'text', text: friendly }],
        isError: true,
      };
    }
  }

  if (name === 'haops_deprecate_skill_pack') {
    try {
      const { name: packName } = args as { name: string };
      const result = await apiClient.deprecateSkillPack(packName);
      const msg = (result.message as string | undefined) ?? 'Skill pack deleted';
      return {
        content: [
          {
            type: 'text',
            text: `Skill pack '${packName}' deprecated: ${msg}`,
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      const statusCode =
        (error as { statusCode?: number } | null | undefined)?.statusCode;
      const friendly =
        statusCode === 404 && message === 'Not found'
          ? 'Composed protocols feature is disabled on the server (ENABLE_COMPOSED_PROTOCOLS=false). Skill pack mutations are unavailable until the flag is enabled.'
          : `Error deprecating skill pack: ${message}`;
      return {
        content: [{ type: 'text', text: friendly }],
        isError: true,
      };
    }
  }

  // ===== Lifecycle Transition Handlers (P2·I8) =====
  //
  // Three handlers — one per resource type (skill / role template / skill
  // pack), each gated on a single `action` enum. Consolidating into 3 tools
  // instead of 9 keeps the MCP catalogue small AND lets the action enum
  // double as in-schema documentation of the allowed transitions (the I9
  // E2E test driver reads the schema, not the prose).
  //
  // Error formatter handles three cases:
  //   (1) 409 invalid_transition — render the from/to/allowed envelope as a
  //       prescriptive hint so the agent knows the next legal move.
  //   (2) 404 'Not found' — feature-flag-off pattern (same as Phase 1 CRUD).
  //   (3) Anything else — passthrough the raw message.
  const formatTransitionError = (
    error: unknown,
    resource: 'skill' | 'role template' | 'skill pack',
    action: string,
  ): string => {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const apiError = error as
      | { statusCode?: number; response?: unknown }
      | null
      | undefined;
    const statusCode = apiError?.statusCode;

    // 409 invalid_transition: the server returns
    //   { error: 'invalid_transition', from, to, allowed: [...] }
    // via HAOpsApiClient.handleError which surfaces `error` as the message
    // and the full body on `.response`. Detect both signals before formatting.
    if (statusCode === 409 && message === 'invalid_transition') {
      const body = apiError?.response as
        | { from?: string; to?: string; allowed?: string[] }
        | undefined;
      const from = body?.from ?? 'unknown';
      const to = body?.to ?? action;
      const allowed = Array.isArray(body?.allowed) ? body!.allowed!.join(', ') : '(none)';
      return `Cannot transition ${resource} from '${from}' to '${to}' — allowed transitions from '${from}': [${allowed}]`;
    }

    // 404 from the gated POST means the feature flag is off — same pattern
    // as Phase 1 CRUD wrappers.
    if (statusCode === 404 && message === 'Not found') {
      return `Error transitioning ${resource}: Composed protocols feature is disabled on the server (ENABLE_COMPOSED_PROTOCOLS=false). Ask the admin to enable it before retrying.`;
    }

    return `Error transitioning ${resource} (action='${action}'): ${message}`;
  };

  if (name === 'haops_transition_skill') {
    try {
      const { name: skillName, scope, action, projectSlug } = args as {
        name: string;
        scope: 'system' | 'project';
        action: 'propose' | 'publish' | 'deprecate';
        projectSlug?: string;
      };

      const skill = await apiClient.transitionSkill({
        name: skillName,
        scope,
        action,
        projectSlug,
      });

      const lines = [
        `Skill transitioned: ${skill.name as string} → action='${action}'`,
        `Scope: ${skill.scope as string}${skill.projectId ? ` (projectId=${skill.projectId as string})` : ''}`,
        `Lifecycle state: ${(skill.lifecycleState as string) ?? (skill.state as string) ?? 'unknown'}`,
        `Version: ${skill.version ?? 'N/A'}`,
        `Skill ID: ${skill.id as string}`,
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: formatTransitionError(error, 'skill', (args as { action?: string }).action ?? 'unknown') }],
        isError: true,
      };
    }
  }

  if (name === 'haops_transition_role_template') {
    try {
      const { name: templateName, action } = args as {
        name: string;
        action: 'propose' | 'publish' | 'deprecate';
      };

      const template = await apiClient.transitionRoleTemplate({
        name: templateName,
        action,
      });

      const lines = [
        `Role template transitioned: ${template.name as string} → action='${action}'`,
        `Lifecycle state: ${(template.lifecycleState as string) ?? (template.state as string) ?? 'unknown'}`,
        `Version: ${template.version ?? 'N/A'}`,
        template.isSystem ? 'System: true' : 'System: false',
        `Template ID: ${template.id as string}`,
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: formatTransitionError(error, 'role template', (args as { action?: string }).action ?? 'unknown') }],
        isError: true,
      };
    }
  }

  if (name === 'haops_transition_skill_pack') {
    try {
      const { name: packName, action } = args as {
        name: string;
        action: 'propose' | 'publish' | 'deprecate';
      };

      const pack = await apiClient.transitionSkillPack({
        name: packName,
        action,
      });

      const idCount = Array.isArray(pack.skillIds)
        ? (pack.skillIds as unknown[]).length
        : 0;
      const lines = [
        `Skill pack transitioned: ${pack.name as string} → action='${action}'`,
        `Lifecycle state: ${(pack.lifecycleState as string) ?? (pack.state as string) ?? 'unknown'}`,
        `Category: ${pack.category as string}`,
        `Skill count: ${idCount}`,
        pack.isSystem ? 'System: true' : 'System: false',
        `Pack ID: ${pack.id as string}`,
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: formatTransitionError(error, 'skill pack', (args as { action?: string }).action ?? 'unknown') }],
        isError: true,
      };
    }
  }

  // ===== Testing MCP Tool Implementations =====

  if (name === 'haops_report_test_run') {
    try {
      const { projectSlug, runner, environment, commitSha, branch, summary, results, coverage } = args as {
        projectSlug: string;
        runner: string;
        environment?: string;
        commitSha?: string;
        branch?: string;
        summary: Record<string, unknown>;
        results: Array<Record<string, unknown>>;
        coverage?: Record<string, unknown>;
      };

      const payload: Record<string, unknown> = { runner, summary, results };
      if (environment !== undefined) payload.environment = environment;
      if (commitSha !== undefined) payload.commitSha = commitSha;
      if (branch !== undefined) payload.branch = branch;
      if (coverage !== undefined) payload.coverage = coverage;

      const result = await apiClient.reportTestRun(projectSlug, payload);
      const { verbose } = args as { verbose?: boolean };
      return { content: [{ type: 'text', text: formatWriteResult('reported', result as unknown as Record<string, unknown>, !!verbose) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error reporting test run: ${message}` }], isError: true };
    }
  }

  if (name === 'haops_get_test_health') {
    try {
      const { projectSlug, entityType, entityId } = args as {
        projectSlug: string;
        entityType?: string;
        entityId?: string;
      };

      const result = await apiClient.getTestHealth(projectSlug, entityType, entityId);
      return {
        content: [{ type: 'text', text: `Test health for project "${projectSlug}":\n${JSON.stringify(result, null, 2)}` }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error getting test health: ${message}` }], isError: true };
    }
  }

  if (name === 'haops_list_tests') {
    try {
      const { projectSlug, type, runner, suiteId, entityType, entityId, limit } = args as {
        projectSlug: string;
        type?: string;
        runner?: string;
        suiteId?: string;
        entityType?: string;
        entityId?: string;
        limit?: number;
      };

      const filters: Record<string, unknown> = {};
      if (type) filters.type = type;
      if (runner) filters.runner = runner;
      if (suiteId) filters.suiteId = suiteId;
      if (entityType) filters.testableType = entityType;
      if (entityId) filters.testableId = entityId;
      if (limit !== undefined) filters.limit = limit;

      const tests = await apiClient.listTests(projectSlug, filters);
      return {
        content: [{ type: 'text', text: `Tests in project "${projectSlug}" (${(tests as unknown[]).length} results):\n${JSON.stringify(tests, null, 2)}` }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error listing tests: ${message}` }], isError: true };
    }
  }

  if (name === 'haops_list_test_runs') {
    try {
      const { projectSlug, runner, environment, limit } = args as {
        projectSlug: string;
        runner?: string;
        environment?: string;
        limit?: number;
      };

      const filters: Record<string, unknown> = {};
      if (runner) filters.runner = runner;
      if (environment) filters.environment = environment;
      if (limit !== undefined) filters.limit = limit;

      const runs = await apiClient.listTestRuns(projectSlug, filters);
      return {
        content: [{ type: 'text', text: `Test runs in project "${projectSlug}" (${(runs as unknown[]).length} results):\n${JSON.stringify(runs, null, 2)}` }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error listing test runs: ${message}` }], isError: true };
    }
  }

  if (name === 'haops_link_tests_to_entity') {
    try {
      const { projectSlug, entityType, entityId, testIds, filePathPattern } = args as {
        projectSlug: string;
        entityType: string;
        entityId: string;
        testIds?: string[];
        filePathPattern?: string;
      };

      const result = await apiClient.linkTestsToEntity(projectSlug, {
        entityType,
        entityId,
        testIds,
        filePathPattern,
      });
      const { verbose } = args as { verbose?: boolean };
      return { content: [{ type: 'text', text: formatWriteResult('linked', result as unknown as Record<string, unknown>, !!verbose) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error linking tests: ${message}` }], isError: true };
    }
  }

  if (name === 'haops_list_test_suites') {
    try {
      const { projectSlug } = args as { projectSlug: string };
      const suites = await apiClient.listTestSuites(projectSlug);
      return {
        content: [{ type: 'text', text: `Test suites in project "${projectSlug}" (${(suites as unknown[]).length} results):\n${JSON.stringify(suites, null, 2)}` }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error listing test suites: ${message}` }], isError: true };
    }
  }

  if (name === 'haops_export_test_suite') {
    try {
      const { projectSlug, suiteId } = args as { projectSlug: string; suiteId: string };
      const bundle = await apiClient.exportTestSuite(projectSlug, suiteId);
      return {
        content: [{ type: 'text', text: `Test suite exported:\n${JSON.stringify(bundle, null, 2)}` }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error exporting test suite: ${message}` }], isError: true };
    }
  }

  if (name === 'haops_import_test_suite') {
    try {
      const { projectSlug, bundle } = args as {
        projectSlug: string;
        bundle: Record<string, unknown>;
      };
      const result = await apiClient.importTestSuite(projectSlug, bundle);
      const { verbose } = args as { verbose?: boolean };
      return { content: [{ type: 'text', text: formatWriteResult('imported', result as unknown as Record<string, unknown>, !!verbose) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error importing test suite: ${message}` }], isError: true };
    }
  }

  // ===== Git MCP Tool Implementations =====

  if (name === 'haops_git_list_files') {
    try {
      const { projectSlug, path, ref, repositoryName } = args as {
        projectSlug: string;
        path?: string;
        ref?: string;
        repositoryName?: string;
      };

      const result = await apiClient.gitListFiles(projectSlug, path, ref, repositoryName) as {
        entries?: Array<{ name: string; type: string }>;
        ref?: string;
        path?: string;
      };
      const entries = result.entries || [];
      const displayRef = result.ref || ref || 'main';
      const displayPath = result.path || path || '/';

      if (entries.length === 0) {
        return {
          content: [{ type: 'text', text: `No files found in /${displayPath} (ref: ${displayRef})` }],
        };
      }

      const lines = entries.map((e: { name: string; type: string }) =>
        `${e.type === 'dir' ? '📁' : '📄'} ${e.name}${e.type === 'dir' ? '/' : ''}`
      );
      return {
        content: [{ type: 'text', text: `Files in /${displayPath} (ref: ${displayRef}):\n${lines.join('\n')}` }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error listing files: ${message}` }], isError: true };
    }
  }

  if (name === 'haops_git_read_file') {
    try {
      const { projectSlug, filePath, ref, repositoryName } = args as {
        projectSlug: string;
        filePath: string;
        ref?: string;
        repositoryName?: string;
      };

      const result = await apiClient.gitReadFile(projectSlug, filePath, ref, repositoryName) as {
        content?: string;
        binary?: boolean;
        size?: number;
        truncated?: boolean;
      };

      if (result.binary) {
        return {
          content: [{ type: 'text', text: `Binary file (${result.size || 0} bytes): ${filePath}` }],
        };
      }

      let text = result.content || '';
      if (result.truncated) {
        text += '\n\n[Truncated — file exceeds 1MB]';
      }

      return {
        content: [{ type: 'text', text }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error reading file: ${message}` }], isError: true };
    }
  }

  if (name === 'haops_git_commit_log') {
    try {
      const { projectSlug, limit, ref, path, repositoryName } = args as {
        projectSlug: string;
        limit?: number;
        ref?: string;
        path?: string;
        repositoryName?: string;
      };

      const result = await apiClient.gitCommitLog(projectSlug, limit, ref, path, repositoryName) as {
        commits?: Array<{ sha: string; message: string; author: string; date: string }>;
        ref?: string;
      };
      const commits = result.commits || [];
      const displayRef = result.ref || ref || 'main';

      if (commits.length === 0) {
        return {
          content: [{ type: 'text', text: `No commits found (ref: ${displayRef})` }],
        };
      }

      const lines = commits.map((c: { sha: string; message: string; author: string; date: string }) => {
        const shortSha = c.sha.substring(0, 7);
        const relDate = formatRelativeDate(c.date);
        return `${shortSha} — ${c.message} (${c.author}, ${relDate})`;
      });

      return {
        content: [{ type: 'text', text: `Recent commits (ref: ${displayRef}):\n\n${lines.join('\n')}` }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error getting commit log: ${message}` }], isError: true };
    }
  }

  if (name === 'haops_git_get_remote_url') {
    try {
      const { projectSlug, repositoryName } = args as { projectSlug: string; repositoryName?: string };

      const result = await apiClient.gitGetRemoteUrl(projectSlug, repositoryName) as {
        sshUrl?: string;
        defaultBranch?: string;
        setupInstructions?: string[];
        status?: string;
      };

      const lines = [
        `HAOps Git remote for project "${projectSlug}":`,
        '',
        `SSH URL: ${result.sshUrl || 'Not configured'}`,
        `Default branch: ${result.defaultBranch || 'main'}`,
        `Status: ${result.status || 'unknown'}`,
      ];

      if (result.setupInstructions?.length) {
        lines.push('', 'Setup:');
        result.setupInstructions.forEach((cmd: string) => lines.push(cmd));
      }

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error getting remote URL: ${message}` }], isError: true };
    }
  }

  if (name === 'haops_manage_ssh_keys') {
    try {
      const { action, name: keyName, publicKey, keyId } = args as {
        action: string;
        name?: string;
        publicKey?: string;
        keyId?: string;
      };

      if (action === 'list') {
        const keys = await apiClient.listSshKeys();
        if (!keys || (Array.isArray(keys) && keys.length === 0)) {
          return { content: [{ type: 'text', text: 'No SSH keys registered.' }] };
        }
        const lines = (keys as Array<Record<string, unknown>>).map((k) =>
          `- ${k.name} (${k.keyType}) — ${k.fingerprint} — Added: ${formatRelativeDate(k.createdAt as string)}`
        );
        return { content: [{ type: 'text', text: `SSH Keys:\n${lines.join('\n')}` }] };
      }

      if (action === 'add') {
        if (!keyName || !publicKey) {
          return { content: [{ type: 'text', text: 'Error: name and publicKey are required for add action' }], isError: true };
        }
        const result = await apiClient.addSshKey(keyName, publicKey);
        return {
          content: [{ type: 'text', text: `SSH key added:\n- Name: ${result.name}\n- Type: ${result.keyType}\n- Fingerprint: ${result.fingerprint}\n\nNote: Run SSH key sync to deploy the key.` }],
        };
      }

      if (action === 'revoke') {
        if (!keyId) {
          return { content: [{ type: 'text', text: 'Error: keyId is required for revoke action' }], isError: true };
        }
        await apiClient.revokeSshKey(keyId);
        return {
          content: [{ type: 'text', text: `SSH key ${keyId} revoked. Run SSH key sync to update authorized_keys.` }],
        };
      }

      return { content: [{ type: 'text', text: `Unknown action: ${action}. Use list, add, or revoke.` }], isError: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error managing SSH keys: ${message}` }], isError: true };
    }
  }

  if (name === 'haops_list_updates') {
    try {
      const { projectSlug, updateType, status } = args as {
        projectSlug: string;
        updateType?: string;
        status?: string;
      };

      const result = await apiClient.listUpdates(projectSlug, { updateType, status });
      const updates = result.data || [];

      if (updates.length === 0) {
        return { content: [{ type: 'text', text: 'No updates found.' }] };
      }

      const typeLabels: Record<string, string> = {
        mcp_server: 'MCP Server',
        protocol: 'Protocol',
        test_suite: 'Test Suite',
        onboarding_templates: 'Onboarding',
      };

      const lines = updates.map((u: Record<string, unknown>) => {
        const type = typeLabels[u.updateType as string] || u.updateType;
        const version = u.version ? ` v${u.version}` : '';
        const date = u.createdAt ? ` (${formatRelativeDate(u.createdAt as string)})` : '';
        return `- [${u.status}] ${type}${version}: ${u.title}${date}\n  ID: ${u.id}`;
      });

      return {
        content: [{ type: 'text', text: `${updates.length} update(s) found:\n\n${lines.join('\n')}` }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error listing updates: ${message}` }], isError: true };
    }
  }

  if (name === 'haops_download_update') {
    try {
      const { projectSlug, updateId } = args as {
        projectSlug: string;
        updateId: string;
      };

      const result = await apiClient.downloadUpdate(projectSlug, updateId);

      return {
        content: [{ type: 'text', text: `Update content:\n${JSON.stringify(result, null, 2)}` }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error downloading update: ${message}` }], isError: true };
    }
  }

  // ===== Merge Requests =====

  if (name === 'haops_create_merge_request') {
    try {
      const { projectSlug, repositoryName, sourceBranch, targetBranch, title, description } = args as {
        projectSlug: string;
        repositoryName?: string;
        sourceBranch: string;
        targetBranch: string;
        title: string;
        description?: string;
      };

      const result = await apiClient.createMergeRequest(projectSlug, {
        repositoryName, sourceBranch, targetBranch, title, description,
      }) as Record<string, unknown>;

      const mr = result as Record<string, unknown>;
      const conflicts = mr.hasConflicts ? ` ⚠️ CONFLICTS in ${(mr.conflictFiles as string[] || []).length} file(s)` : '';
      const lines = [
        `✅ Merge request created:`,
        `  ID: ${mr.id}`,
        `  Title: ${mr.title}`,
        `  ${mr.sourceBranch} → ${mr.targetBranch}`,
        `  Status: ${mr.status}${conflicts}`,
      ];

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error creating merge request: ${message}` }], isError: true };
    }
  }

  if (name === 'haops_get_merge_request') {
    try {
      const { projectSlug, mergeRequestId } = args as {
        projectSlug: string;
        mergeRequestId: string;
      };
      assertUuid(mergeRequestId, 'mergeRequestId');

      const mr = await apiClient.getMergeRequest(projectSlug, mergeRequestId) as Record<string, unknown>;

      const statusIcon: Record<string, string> = {
        draft: '📝', open: '🔵', approved: '✅', merged: '🟣', closed: '⚫',
      };

      const reviews = (mr.reviews || []) as Array<Record<string, unknown>>;
      const diffStats = mr.diffStats as Record<string, unknown> | undefined;
      const author = mr.author as Record<string, unknown> | undefined;
      const conflicts = mr.hasConflicts ? `\n⚠️ Conflicts: ${((mr.conflictFiles as string[]) || []).join(', ')}` : '';

      const lines = [
        `${statusIcon[mr.status as string] || '❓'} ${mr.title}`,
        `  ${mr.sourceBranch} → ${mr.targetBranch}  |  Status: ${mr.status}`,
        `  Author: ${author?.username || 'unknown'}  |  Created: ${mr.createdAt ? formatRelativeDate(mr.createdAt as string) : 'unknown'}`,
      ];

      if (diffStats) {
        const files = (diffStats as Record<string, unknown>).files as Array<Record<string, unknown>> | undefined;
        const ahead = (diffStats as Record<string, unknown>).ahead;
        lines.push(`  Diff: ${ahead || 0} commit(s) ahead, ${files?.length || 0} file(s) changed`);
      }

      lines.push(conflicts);

      if (reviews.length > 0) {
        lines.push('\nReviews:');
        for (const r of reviews) {
          const reviewer = r.reviewer as Record<string, unknown> | undefined;
          const verdictIcon: Record<string, string> = { approved: '✅', changes_requested: '❌', commented: '💬' };
          lines.push(`  ${verdictIcon[r.verdict as string] || '?'} ${reviewer?.username || 'unknown'}: ${r.verdict}${r.body ? ` — ${r.body}` : ''}`);
        }
      }

      if (mr.mergeCommitSha) {
        lines.push(`\nMerge commit: ${(mr.mergeCommitSha as string).substring(0, 7)}`);
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error getting merge request: ${message}` }], isError: true };
    }
  }

  if (name === 'haops_list_merge_requests') {
    try {
      const { projectSlug, repositoryName, status, targetBranch, limit } = args as {
        projectSlug: string;
        repositoryName?: string;
        status?: string;
        targetBranch?: string;
        limit?: number;
      };

      const result = await apiClient.listMergeRequests(projectSlug, { repositoryName, status, targetBranch, limit });
      const mrs = result.data || [];

      if (mrs.length === 0) {
        return { content: [{ type: 'text', text: 'No merge requests found.' }] };
      }

      const statusIcon: Record<string, string> = {
        draft: '📝', open: '🔵', approved: '✅', merged: '🟣', closed: '⚫',
      };

      const lines = mrs.map((mr: Record<string, unknown>) => {
        const icon = statusIcon[mr.status as string] || '❓';
        const author = mr.author as Record<string, unknown> | undefined;
        const date = mr.createdAt ? formatRelativeDate(mr.createdAt as string) : '';
        return `${icon} [${mr.status}] ${mr.title}\n  ${mr.sourceBranch} → ${mr.targetBranch}  |  ${author?.username || 'unknown'}  |  ${date}\n  ID: ${mr.id}`;
      });

      return {
        content: [{ type: 'text', text: `${mrs.length} merge request(s):\n\n${lines.join('\n\n')}` }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error listing merge requests: ${message}` }], isError: true };
    }
  }

  if (name === 'haops_review_merge_request') {
    try {
      const { projectSlug, mergeRequestId, verdict, body } = args as {
        projectSlug: string;
        mergeRequestId: string;
        verdict: string;
        body?: string;
      };
      assertUuid(mergeRequestId, 'mergeRequestId');

      const result = await apiClient.reviewMergeRequest(projectSlug, mergeRequestId, { verdict, body }) as Record<string, unknown>;

      const verdictIcon: Record<string, string> = { approved: '✅', changes_requested: '❌', commented: '💬' };
      const lines = [
        `${verdictIcon[verdict] || '?'} Review submitted: ${verdict}`,
        body ? `  Comment: ${body}` : '',
        result.mrStatus ? `  MR status: ${result.mrStatus}` : '',
      ].filter(Boolean);

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error submitting review: ${message}` }], isError: true };
    }
  }

  if (name === 'haops_merge_merge_request') {
    try {
      const { projectSlug, mergeRequestId, deleteSourceBranch, mergeCommitMessage } = args as {
        projectSlug: string;
        mergeRequestId: string;
        deleteSourceBranch?: boolean;
        mergeCommitMessage?: string;
      };
      assertUuid(mergeRequestId, 'mergeRequestId');

      const result = await apiClient.mergeMergeRequest(projectSlug, mergeRequestId, {
        deleteSourceBranch, mergeCommitMessage,
      }) as Record<string, unknown>;

      const mr = result as Record<string, unknown>;
      const lines = [
        `🟣 Merge request merged successfully!`,
        mr.mergeCommitSha ? `  Merge commit: ${(mr.mergeCommitSha as string).substring(0, 7)}` : '  Fast-forward merge (no merge commit)',
        deleteSourceBranch ? `  Source branch deleted` : '',
      ].filter(Boolean);

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error merging: ${message}` }], isError: true };
    }
  }

  if (name === 'haops_get_branch_diff') {
    try {
      const { projectSlug, repositoryName, sourceBranch, targetBranch } = args as {
        projectSlug: string;
        repositoryName?: string;
        sourceBranch: string;
        targetBranch: string;
      };

      const result = await apiClient.getBranchDiff(projectSlug, { repositoryName, sourceBranch, targetBranch }) as Record<string, unknown>;

      const commits = (result.commits || []) as Array<Record<string, unknown>>;
      const files = (result.files || []) as Array<Record<string, unknown>>;
      const hasConflicts = result.hasConflicts as boolean;
      const conflictFiles = (result.conflictFiles || []) as string[];

      const lines = [
        `Branch diff: ${sourceBranch} → ${targetBranch}`,
        `  Ahead: ${result.aheadBy || 0} commit(s)  |  Behind: ${result.behindBy || 0} commit(s)`,
        `  Changed files: ${files.length}`,
        hasConflicts ? `  ⚠️ Conflicts in: ${conflictFiles.join(', ')}` : '  No conflicts',
      ];

      if (commits.length > 0) {
        lines.push('\nCommits:');
        for (const c of commits.slice(0, 20)) {
          const shortSha = (c.sha as string || '').substring(0, 7);
          const date = c.date ? formatRelativeDate(c.date as string) : '';
          lines.push(`  ${shortSha} — ${c.message} (${c.author}, ${date})`);
        }
        if (commits.length > 20) {
          lines.push(`  ... and ${commits.length - 20} more`);
        }
      }

      if (files.length > 0) {
        lines.push('\nFiles:');
        for (const f of files.slice(0, 30)) {
          const additions = f.additions || 0;
          const deletions = f.deletions || 0;
          lines.push(`  ${f.status || 'M'} ${f.path} (+${additions} -${deletions})`);
        }
        if (files.length > 30) {
          lines.push(`  ... and ${files.length - 30} more`);
        }
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error getting branch diff: ${message}` }], isError: true };
    }
  }

  if (name === 'haops_upload_doc_image') {
    try {
      const { projectSlug, artifactSlug, sectionSlug, imageBase64, filename, mimeType } = args as {
        projectSlug: string;
        artifactSlug: string;
        sectionSlug: string;
        imageBase64: string;
        filename: string;
        mimeType: string;
      };

      const url = `/api/projects/${projectSlug}/docs/${artifactSlug}/sections/${sectionSlug}/attachments`;
      const result = await apiClient.requestFormData(url, filename, imageBase64, mimeType) as Record<string, unknown>;

      const lines = [
        `Image uploaded successfully!`,
        `  ID: ${result.id}`,
        `  Filename: ${result.originalFilename}`,
        `  Size: ${result.fileSize} bytes`,
        `  URL: ${result.url}`,
      ];

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error uploading doc image: ${message}` }], isError: true };
    }
  }

  if (name === 'haops_upload_help_image') {
    try {
      const { articleSlug, imageBase64, filename, mimeType } = args as {
        articleSlug: string;
        imageBase64: string;
        filename: string;
        mimeType: string;
      };

      const url = `/api/help/articles/${articleSlug}/attachments`;
      const result = await apiClient.requestFormData(url, filename, imageBase64, mimeType) as Record<string, unknown>;

      const lines = [
        `Image uploaded successfully!`,
        `  ID: ${result.id}`,
        `  Filename: ${result.originalFilename}`,
        `  Size: ${result.fileSize} bytes`,
        `  URL: ${result.url}`,
      ];

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error uploading help image: ${message}` }], isError: true };
    }
  }

  // ===== Work Hierarchy — List & Get =====

  if (name === 'haops_list_modules') {
    try {
      const { projectSlug, status, priority, ownerId, page, limit } = args as {
        projectSlug: string;
        status?: string;
        priority?: string;
        ownerId?: string;
        page?: number;
        limit?: number;
      };

      const effectiveLimit = Math.min(limit || 25, 100);
      const offset = page && page > 1 ? (page - 1) * effectiveLimit : undefined;
      const result = await apiClient.listModulesWithMeta(projectSlug, {
        status, priority, ownerId, limit: effectiveLimit, offset,
      });

      const modules = result.data || [];
      if (modules.length === 0) {
        return { content: [{ type: 'text', text: 'No modules found matching filters.' }] };
      }

      const lines = modules.map((m: any) => {
        const owner = m.owner ? m.owner.name || 'Unknown' : 'Unassigned';
        return `- [${m.status}] ${m.title} (${m.priority}) — Owner: ${owner}\n  ID: ${m.id}`;
      });

      const header = `${result.total} module(s) found (page ${page || 1}, ${effectiveLimit}/page):`;
      return { content: [{ type: 'text', text: `${header}\n\n${lines.join('\n')}` }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error listing modules: ${message}` }], isError: true };
    }
  }

  if (name === 'haops_get_module') {
    try {
      const { moduleId } = args as { moduleId: string };
      const mod = await apiClient.getModule(moduleId);
      return { content: [{ type: 'text', text: JSON.stringify(mod, null, 2) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error getting module: ${message}` }], isError: true };
    }
  }

  if (name === 'haops_list_features') {
    try {
      const { projectSlug, moduleId, status, priority, page, limit } = args as {
        projectSlug: string;
        moduleId?: string;
        status?: string;
        priority?: string;
        page?: number;
        limit?: number;
      };

      const effectiveLimit = Math.min(limit || 25, 100);

      if (moduleId) {
        // Direct query — single module's features via URL query params
        const qs = new URLSearchParams();
        qs.set('moduleId', moduleId);
        qs.set('limit', String(effectiveLimit));
        if (status) qs.set('status', status);
        if (priority) qs.set('priority', priority);
        if (page && page > 1) qs.set('page', String(page));
        const result = await apiClient.request('GET', `/api/features?${qs.toString()}`) as Record<string, unknown>;
        const features = (result.data || []) as Array<Record<string, unknown>>;

        if (features.length === 0) {
          return { content: [{ type: 'text', text: 'No features found matching filters.' }] };
        }

        const lines = features.map((f: Record<string, unknown>) => {
          const owner = f.owner ? (f.owner as Record<string, unknown>).name || 'Unknown' : 'Unassigned';
          return `- [${f.status}] ${f.title} (${f.priority}) — Owner: ${owner}\n  ID: ${f.id}`;
        });

        return { content: [{ type: 'text', text: `${result.total || features.length} feature(s):\n\n${lines.join('\n')}` }] };
      }

      // No moduleId — list all features for the project
      const features = await apiClient.listFeatures(projectSlug, { status, priority, limit: effectiveLimit });

      if (features.length === 0) {
        return { content: [{ type: 'text', text: 'No features found matching filters.' }] };
      }

      const lines = features.map((f: any) => {
        const owner = f.owner ? f.owner.name || 'Unknown' : 'Unassigned';
        return `- [${f.status}] ${f.title} (${f.priority}) — Owner: ${owner}\n  ID: ${f.id}`;
      });

      return { content: [{ type: 'text', text: `${features.length} feature(s):\n\n${lines.join('\n')}` }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error listing features: ${message}` }], isError: true };
    }
  }

  if (name === 'haops_get_feature') {
    try {
      const { featureId } = args as { featureId: string };
      const feature = await apiClient.getFeature(featureId);
      return { content: [{ type: 'text', text: JSON.stringify(feature, null, 2) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error getting feature: ${message}` }], isError: true };
    }
  }

  if (name === 'haops_list_issues') {
    try {
      const { projectSlug, featureId, status, priority, type, assignedTo, page, limit } = args as {
        projectSlug: string;
        featureId?: string;
        status?: string;
        priority?: string;
        type?: string;
        assignedTo?: string;
        page?: number;
        limit?: number;
      };

      const effectiveLimit = Math.min(limit || 25, 100);

      if (featureId) {
        // Direct query — single feature's issues
        const params = new URLSearchParams();
        params.set('featureId', featureId);
        params.set('limit', String(effectiveLimit));
        if (status) params.set('status', status);
        if (priority) params.set('priority', priority);
        if (type) params.set('type', type);
        if (assignedTo) params.set('assignedTo', assignedTo);
        if (page && page > 1) params.set('page', String(page));

        const result = await apiClient.request('GET', `/api/issues?${params.toString()}`) as Record<string, unknown>;
        const issues = (result.data || []) as Array<Record<string, unknown>>;

        if (issues.length === 0) {
          return { content: [{ type: 'text', text: 'No issues found matching filters.' }] };
        }

        const lines = issues.map((i: Record<string, unknown>) => {
          const assignee = i.assignee ? (i.assignee as Record<string, unknown>).name || 'Unknown' : 'Unassigned';
          return `- [${i.status}] ${i.title} (${i.priority}, ${i.type}) — Assignee: ${assignee}\n  ID: ${i.id}`;
        });

        return { content: [{ type: 'text', text: `${result.total || issues.length} issue(s):\n\n${lines.join('\n')}` }] };
      }

      // No featureId — list all issues for the project
      const issues = await apiClient.listIssues(projectSlug, { status, priority, type, assignedTo, limit: effectiveLimit });

      if (issues.length === 0) {
        return { content: [{ type: 'text', text: 'No issues found matching filters.' }] };
      }

      const lines = issues.map((i: any) => {
        const assignee = i.assignee ? i.assignee.name || 'Unknown' : 'Unassigned';
        return `- [${i.status}] ${i.title} (${i.priority}, ${i.type}) — Assignee: ${assignee}\n  ID: ${i.id}`;
      });

      return { content: [{ type: 'text', text: `${issues.length} issue(s):\n\n${lines.join('\n')}` }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error listing issues: ${message}` }], isError: true };
    }
  }

  if (name === 'haops_get_issue') {
    try {
      const { issueId } = args as { issueId: string };
      const issue = await apiClient.getIssue(issueId);
      return { content: [{ type: 'text', text: JSON.stringify(issue, null, 2) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error getting issue: ${message}` }], isError: true };
    }
  }

  // ===== Teamwork Views =====

  if (name === 'haops_get_structured_view') {
    try {
      const { projectSlug, type, assignee, status } = args as {
        projectSlug: string;
        type?: string;
        assignee?: string;
        status?: string;
      };

      const params = new URLSearchParams();
      if (type) params.set('type', type);
      if (assignee) params.set('assignee', assignee);
      if (status) params.set('status', status);
      const qs = params.toString();

      const result = await apiClient.request('GET', `/api/projects/${projectSlug}/teamwork/structured${qs ? `?${qs}` : ''}`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error getting structured view: ${message}` }], isError: true };
    }
  }

  // ===== Notifications =====

  if (name === 'haops_list_notifications') {
    try {
      const { page, limit } = args as { page?: number; limit?: number };
      const params = new URLSearchParams();
      if (page !== undefined) params.set('page', String(page));
      if (limit !== undefined) params.set('limit', String(limit));
      const qs = params.toString();

      const result = await apiClient.request('GET', `/api/notifications${qs ? `?${qs}` : ''}`) as Record<string, unknown>;
      const notifications = (result.notifications || result.data || []) as Array<Record<string, unknown>>;

      if (notifications.length === 0) {
        return { content: [{ type: 'text', text: `No notifications. Unread count: ${result.unreadCount || 0}` }] };
      }

      const lines = notifications.map((n: Record<string, unknown>) => {
        const read = n.readAt ? '✓' : '•';
        const time = n.createdAt ? formatRelativeDate(n.createdAt as string) : '';
        return `${read} [${n.type}] ${n.title || n.message} (${time})\n  ID: ${n.id}`;
      });

      const header = `Notifications (unread: ${result.unreadCount || 0}):`;
      return { content: [{ type: 'text', text: `${header}\n\n${lines.join('\n')}` }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error listing notifications: ${message}` }], isError: true };
    }
  }

  if (name === 'haops_mark_notification_read') {
    try {
      const { notificationId } = args as { notificationId: string };
      await apiClient.request('PUT', `/api/notifications/${notificationId}/read`);
      return { content: [{ type: 'text', text: `Notification ${notificationId} marked as read.` }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error marking notification read: ${message}` }], isError: true };
    }
  }

  // ===== Search & Code Review =====

  if (name === 'haops_search_discussion') {
    try {
      const { projectSlug, discussionId, query } = args as {
        projectSlug: string;
        discussionId: string;
        query: string;
      };

      const result = await apiClient.request('GET', `/api/projects/${projectSlug}/discussions/${discussionId}/search?q=${encodeURIComponent(query)}`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error searching discussion: ${message}` }], isError: true };
    }
  }

  if (name === 'haops_git_commit_diff') {
    try {
      const { projectSlug, sha, repositoryName } = args as {
        projectSlug: string;
        sha: string;
        repositoryName?: string;
      };

      const params = repositoryName ? `?repositoryName=${encodeURIComponent(repositoryName)}` : '';
      const result = await apiClient.requestText('GET', `/api/projects/${projectSlug}/git/diff/${sha}${params}`);
      return { content: [{ type: 'text', text: result }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error getting commit diff: ${message}` }], isError: true };
    }
  }

  // ===== Channel Management =====

  if (name === 'haops_create_channel') {
    try {
      const { projectSlug, name: channelName, description, type } = args as {
        projectSlug: string;
        name: string;
        description?: string;
        type?: string;
      };

      const body: Record<string, unknown> = { name: channelName };
      if (description) body.description = description;
      if (type) body.type = type;

      const result = await apiClient.request('POST', `/api/projects/${projectSlug}/channels`, body);
      const { verbose } = args as { verbose?: boolean };
      return { content: [{ type: 'text', text: formatWriteResult('created', result as unknown as Record<string, unknown>, !!verbose) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error creating channel: ${message}` }], isError: true };
    }
  }

  if (name === 'haops_update_channel') {
    try {
      const { projectSlug, channelId, name: channelName, description } = args as {
        projectSlug: string;
        channelId: string;
        name?: string;
        description?: string;
      };

      const body: Record<string, unknown> = {};
      if (channelName) body.name = channelName;
      if (description !== undefined) body.description = description;

      const result = await apiClient.request('PUT', `/api/projects/${projectSlug}/channels/${channelId}`, body);
      const { verbose } = args as { verbose?: boolean };
      return { content: [{ type: 'text', text: formatWriteResult('updated', result as unknown as Record<string, unknown>, !!verbose) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error updating channel: ${message}` }], isError: true };
    }
  }

  if (name === 'haops_delete_channel') {
    try {
      const { projectSlug, channelId } = args as { projectSlug: string; channelId: string };
      await apiClient.request('DELETE', `/api/projects/${projectSlug}/channels/${channelId}`);
      return { content: [{ type: 'text', text: `Channel ${channelId} deleted.` }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error deleting channel: ${message}` }], isError: true };
    }
  }

  // ===== Message Actions =====

  if (name === 'haops_react_to_message') {
    try {
      const { projectSlug, discussionId, messageId, emoji } = args as {
        projectSlug: string;
        discussionId: string;
        messageId: string;
        emoji: string;
      };

      await apiClient.request('PUT', `/api/projects/${projectSlug}/discussions/${discussionId}/messages/${messageId}/reactions`, { emoji });
      return { content: [{ type: 'text', text: `Reaction ${emoji} added/toggled on message ${messageId}.` }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error reacting to message: ${message}` }], isError: true };
    }
  }

  if (name === 'haops_pin_message') {
    try {
      const { projectSlug, discussionId, messageId, pinned } = args as {
        projectSlug: string;
        discussionId: string;
        messageId: string;
        pinned: boolean;
      };

      await apiClient.request('PUT', `/api/projects/${projectSlug}/discussions/${discussionId}/messages/${messageId}/pin`, { pinned });
      return { content: [{ type: 'text', text: `Message ${messageId} ${pinned ? 'pinned' : 'unpinned'}.` }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error pinning message: ${message}` }], isError: true };
    }
  }

  // ===== Merge Request Lifecycle =====

  if (name === 'haops_close_merge_request') {
    try {
      const { projectSlug, mergeRequestId } = args as { projectSlug: string; mergeRequestId: string };
      assertUuid(mergeRequestId, 'mergeRequestId');
      const result = await apiClient.request('POST', `/api/projects/${projectSlug}/git/merge-requests/${mergeRequestId}/close`);
      const { verbose } = args as { verbose?: boolean };
      return { content: [{ type: 'text', text: formatWriteResult('closed', result as unknown as Record<string, unknown>, !!verbose) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error closing merge request: ${message}` }], isError: true };
    }
  }

  if (name === 'haops_reopen_merge_request') {
    try {
      const { projectSlug, mergeRequestId } = args as { projectSlug: string; mergeRequestId: string };
      assertUuid(mergeRequestId, 'mergeRequestId');
      const result = await apiClient.request('POST', `/api/projects/${projectSlug}/git/merge-requests/${mergeRequestId}/reopen`);
      const { verbose } = args as { verbose?: boolean };
      return { content: [{ type: 'text', text: formatWriteResult('reopened', result as unknown as Record<string, unknown>, !!verbose) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error reopening merge request: ${message}` }], isError: true };
    }
  }

  // ===== Doc Builder Management =====

  if (name === 'haops_list_doc_sections') {
    try {
      const { projectSlug, artifactSlug } = args as { projectSlug: string; artifactSlug: string };
      const result = await apiClient.request('GET', `/api/projects/${projectSlug}/docs/${artifactSlug}/sections`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error listing doc sections: ${message}` }], isError: true };
    }
  }

  if (name === 'haops_delete_doc_section') {
    try {
      const { projectSlug, artifactSlug, sectionSlug } = args as {
        projectSlug: string;
        artifactSlug: string;
        sectionSlug: string;
      };
      await apiClient.request('DELETE', `/api/projects/${projectSlug}/docs/${artifactSlug}/sections/${sectionSlug}`);
      return { content: [{ type: 'text', text: `Doc section "${sectionSlug}" deleted from artifact "${artifactSlug}".` }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error deleting doc section: ${message}` }], isError: true };
    }
  }

  if (name === 'haops_delete_doc_artifact') {
    try {
      const { projectSlug, artifactSlug } = args as { projectSlug: string; artifactSlug: string };
      await apiClient.request('DELETE', `/api/projects/${projectSlug}/docs/${artifactSlug}`);
      return { content: [{ type: 'text', text: `Doc artifact "${artifactSlug}" deleted.` }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error deleting doc artifact: ${message}` }], isError: true };
    }
  }

  if (name === 'haops_generate_changelog') {
    try {
      const { projectSlug } = args as { projectSlug: string };
      const result = await apiClient.request('POST', `/api/projects/${projectSlug}/docs/changelog/generate`);
      const { verbose } = args as { verbose?: boolean };
      return { content: [{ type: 'text', text: formatWriteResult('generated', result as unknown as Record<string, unknown>, !!verbose) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error generating changelog: ${message}` }], isError: true };
    }
  }

  // ===== Help Center Extras =====

  if (name === 'haops_search_help') {
    try {
      const { query } = args as { query: string };
      const result = await apiClient.request('GET', `/api/help/search?q=${encodeURIComponent(query)}`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error searching help: ${message}` }], isError: true };
    }
  }

  if (name === 'haops_delete_help_section') {
    try {
      const { sectionSlug } = args as { sectionSlug: string };
      await apiClient.request('DELETE', `/api/help/sections/${sectionSlug}`);
      return { content: [{ type: 'text', text: `Help section "${sectionSlug}" deleted.` }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error deleting help section: ${message}` }], isError: true };
    }
  }

  if (name === 'haops_delete_help_article') {
    try {
      const { articleSlug } = args as { articleSlug: string };
      await apiClient.request('DELETE', `/api/help/articles/${articleSlug}`);
      return { content: [{ type: 'text', text: `Help article "${articleSlug}" deleted.` }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error deleting help article: ${message}` }], isError: true };
    }
  }

  // ===== Repository Management =====

  if (name === 'haops_manage_repositories') {
    try {
      const { projectSlug, action, repositoryId, name: repoName, description, defaultBranch } = args as {
        projectSlug: string;
        action: string;
        repositoryId?: string;
        name?: string;
        description?: string;
        defaultBranch?: string;
      };

      if (action === 'list') {
        const result = await apiClient.request('GET', `/api/projects/${projectSlug}/repositories`);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      if (action === 'get') {
        if (!repositoryId) {
          return { content: [{ type: 'text', text: 'Error: repositoryId is required for get action' }], isError: true };
        }
        const result = await apiClient.request('GET', `/api/projects/${projectSlug}/repositories/${repositoryId}`);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      if (action === 'create') {
        if (!repoName) {
          return { content: [{ type: 'text', text: 'Error: name is required for create action' }], isError: true };
        }
        const body: Record<string, unknown> = { name: repoName };
        if (description) body.description = description;
        if (defaultBranch) body.defaultBranch = defaultBranch;
        const result = await apiClient.request('POST', `/api/projects/${projectSlug}/repositories`, body);
        const { verbose } = args as { verbose?: boolean };
        return { content: [{ type: 'text', text: formatWriteResult('created', result as unknown as Record<string, unknown>, !!verbose) }] };
      }

      if (action === 'update') {
        if (!repositoryId) {
          return { content: [{ type: 'text', text: 'Error: repositoryId is required for update action' }], isError: true };
        }
        const body: Record<string, unknown> = {};
        if (repoName) body.name = repoName;
        if (description !== undefined) body.description = description;
        if (defaultBranch) body.defaultBranch = defaultBranch;
        const result = await apiClient.request('PUT', `/api/projects/${projectSlug}/repositories/${repositoryId}`, body);
        const { verbose } = args as { verbose?: boolean };
        return { content: [{ type: 'text', text: formatWriteResult('updated', result as unknown as Record<string, unknown>, !!verbose) }] };
      }

      if (action === 'delete') {
        if (!repositoryId) {
          return { content: [{ type: 'text', text: 'Error: repositoryId is required for delete action' }], isError: true };
        }
        await apiClient.request('DELETE', `/api/projects/${projectSlug}/repositories/${repositoryId}`);
        return { content: [{ type: 'text', text: `Repository ${repositoryId} deleted.` }] };
      }

      return { content: [{ type: 'text', text: `Unknown action: ${action}. Use list, get, create, update, or delete.` }], isError: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error managing repositories: ${message}` }], isError: true };
    }
  }

  // ===== Helpdesk Tools =====

  if (name === 'haops_list_tickets') {
    try {
      const { projectSlug, status, priority, assignedTo, category, search, page, limit } = args as {
        projectSlug: string;
        status?: string;
        priority?: string;
        assignedTo?: string;
        category?: string;
        search?: string;
        page?: number;
        limit?: number;
      };
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (priority) params.set('priority', priority);
      if (assignedTo) params.set('assignedTo', assignedTo);
      if (category) params.set('category', category);
      if (search) params.set('search', search);
      if (page !== undefined) params.set('page', String(page));
      if (limit !== undefined) params.set('limit', String(limit));
      const query = params.toString();
      const url = `/api/projects/${projectSlug}/helpdesk/tickets${query ? `?${query}` : ''}`;
      const result = await apiClient.request('GET', url);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error listing tickets: ${message}` }], isError: true };
    }
  }

  if (name === 'haops_get_ticket') {
    try {
      const { projectSlug, ticketId } = args as { projectSlug: string; ticketId: string };
      const result = await apiClient.request('GET', `/api/projects/${projectSlug}/helpdesk/tickets/${ticketId}`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error getting ticket: ${message}` }], isError: true };
    }
  }

  if (name === 'haops_create_ticket') {
    try {
      const { projectSlug, subject, content, requesterEmail, requesterName, priority, category } = args as {
        projectSlug: string;
        subject: string;
        content: string;
        requesterEmail: string;
        requesterName?: string;
        priority?: string;
        category?: string;
      };
      const body: Record<string, unknown> = { subject, content, requesterEmail };
      if (requesterName !== undefined) body.requesterName = requesterName;
      if (priority !== undefined) body.priority = priority;
      if (category !== undefined) body.category = category;
      const result = await apiClient.request('POST', `/api/projects/${projectSlug}/helpdesk/tickets`, body);
      const { verbose } = args as { verbose?: boolean };
      return { content: [{ type: 'text', text: formatWriteResult('created', result as unknown as Record<string, unknown>, !!verbose) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error creating ticket: ${message}` }], isError: true };
    }
  }

  if (name === 'haops_update_ticket') {
    try {
      const { projectSlug, ticketId, status, priority, category, assignedToId, tags, language } = args as {
        projectSlug: string;
        ticketId: string;
        status?: string;
        priority?: string;
        category?: string;
        assignedToId?: string;
        tags?: string[];
        language?: string;
      };
      const body: Record<string, unknown> = {};
      if (status !== undefined) body.status = status;
      if (priority !== undefined) body.priority = priority;
      if (category !== undefined) body.category = category;
      if (assignedToId !== undefined) body.assignedToId = assignedToId;
      if (tags !== undefined) body.tags = tags;
      if (language !== undefined) body.language = language;
      const result = await apiClient.request('PUT', `/api/projects/${projectSlug}/helpdesk/tickets/${ticketId}`, body);
      const { verbose } = args as { verbose?: boolean };
      return { content: [{ type: 'text', text: formatWriteResult('updated', result as unknown as Record<string, unknown>, !!verbose) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error updating ticket: ${message}` }], isError: true };
    }
  }

  if (name === 'haops_reply_ticket') {
    try {
      const { projectSlug, ticketId, content, direction } = args as {
        projectSlug: string;
        ticketId: string;
        content: string;
        direction: 'outbound' | 'internal';
      };
      const body: Record<string, unknown> = { content, direction };
      const result = await apiClient.request('POST', `/api/projects/${projectSlug}/helpdesk/tickets/${ticketId}/messages`, body);
      const { verbose } = args as { verbose?: boolean };
      return { content: [{ type: 'text', text: verbose ? `Message sent (${direction}):\n${JSON.stringify(result, null, 2)}` : `Sent (${direction}) — ${(result as Record<string, unknown>).id as string ?? 'ok'}` }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error replying to ticket: ${message}` }], isError: true };
    }
  }

  if (name === 'haops_claim_ticket') {
    try {
      const { projectSlug, ticketId, action, force } = args as {
        projectSlug: string;
        ticketId: string;
        action?: 'claim' | 'unclaim';
        force?: boolean;
      };
      const body: Record<string, unknown> = {};
      if (action !== undefined) body.action = action;
      if (force !== undefined) body.force = force;
      const result = await apiClient.request('PUT', `/api/projects/${projectSlug}/helpdesk/tickets/${ticketId}/claim`, body);
      const { verbose } = args as { verbose?: boolean };
      return { content: [{ type: 'text', text: formatWriteResult('claimed', result as unknown as Record<string, unknown>, !!verbose) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error claiming ticket: ${message}` }], isError: true };
    }
  }

  if (name === 'haops_close_ticket') {
    try {
      const { projectSlug, ticketId, status, resolutionNote } = args as {
        projectSlug: string;
        ticketId: string;
        status: 'resolved' | 'closed';
        resolutionNote?: string;
      };
      const body: Record<string, unknown> = { status };
      if (resolutionNote !== undefined) body.resolutionNote = resolutionNote;
      const result = await apiClient.request('PUT', `/api/projects/${projectSlug}/helpdesk/tickets/${ticketId}`, body);
      const { verbose } = args as { verbose?: boolean };
      return { content: [{ type: 'text', text: formatWriteResult(status, result as unknown as Record<string, unknown>, !!verbose) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error closing ticket: ${message}` }], isError: true };
    }
  }

  if (name === 'haops_rag_query') {
    try {
      const { projectSlug, text, topK, entityTypes, mode, format } = args as {
        projectSlug: string;
        text: string;
        topK?: number;
        entityTypes?: string[];
        mode?: 'hybrid' | 'vector' | 'bm25';
        format?: 'compact' | 'ui';
      };
      const body: Record<string, unknown> = { text };
      if (topK !== undefined) body.topK = topK;
      if (entityTypes !== undefined) body.entityTypes = entityTypes;
      if (mode !== undefined) body.mode = mode;
      if (format !== undefined) body.format = format;
      const result = await apiClient.request('POST', `/api/projects/${projectSlug}/rag/query`, body);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error querying RAG: ${message}` }], isError: true };
    }
  }

  if (name === 'haops_discover') {
    try {
      const { projectSlug, relevantTo, q, covers, entityTypes, limit } = args as {
        projectSlug: string;
        relevantTo?: string[];
        q?: string;
        covers?: string[];
        entityTypes?: string[];
        limit?: number;
      };

      // Build URL with repeated query params for arrays (e.g. relevantTo=a&relevantTo=b).
      // The /discover endpoint is a GET — params go in the URL, not the request body.
      const qs = new URLSearchParams();
      if (relevantTo && relevantTo.length > 0) {
        relevantTo.forEach((v) => qs.append('relevantTo', v));
      }
      if (covers && covers.length > 0) {
        covers.forEach((v) => qs.append('covers', v));
      }
      if (entityTypes && entityTypes.length > 0) {
        entityTypes.forEach((v) => qs.append('entityTypes', v));
      }
      if (q) qs.set('q', q);
      if (limit !== undefined) qs.set('limit', String(limit));

      const queryString = qs.toString();
      const url = `/api/projects/${projectSlug}/discover${queryString ? `?${queryString}` : ''}`;
      const result = await apiClient.request('GET', url);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error calling discover: ${message}` }], isError: true };
    }
  }

  throw new Error(`Unknown tool: ${name}`);
  }; // end _runTool

  const result = await _runTool();
  // Fire-and-forget telemetry — must not block the response
  const responseText = result.content.map((c) => c.text).join('');
  recordToolCall(name, responseText);
  return result;
});

  return server;
}

/**
 * Start the server
 */
async function main() {
  const { httpMode, port } = parseCliArgs(process.argv);

  if (httpMode) {
    // Dynamic import so stdio mode never loads express.
    const { createHttpServer, installSignalHandlers } = await import('./http-server.js');
    // HTTP mode: the factory is called once per client session; each session
    // gets its own Server + transport but shares the `apiClient` singleton.
    const handle = await createHttpServer({ port, buildMcpServer });
    installSignalHandlers(handle);
    console.error(`HAOps MCP Server running on http://127.0.0.1:${port}/mcp`);
    console.error(`Health endpoint: http://127.0.0.1:${port}/health`);
    console.error(`API URL: ${HAOPS_API_URL}`);
    return;
  }

  // Stdio mode: single Server instance for the lifetime of the process
  // (the one stdin/stdout pair owns it).
  const server = buildMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('HAOps MCP Server running on stdio');
  console.error(`API URL: ${HAOPS_API_URL}`);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
