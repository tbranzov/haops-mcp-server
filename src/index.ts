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
        description: 'Create a discussion thread in a HAOps project. Can be channel-based, entity-linked (Module/Feature/Issue), or both.',
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
              description: 'UUID of the channel (for channel-based discussions)',
            },
            discussableType: {
              type: 'string',
              description: 'Entity type to link the discussion to',
              enum: ['Module', 'Feature', 'Issue'],
            },
            discussableId: {
              type: 'string',
              description: 'UUID of the entity to link the discussion to',
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
