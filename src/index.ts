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

const HAOPS_API_URL = process.env.HAOPS_API_URL || 'http://localhost:3000';
const HAOPS_API_KEY = process.env.HAOPS_API_KEY;

if (!HAOPS_API_KEY) {
  console.error('Error: HAOPS_API_KEY environment variable is required');
  process.exit(1);
}

// Initialize API client
const apiClient = new HAOpsApiClient(HAOPS_API_URL, HAOPS_API_KEY);

// Create MCP server
const server = new Server(
  { name: 'haops-mcp-server', version: '0.1.0' },
  { capabilities: { resources: {}, tools: {} } }
);

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
          },
          required: ['sectionSlug', 'title'],
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
          },
          required: ['slug'],
        },
      },

      // ===== Documentation Builder Tools =====
      {
        name: 'haops_list_doc_artifacts',
        description: 'List documentation artifacts for a project. Each artifact represents a type of documentation (architecture, developer, deployment, api, user_guide, changelog, adr).',
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
              enum: ['architecture', 'developer', 'deployment', 'api', 'user_guide', 'changelog', 'adr'],
            },
            title: {
              type: 'string',
              description: 'Artifact title',
            },
            description: {
              type: 'string',
              description: 'Artifact description (optional)',
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
          },
          required: ['projectSlug', 'artifactSlug'],
        },
      },
      {
        name: 'haops_create_doc_section',
        description: 'Create a new section within a documentation artifact.',
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
          },
          required: ['projectSlug', 'artifactSlug', 'title'],
        },
      },
      {
        name: 'haops_update_doc_section',
        description: 'Update a documentation section content, title, or source hint.',
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
        description: 'Read agent memory for a project, module, or feature. Returns baseText (consolidated knowledge) and pending log entries. Use full=true to include integrated (historical) log entries.',
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
              description: 'If true, include all log entries (including integrated ones). Default: false (only pending entries)',
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
          },
          required: ['projectSlug', 'entityType', 'entityId', 'newBaseText'],
        },
      },
      // ===== Protocol Tools =====
      {
        name: 'haops_read_protocol',
        description: 'Read the work protocol for a specific agent role in a project. Returns the current version by default, or a specific historical version. Protocols define HOW agents should work (scope, workflow, handoff, etc.).',
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
              description: 'Specific version number to read. If omitted, returns the current version.',
            },
          },
          required: ['projectSlug', 'role'],
        },
      },
      {
        name: 'haops_update_protocol',
        description: 'Update (create new version of) the work protocol for a specific agent role in a project. Creates a new version and marks the previous as historical. Architect and admin roles ONLY.',
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
              description: 'The full protocol document in markdown',
            },
            changeSummary: {
              type: 'string',
              description: 'Optional summary of what changed in this version',
            },
          },
          required: ['projectSlug', 'role', 'content'],
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
      // ===== Project Tree =====
      {
        name: 'haops_get_project_tree',
        description: 'Returns the COMPLETE work hierarchy for a project in flat arrays (modules, features, issues). Use this for a quick project overview instead of calling list_modules + list_features + list_issues separately.',
        inputSchema: {
          type: 'object',
          properties: {
            projectSlug: { type: 'string', description: 'The project slug (URL identifier)' },
          },
          required: ['projectSlug'],
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
          },
          required: ['projectSlug', 'ticketId', 'status'],
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
      return {
        content: [
          {
            type: 'text',
            text: `Module created successfully:\n${JSON.stringify(module, null, 2)}`,
          },
        ],
      };
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
      return {
        content: [
          {
            type: 'text',
            text: `Module updated successfully:\n${JSON.stringify(module, null, 2)}`,
          },
        ],
      };
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
      return {
        content: [
          {
            type: 'text',
            text: `Feature created successfully:\n${JSON.stringify(feature, null, 2)}`,
          },
        ],
      };
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
      return {
        content: [
          {
            type: 'text',
            text: `Feature updated successfully:\n${JSON.stringify(feature, null, 2)}`,
          },
        ],
      };
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
      return {
        content: [
          {
            type: 'text',
            text: `Issue created successfully:\n${JSON.stringify(issue, null, 2)}`,
          },
        ],
      };
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
      return {
        content: [
          {
            type: 'text',
            text: `Issue updated successfully:\n${JSON.stringify(issue, null, 2)}`,
          },
        ],
      };
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
      return {
        content: [{
          type: 'text',
          text: `Discussion created successfully:\n${JSON.stringify(discussion, null, 2)}`,
        }],
      };
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
      return {
        content: [{
          type: 'text',
          text: `Message posted successfully:\n${JSON.stringify(msg, null, 2)}`,
        }],
      };
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
      return {
        content: [{
          type: 'text',
          text: `Direct message sent successfully:\n${JSON.stringify(dm, null, 2)}`,
        }],
      };
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
      return {
        content: [{
          type: 'text',
          text: `Discussion updated successfully:\n${JSON.stringify(discussion, null, 2)}`,
        }],
      };
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
      return {
        content: [{
          type: 'text',
          text: `Message edited successfully:\n${JSON.stringify(msg, null, 2)}`,
        }],
      };
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
      return {
        content: [{
          type: 'text',
          text: `Member added successfully:\n${JSON.stringify(member, null, 2)}`,
        }],
      };
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
      return {
        content: [{
          type: 'text',
          text: `Member role updated successfully:\n${JSON.stringify(member, null, 2)}`,
        }],
      };
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
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
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
      const result = await apiClient.request('POST', `/api/projects/${projectSlug}/docs`, {
        type, title, description,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
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
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
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
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  }

  if (name === 'haops_update_doc_section') {
    try {
      const { projectSlug, artifactSlug, sectionSlug, title, content, sourceHint } = args as {
        projectSlug: string; artifactSlug: string; sectionSlug: string; title?: string; content?: string; sourceHint?: string;
      };
      const body: Record<string, unknown> = {};
      if (title !== undefined) body.title = title;
      if (content !== undefined) body.content = content;
      if (sourceHint !== undefined) body.sourceHint = sourceHint;
      const result = await apiClient.request('PUT', `/api/projects/${projectSlug}/docs/${artifactSlug}/sections/${sectionSlug}`, body);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
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

      const memory = await apiClient.readMemory(projectSlug, entityType, entityId, full);

      const pendingEntries = memory.log.filter(e => !e.integrated);
      const lines = [
        `Agent memory for ${entityType} ${entityId}:`,
        '',
        '## Base Text',
        memory.baseText || '(empty)',
        '',
        `## Log Entries (${full ? 'all' : 'pending only'}: ${full ? memory.log.length : pendingEntries.length})`,
      ];

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

      const entry = await apiClient.appendMemoryLog(
        projectSlug, entityType, entityId, tag as 'context' | 'decision' | 'progress' | 'issue' | 'review' | 'deploy', content,
      );

      return {
        content: [{
          type: 'text',
          text: `Memory log entry appended successfully:\n${JSON.stringify(entry, null, 2)}`,
        }],
      };
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
      const { projectSlug, role, version } = args as {
        projectSlug: string;
        role: string;
        version?: number;
      };

      const result = await apiClient.readProtocol(projectSlug, role, version);

      // Format for readability — show content as markdown, not JSON
      const lines = [
        `Protocol for role "${role}" in project "${projectSlug}":`,
        `Version: ${result.version || 'N/A'}`,
        `Updated: ${result.createdAt || 'N/A'}`,
        result.updatedByKey ? `Updated by: ${result.updatedByKey}` : '',
        result.changeSummary ? `Change summary: ${result.changeSummary}` : '',
        '',
        '---',
        '',
        (result.content as string) || '(empty)',
      ].filter(Boolean);

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
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
      const { projectSlug, role, content, changeSummary } = args as {
        projectSlug: string;
        role: string;
        content: string;
        changeSummary?: string;
      };

      const result = await apiClient.updateProtocol(projectSlug, role, content, changeSummary);

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
      return {
        content: [{ type: 'text', text: `Test run reported successfully:\n${JSON.stringify(result, null, 2)}` }],
      };
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
      return {
        content: [{ type: 'text', text: `Tests linked successfully:\n${JSON.stringify(result, null, 2)}` }],
      };
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
      return {
        content: [{ type: 'text', text: `Test suite imported successfully:\n${JSON.stringify(result, null, 2)}` }],
      };
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

  // ===== Project Tree =====

  if (name === 'haops_get_project_tree') {
    try {
      const { projectSlug } = args as { projectSlug: string };
      const result = await apiClient.request('GET', `/api/projects/${projectSlug}/tree`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error getting project tree: ${message}` }], isError: true };
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
      return { content: [{ type: 'text', text: `Channel created:\n${JSON.stringify(result, null, 2)}` }] };
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
      return { content: [{ type: 'text', text: `Channel updated:\n${JSON.stringify(result, null, 2)}` }] };
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
      const result = await apiClient.request('POST', `/api/projects/${projectSlug}/git/merge-requests/${mergeRequestId}/close`);
      return { content: [{ type: 'text', text: `Merge request closed:\n${JSON.stringify(result, null, 2)}` }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error closing merge request: ${message}` }], isError: true };
    }
  }

  if (name === 'haops_reopen_merge_request') {
    try {
      const { projectSlug, mergeRequestId } = args as { projectSlug: string; mergeRequestId: string };
      const result = await apiClient.request('POST', `/api/projects/${projectSlug}/git/merge-requests/${mergeRequestId}/reopen`);
      return { content: [{ type: 'text', text: `Merge request reopened:\n${JSON.stringify(result, null, 2)}` }] };
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
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
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
        return { content: [{ type: 'text', text: `Repository created:\n${JSON.stringify(result, null, 2)}` }] };
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
        return { content: [{ type: 'text', text: `Repository updated:\n${JSON.stringify(result, null, 2)}` }] };
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
      return { content: [{ type: 'text', text: `Ticket created:\n${JSON.stringify(result, null, 2)}` }] };
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
      return { content: [{ type: 'text', text: `Ticket updated:\n${JSON.stringify(result, null, 2)}` }] };
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
      return { content: [{ type: 'text', text: `Message sent (${direction}):\n${JSON.stringify(result, null, 2)}` }] };
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
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
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
      return { content: [{ type: 'text', text: `Ticket ${status}:\n${JSON.stringify(result, null, 2)}` }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error closing ticket: ${message}` }], isError: true };
    }
  }

  throw new Error(`Unknown tool: ${name}`);
});

/**
 * Start the server
 */
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('HAOps MCP Server running on stdio');
  console.error(`API URL: ${HAOPS_API_URL}`);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
