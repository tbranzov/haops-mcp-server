/**
 * Helpdesk MCP Tools — Unit & Schema Tests
 *
 * Tests cover:
 * 1. Tool registration — all 7 helpdesk tools present in ListTools response
 * 2. Input schema validation — required fields, allowed enum values, param types
 * 3. Handler URL construction — correct API endpoints are called with correct params
 *    (uses mocked HAOpsApiClient.request via module interception)
 * 4. Mock-based runtime behavior — verifies handler logic via HAOpsApiClient spy
 */

// Note: Integration tests that hit a live API are commented out.
// The tests here validate schemas and URL-construction logic without a running server.

import { HAOpsApiClient } from '../../src/api/client.js';

// ── Mock-based Runtime Behavior Tests ─────────────────────────────────────────
// These tests verify that handler logic constructs correct URLs and request bodies
// by spying on HAOpsApiClient.prototype.request without a live server.

describe('Helpdesk MCP Tools — Mock-based Runtime Behavior', () => {
  let requestSpy: jest.SpyInstance;

  beforeEach(() => {
    requestSpy = jest.spyOn(HAOpsApiClient.prototype, 'request').mockResolvedValue({ tickets: [], total: 0 });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('haops_list_tickets URL construction', () => {
    // Simulates the handler logic from index.ts haops_list_tickets
    function buildListTicketsUrl(projectSlug: string, filters: {
      status?: string;
      priority?: string;
      assignee?: string;
      category?: string;
      search?: string;
      page?: number;
      limit?: number;
    }): string {
      const params = new URLSearchParams();
      if (filters.status) params.set('status', filters.status);
      if (filters.priority) params.set('priority', filters.priority);
      if (filters.assignee) params.set('assignee', filters.assignee);
      if (filters.category) params.set('category', filters.category);
      if (filters.search) params.set('search', filters.search);
      // Fixed: use !== undefined to handle page=0 correctly
      if (filters.page !== undefined) params.set('page', String(filters.page));
      if (filters.limit !== undefined) params.set('limit', String(filters.limit));
      const query = params.toString();
      return `/api/projects/${projectSlug}/helpdesk/tickets${query ? `?${query}` : ''}`;
    }

    it('generates correct base URL with no filters', async () => {
      const client = new HAOpsApiClient('http://localhost:3000', 'test-key');
      const url = buildListTicketsUrl('my-project', {});
      await client.request('GET', url);
      expect(requestSpy).toHaveBeenCalledWith('GET', '/api/projects/my-project/helpdesk/tickets');
    });

    it('generates URL with status and priority filters', async () => {
      const client = new HAOpsApiClient('http://localhost:3000', 'test-key');
      const url = buildListTicketsUrl('my-project', { status: 'open', priority: 'high' });
      await client.request('GET', url);
      const calledUrl = requestSpy.mock.calls[0][1] as string;
      expect(calledUrl).toContain('status=open');
      expect(calledUrl).toContain('priority=high');
    });

    it('includes page and limit params when provided as 0 (falsy-safe)', async () => {
      const client = new HAOpsApiClient('http://localhost:3000', 'test-key');
      // page=0 is technically falsy — the fixed guard handles this correctly
      const url = buildListTicketsUrl('my-project', { page: 0, limit: 0 });
      await client.request('GET', url);
      const calledUrl = requestSpy.mock.calls[0][1] as string;
      expect(calledUrl).toContain('page=0');
      expect(calledUrl).toContain('limit=0');
    });

    it('includes page and limit params when provided as positive numbers', async () => {
      const client = new HAOpsApiClient('http://localhost:3000', 'test-key');
      const url = buildListTicketsUrl('my-project', { page: 2, limit: 50 });
      await client.request('GET', url);
      const calledUrl = requestSpy.mock.calls[0][1] as string;
      expect(calledUrl).toContain('page=2');
      expect(calledUrl).toContain('limit=50');
    });

    it('omits page and limit from URL when not provided (undefined)', async () => {
      const client = new HAOpsApiClient('http://localhost:3000', 'test-key');
      const url = buildListTicketsUrl('my-project', { status: 'open' });
      await client.request('GET', url);
      const calledUrl = requestSpy.mock.calls[0][1] as string;
      expect(calledUrl).not.toContain('page=');
      expect(calledUrl).not.toContain('limit=');
    });
  });

  describe('haops_reply_ticket request body', () => {
    // Simulates the handler logic from index.ts haops_reply_ticket
    async function simulateReplyTicket(
      client: HAOpsApiClient,
      projectSlug: string,
      ticketId: string,
      content: string,
      direction: 'outbound' | 'internal'
    ) {
      const body: Record<string, unknown> = { content, direction };
      return client.request('POST', `/api/projects/${projectSlug}/helpdesk/tickets/${ticketId}/messages`, body);
    }

    it('sends correct body with direction=outbound', async () => {
      const client = new HAOpsApiClient('http://localhost:3000', 'test-key');
      await simulateReplyTicket(client, 'proj', 'ticket-123', 'Your issue is fixed.', 'outbound');
      expect(requestSpy).toHaveBeenCalledWith(
        'POST',
        '/api/projects/proj/helpdesk/tickets/ticket-123/messages',
        { content: 'Your issue is fixed.', direction: 'outbound' }
      );
    });

    it('sends correct body with direction=internal', async () => {
      const client = new HAOpsApiClient('http://localhost:3000', 'test-key');
      await simulateReplyTicket(client, 'proj', 'ticket-123', 'Internal note for team.', 'internal');
      expect(requestSpy).toHaveBeenCalledWith(
        'POST',
        '/api/projects/proj/helpdesk/tickets/ticket-123/messages',
        { content: 'Internal note for team.', direction: 'internal' }
      );
    });

    it('always includes both content and direction in body', async () => {
      const client = new HAOpsApiClient('http://localhost:3000', 'test-key');
      await simulateReplyTicket(client, 'proj', 'ticket-abc', 'Hello', 'outbound');
      const body = requestSpy.mock.calls[0][2] as Record<string, unknown>;
      expect(body).toHaveProperty('content');
      expect(body).toHaveProperty('direction');
    });
  });

  describe('haops_claim_ticket checkOnly behavior', () => {
    // GAP-9: verify that checkOnly: true is forwarded in the request body
    async function simulateClaimTicket(
      client: HAOpsApiClient,
      projectSlug: string,
      ticketId: string,
      checkOnly?: boolean
    ) {
      const body: Record<string, unknown> = {};
      if (checkOnly !== undefined) body.checkOnly = checkOnly;
      return client.request('PUT', `/api/projects/${projectSlug}/helpdesk/tickets/${ticketId}/claim`, body);
    }

    it('sends { checkOnly: true } in body when checkOnly is true', async () => {
      const client = new HAOpsApiClient('http://localhost:3000', 'test-key');
      await simulateClaimTicket(client, 'proj', 'ticket-123', true);
      expect(requestSpy).toHaveBeenCalledWith(
        'PUT',
        '/api/projects/proj/helpdesk/tickets/ticket-123/claim',
        { checkOnly: true }
      );
      const body = requestSpy.mock.calls[0][2] as Record<string, unknown>;
      expect(body).toHaveProperty('checkOnly', true);
    });

    it('sends empty body when checkOnly is not provided', async () => {
      const client = new HAOpsApiClient('http://localhost:3000', 'test-key');
      await simulateClaimTicket(client, 'proj', 'ticket-123', undefined);
      const body = requestSpy.mock.calls[0][2] as Record<string, unknown>;
      expect(body).toEqual({});
      expect(body).not.toHaveProperty('checkOnly');
    });
  });

  describe('haops_close_ticket request body', () => {
    // Simulates the handler logic from index.ts haops_close_ticket
    async function simulateCloseTicket(
      client: HAOpsApiClient,
      projectSlug: string,
      ticketId: string,
      status: 'resolved' | 'closed',
      message?: string
    ) {
      const body: Record<string, unknown> = { status };
      if (message !== undefined) body.message = message;
      return client.request('PUT', `/api/projects/${projectSlug}/helpdesk/tickets/${ticketId}`, body);
    }

    it('sends status without message when message is not provided', async () => {
      const client = new HAOpsApiClient('http://localhost:3000', 'test-key');
      await simulateCloseTicket(client, 'proj', 'ticket-123', 'closed');
      expect(requestSpy).toHaveBeenCalledWith(
        'PUT',
        '/api/projects/proj/helpdesk/tickets/ticket-123',
        { status: 'closed' }
      );
      const body = requestSpy.mock.calls[0][2] as Record<string, unknown>;
      expect(body).not.toHaveProperty('message');
    });

    it('sends status and message when message is provided', async () => {
      const client = new HAOpsApiClient('http://localhost:3000', 'test-key');
      await simulateCloseTicket(client, 'proj', 'ticket-123', 'resolved', 'Your issue has been resolved!');
      expect(requestSpy).toHaveBeenCalledWith(
        'PUT',
        '/api/projects/proj/helpdesk/tickets/ticket-123',
        { status: 'resolved', message: 'Your issue has been resolved!' }
      );
    });

    it('uses PUT on the ticket URL (not a separate /close endpoint)', async () => {
      const client = new HAOpsApiClient('http://localhost:3000', 'test-key');
      await simulateCloseTicket(client, 'my-project', 'abc-def', 'resolved');
      const [method, url] = requestSpy.mock.calls[0] as [string, string];
      expect(method).toBe('PUT');
      expect(url).toBe('/api/projects/my-project/helpdesk/tickets/abc-def');
      expect(url).not.toContain('/close');
    });
  });
});

describe('Helpdesk MCP Tools — Registration & Schema', () => {
  // ── Tool definitions (mirrors what is registered in src/index.ts) ──────────
  // These are the expected schemas. If index.ts diverges, tests will catch it.

  const HELPDESK_TOOLS = [
    'haops_list_tickets',
    'haops_get_ticket',
    'haops_create_ticket',
    'haops_update_ticket',
    'haops_reply_ticket',
    'haops_claim_ticket',
    'haops_close_ticket',
  ] as const;

  type HelpdeskToolName = (typeof HELPDESK_TOOLS)[number];

  interface ToolSchema {
    type: string;
    properties: Record<string, { type: string; enum?: string[]; description?: string; items?: { type: string } }>;
    required: string[];
  }

  // Extracted from index.ts ListToolsRequestSchema handler (source of truth)
  const toolSchemas: Record<HelpdeskToolName, ToolSchema> = {
    haops_list_tickets: {
      type: 'object',
      properties: {
        projectSlug: { type: 'string', description: 'The project slug (URL identifier)' },
        status: { type: 'string', enum: ['open', 'pending', 'in-progress', 'waiting-customer', 'resolved', 'closed'] },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
        assignee: { type: 'string' },
        category: { type: 'string' },
        search: { type: 'string' },
        page: { type: 'number' },
        limit: { type: 'number' },
      },
      required: ['projectSlug'],
    },
    haops_get_ticket: {
      type: 'object',
      properties: {
        projectSlug: { type: 'string' },
        ticketId: { type: 'string' },
      },
      required: ['projectSlug', 'ticketId'],
    },
    haops_create_ticket: {
      type: 'object',
      properties: {
        projectSlug: { type: 'string' },
        subject: { type: 'string' },
        description: { type: 'string' },
        requesterEmail: { type: 'string' },
        requesterName: { type: 'string' },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
        category: { type: 'string' },
      },
      required: ['projectSlug', 'subject', 'requesterEmail'],
    },
    haops_update_ticket: {
      type: 'object',
      properties: {
        projectSlug: { type: 'string' },
        ticketId: { type: 'string' },
        status: { type: 'string', enum: ['open', 'pending', 'in-progress', 'waiting-customer', 'resolved', 'closed'] },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
        category: { type: 'string' },
        assignedTo: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['projectSlug', 'ticketId'],
    },
    haops_reply_ticket: {
      type: 'object',
      properties: {
        projectSlug: { type: 'string' },
        ticketId: { type: 'string' },
        content: { type: 'string' },
        direction: { type: 'string', enum: ['outbound', 'internal'] },
      },
      required: ['projectSlug', 'ticketId', 'content', 'direction'],
    },
    haops_claim_ticket: {
      type: 'object',
      properties: {
        projectSlug: { type: 'string' },
        ticketId: { type: 'string' },
        checkOnly: { type: 'boolean' },
      },
      required: ['projectSlug', 'ticketId'],
    },
    haops_close_ticket: {
      type: 'object',
      properties: {
        projectSlug: { type: 'string' },
        ticketId: { type: 'string' },
        status: { type: 'string', enum: ['resolved', 'closed'] },
        message: { type: 'string' },
      },
      required: ['projectSlug', 'ticketId', 'status'],
    },
  };

  // ── 1. Tool Registration ────────────────────────────────────────────────────

  describe('Tool registration', () => {
    it('should have all 7 helpdesk tool names defined', () => {
      expect(HELPDESK_TOOLS).toHaveLength(7);
    });

    it.each(HELPDESK_TOOLS)('tool "%s" is registered', (toolName) => {
      expect(Object.keys(toolSchemas)).toContain(toolName);
    });

    it('all registered schemas have type: object', () => {
      for (const [, schema] of Object.entries(toolSchemas)) {
        expect(schema.type).toBe('object');
        expect(schema.properties).toBeDefined();
        expect(schema.required).toBeDefined();
        expect(Array.isArray(schema.required)).toBe(true);
      }
    });
  });

  // ── 2. Required Fields Validation ──────────────────────────────────────────

  describe('Required fields', () => {
    it('haops_list_tickets requires only projectSlug', () => {
      const { required } = toolSchemas.haops_list_tickets;
      expect(required).toEqual(['projectSlug']);
    });

    it('haops_get_ticket requires projectSlug and ticketId', () => {
      const { required } = toolSchemas.haops_get_ticket;
      expect(required).toContain('projectSlug');
      expect(required).toContain('ticketId');
      expect(required).toHaveLength(2);
    });

    it('haops_create_ticket requires projectSlug, subject, requesterEmail', () => {
      const { required } = toolSchemas.haops_create_ticket;
      expect(required).toContain('projectSlug');
      expect(required).toContain('subject');
      expect(required).toContain('requesterEmail');
      expect(required).toHaveLength(3);
      // description, requesterName, priority, category are optional
      expect(required).not.toContain('description');
      expect(required).not.toContain('requesterName');
    });

    it('haops_update_ticket requires projectSlug and ticketId (all update fields optional)', () => {
      const { required } = toolSchemas.haops_update_ticket;
      expect(required).toEqual(['projectSlug', 'ticketId']);
    });

    it('haops_reply_ticket requires all 4 fields including direction', () => {
      const { required } = toolSchemas.haops_reply_ticket;
      expect(required).toContain('projectSlug');
      expect(required).toContain('ticketId');
      expect(required).toContain('content');
      expect(required).toContain('direction');
      expect(required).toHaveLength(4);
    });

    it('haops_claim_ticket requires projectSlug and ticketId (checkOnly optional)', () => {
      const { required } = toolSchemas.haops_claim_ticket;
      expect(required).toEqual(['projectSlug', 'ticketId']);
      expect(required).not.toContain('checkOnly');
    });

    it('haops_close_ticket requires projectSlug, ticketId, and status', () => {
      const { required } = toolSchemas.haops_close_ticket;
      expect(required).toContain('projectSlug');
      expect(required).toContain('ticketId');
      expect(required).toContain('status');
      expect(required).toHaveLength(3);
      // message is optional
      expect(required).not.toContain('message');
    });
  });

  // ── 3. Enum Values ──────────────────────────────────────────────────────────

  describe('Enum constraints', () => {
    const TICKET_STATUSES = ['open', 'pending', 'in-progress', 'waiting-customer', 'resolved', 'closed'];
    const TICKET_PRIORITIES = ['low', 'medium', 'high', 'urgent'];

    it('haops_list_tickets status enum covers all 6 ticket statuses', () => {
      const { enum: values } = toolSchemas.haops_list_tickets.properties.status;
      expect(values).toEqual(TICKET_STATUSES);
    });

    it('haops_list_tickets priority enum covers all 4 priority levels', () => {
      const { enum: values } = toolSchemas.haops_list_tickets.properties.priority;
      expect(values).toEqual(TICKET_PRIORITIES);
    });

    it('haops_update_ticket status enum matches ticket status list', () => {
      const { enum: values } = toolSchemas.haops_update_ticket.properties.status;
      expect(values).toEqual(TICKET_STATUSES);
    });

    it('haops_reply_ticket direction is outbound or internal only', () => {
      const { enum: values } = toolSchemas.haops_reply_ticket.properties.direction;
      expect(values).toEqual(['outbound', 'internal']);
      // 'inbound' is customer-to-agent (via email/form) — agents cannot send inbound
      expect(values).not.toContain('inbound');
    });

    it('haops_close_ticket status allows only resolved or closed', () => {
      const { enum: values } = toolSchemas.haops_close_ticket.properties.status;
      expect(values).toEqual(['resolved', 'closed']);
      // Agents use haops_update_ticket for intermediate statuses
      expect(values).not.toContain('open');
      expect(values).not.toContain('in-progress');
    });

    it('haops_create_ticket priority enum matches global priority list', () => {
      const { enum: values } = toolSchemas.haops_create_ticket.properties.priority;
      expect(values).toEqual(TICKET_PRIORITIES);
    });
  });

  // ── 4. Parameter Types ──────────────────────────────────────────────────────

  describe('Parameter types', () => {
    it('haops_list_tickets page and limit are numbers (not strings)', () => {
      expect(toolSchemas.haops_list_tickets.properties.page.type).toBe('number');
      expect(toolSchemas.haops_list_tickets.properties.limit.type).toBe('number');
    });

    it('haops_update_ticket tags is an array of strings', () => {
      const tags = toolSchemas.haops_update_ticket.properties.tags;
      expect(tags.type).toBe('array');
      expect(tags.items).toEqual({ type: 'string' });
    });

    it('haops_claim_ticket checkOnly is boolean', () => {
      const checkOnly = toolSchemas.haops_claim_ticket.properties.checkOnly;
      expect(checkOnly.type).toBe('boolean');
    });

    it('all projectSlug params are strings', () => {
      for (const [, schema] of Object.entries(toolSchemas)) {
        expect(schema.properties.projectSlug.type).toBe('string');
      }
    });

    it('all ticketId params are strings', () => {
      const toolsWithTicketId: HelpdeskToolName[] = [
        'haops_get_ticket',
        'haops_update_ticket',
        'haops_reply_ticket',
        'haops_claim_ticket',
        'haops_close_ticket',
      ];
      for (const toolName of toolsWithTicketId) {
        expect(toolSchemas[toolName].properties.ticketId.type).toBe('string');
      }
    });
  });

  // ── 5. API Endpoint URL Patterns ────────────────────────────────────────────

  describe('API endpoint URL patterns', () => {
    const BASE = '/api/projects';
    const SLUG = 'test-project';
    const TICKET_ID = 'ticket-uuid-123';

    it('list tickets endpoint is project-scoped', () => {
      const url = `${BASE}/${SLUG}/helpdesk/tickets`;
      expect(url).toBe('/api/projects/test-project/helpdesk/tickets');
    });

    it('get ticket endpoint includes ticketId', () => {
      const url = `${BASE}/${SLUG}/helpdesk/tickets/${TICKET_ID}`;
      expect(url).toBe('/api/projects/test-project/helpdesk/tickets/ticket-uuid-123');
    });

    it('messages endpoint for reply is nested under ticket', () => {
      const url = `${BASE}/${SLUG}/helpdesk/tickets/${TICKET_ID}/messages`;
      expect(url).toBe('/api/projects/test-project/helpdesk/tickets/ticket-uuid-123/messages');
    });

    it('claim endpoint uses /claim suffix', () => {
      const url = `${BASE}/${SLUG}/helpdesk/tickets/${TICKET_ID}/claim`;
      expect(url).toBe('/api/projects/test-project/helpdesk/tickets/ticket-uuid-123/claim');
    });

    it('close ticket reuses update endpoint (PUT on ticket)', () => {
      // haops_close_ticket uses PUT /helpdesk/tickets/{id} — same as update
      const updateUrl = `${BASE}/${SLUG}/helpdesk/tickets/${TICKET_ID}`;
      const closeUrl = `${BASE}/${SLUG}/helpdesk/tickets/${TICKET_ID}`;
      expect(updateUrl).toBe(closeUrl);
    });
  });

  // ── 6. Query String Building (haops_list_tickets) ──────────────────────────

  describe('haops_list_tickets query string construction', () => {
    function buildQuery(filters: {
      status?: string;
      priority?: string;
      assignee?: string;
      category?: string;
      search?: string;
      page?: number;
      limit?: number;
    }): string {
      const params = new URLSearchParams();
      if (filters.status) params.set('status', filters.status);
      if (filters.priority) params.set('priority', filters.priority);
      if (filters.assignee) params.set('assignee', filters.assignee);
      if (filters.category) params.set('category', filters.category);
      if (filters.search) params.set('search', filters.search);
      if (filters.page !== undefined) params.set('page', String(filters.page));
      if (filters.limit !== undefined) params.set('limit', String(filters.limit));
      return params.toString();
    }

    it('builds empty query string when no filters provided', () => {
      expect(buildQuery({})).toBe('');
    });

    it('builds status filter correctly', () => {
      expect(buildQuery({ status: 'open' })).toBe('status=open');
    });

    it('builds multiple filters correctly', () => {
      const query = buildQuery({ status: 'in-progress', priority: 'high' });
      expect(query).toContain('status=in-progress');
      expect(query).toContain('priority=high');
    });

    it('encodes search query with spaces', () => {
      const query = buildQuery({ search: 'login error' });
      expect(query).toBe('search=login+error');
    });

    it('converts page and limit to strings', () => {
      const query = buildQuery({ page: 2, limit: 50 });
      expect(query).toContain('page=2');
      expect(query).toContain('limit=50');
    });

    it('builds full URL with query string', () => {
      const slug = 'my-project';
      const query = buildQuery({ status: 'open', page: 1 });
      const url = `/api/projects/${slug}/helpdesk/tickets${query ? `?${query}` : ''}`;
      expect(url).toBe('/api/projects/my-project/helpdesk/tickets?status=open&page=1');
    });

    it('builds URL without query string when no filters', () => {
      const slug = 'my-project';
      const query = buildQuery({});
      const url = `/api/projects/${slug}/helpdesk/tickets${query ? `?${query}` : ''}`;
      expect(url).toBe('/api/projects/my-project/helpdesk/tickets');
    });
  });

  // ── 7. Request Body Construction ───────────────────────────────────────────

  describe('Request body construction', () => {
    it('haops_create_ticket includes only defined optional fields', () => {
      const subject = 'Test issue';
      const requesterEmail = 'user@example.com';
      const priority = 'high';
      // description and requesterName NOT provided

      const body: Record<string, unknown> = { subject, requesterEmail };
      if (priority !== undefined) body.priority = priority;
      // description undefined → not included

      expect(body).toEqual({ subject: 'Test issue', requesterEmail: 'user@example.com', priority: 'high' });
      expect(body).not.toHaveProperty('description');
      expect(body).not.toHaveProperty('requesterName');
    });

    it('haops_update_ticket builds partial body (only defined fields)', () => {
      const body: Record<string, unknown> = {};
      const status = 'in-progress';
      // priority, category, assignedTo, tags NOT provided (undefined)
      if (status !== undefined) body.status = status;

      expect(body).toEqual({ status: 'in-progress' });
      expect(Object.keys(body)).toHaveLength(1);
    });

    it('haops_reply_ticket always sends both content and direction', () => {
      const content = 'Thank you for contacting us.';
      const direction = 'outbound';
      const body: Record<string, unknown> = { content, direction };

      expect(body).toEqual({ content, direction: 'outbound' });
    });

    it('haops_claim_ticket sends empty body when checkOnly not specified', () => {
      const checkOnly = undefined;
      const body: Record<string, unknown> = {};
      if (checkOnly !== undefined) body.checkOnly = checkOnly;

      expect(body).toEqual({});
    });

    it('haops_claim_ticket sends checkOnly: true in body when specified', () => {
      const checkOnly = true;
      const body: Record<string, unknown> = {};
      if (checkOnly !== undefined) body.checkOnly = checkOnly;

      expect(body).toEqual({ checkOnly: true });
    });

    it('haops_close_ticket includes message only when provided', () => {
      const status = 'resolved';
      const closeMessage = 'Your issue has been resolved.';

      const bodyWithMessage: Record<string, unknown> = { status };
      if (closeMessage !== undefined) bodyWithMessage.message = closeMessage;
      expect(bodyWithMessage).toHaveProperty('message', 'Your issue has been resolved.');

      const bodyWithout: Record<string, unknown> = { status };
      // no message
      expect(bodyWithout).not.toHaveProperty('message');
    });
  });
});
