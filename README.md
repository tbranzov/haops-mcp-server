# HAOps MCP Server

Model Context Protocol (MCP) server for **HAOps (Human-Agent Operations)** - enables Claude to interact with HAOps project management system.

## Features

- **Resources**: Access projects, modules, features, and issues
- **Tools**: Create, update, and manage HAOps entities via Claude
- **API Key Authentication**: Secure access using HAOps API keys

## Setup

### Prerequisites

- Node.js >= 18.0.0
- HAOps instance running (local or remote)
- HAOps API key (generate via Admin → API Keys)

### Installation

```bash
cd haops-mcp-server
npm install
```

### Configuration

Create `.env` file:

```env
HAOPS_API_URL=http://localhost:3000
HAOPS_API_KEY=your-api-key-here
```

### Build

```bash
npm run build
```

### Development

```bash
npm run dev
```

## Usage

### Claude Code (CLI / VS Code Extension)

Register the MCP server via the Claude CLI:

```bash
claude mcp add-json --scope user haops '{
  "type": "stdio",
  "command": "node",
  "args": ["/path/to/feature-tracker/haops-mcp-server/dist/index.js"],
  "env": {
    "HAOPS_API_URL": "http://localhost:3000",
    "HAOPS_API_KEY": "your-api-key-here"
  }
}'
```

Verify: `claude mcp list` should show `haops: ... - ✓ Connected`

> **Note:** Do NOT manually edit `~/.claude/mcp-servers.json` — Claude Code does not read that file. Always use `claude mcp add-json`.

### Claude Desktop (App)

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "haops": {
      "command": "node",
      "args": ["/path/to/feature-tracker/haops-mcp-server/dist/index.js"],
      "env": {
        "HAOPS_API_URL": "http://localhost:3000",
        "HAOPS_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

### Manual Testing

Run the server manually:

```bash
npm start
```

The server will listen on stdio for MCP protocol messages.

## Architecture

```
haops-mcp-server/
├── src/
│   ├── index.ts          # MCP server entry point
│   ├── api/
│   │   └── client.ts     # HAOps API client (HTTP)
│   ├── resources/        # MCP resources (projects, modules, etc.)
│   └── tools/            # MCP tools (CRUD operations)
├── dist/                 # Compiled JavaScript (generated)
└── package.json
```

## Resources

MCP resources exposed by this server (with query filtering):

- `haops://projects` - List all projects
- `haops://projects/{slug}/modules?status=&priority=&ownerId=` - List modules
- `haops://projects/{slug}/features?status=&priority=` - List features
- `haops://projects/{slug}/issues?status=&priority=&assignedTo=&type=` - List issues

## Tools

MCP tools provided by this server (103 total). Key tools listed below — see `src/index.ts` for full list:

### Read Operations
- `haops_list_projects()` - List all projects
- `haops_list_members(projectSlug)` - List project members with roles and stats

### Module CRUD
- `haops_create_module(projectSlug, moduleData)` - Create new module
- `haops_update_module(projectSlug, moduleId, moduleData)` - Update module
- `haops_delete_module(projectSlug, moduleId, confirm?)` - Delete module (cascade safety check)

### Feature CRUD
- `haops_create_feature(projectSlug, featureData)` - Create new feature
- `haops_update_feature(projectSlug, featureId, featureData)` - Update feature
- `haops_delete_feature(projectSlug, featureId, confirm?)` - Delete feature (cascade safety check)

### Issue CRUD
- `haops_create_issue(projectSlug, issueData)` - Create new issue
- `haops_update_issue(projectSlug, issueId, issueData)` - Update issue
- `haops_delete_issue(projectSlug, issueId)` - Delete issue
- `haops_bulk_update_issues(projectSlug, issueIds, updates)` - Bulk update issues

### Communication
- `haops_create_discussion(projectSlug, title, ...)` - Create discussion thread
- `haops_post_message(projectSlug, discussionId, content)` - Post to discussion
- `haops_send_dm(projectSlug, recipientUserId, content)` - Send direct message

### Team Management
- `haops_add_member(projectSlug, userId, role?)` - Add project member
- `haops_update_member_role(projectSlug, userId, role)` - Update member role

### Audit & Activity
- `haops_get_activity(projectSlug, entityType, entityId)` - Entity activity log
- `haops_get_audit_log(page?, limit?, action?, entityType?)` - System audit log (admin)

## Tool Usage Examples

### 1. Create a Module

```json
{
  "projectSlug": "my-project",
  "title": "Authentication Module",
  "description": "User authentication and authorization",
  "ownerId": "user-uuid-here",
  "status": "in-progress",
  "priority": "high",
  "startDate": "2026-02-24",
  "targetDate": "2026-03-15"
}
```

**Required fields**: `projectSlug`, `title`, `ownerId`

**Status options**: `backlog`, `in-progress`, `review`, `done`, `blocked`, `on-hold`, `cancelled`

**Priority options**: `low`, `medium`, `high`, `critical`

### 2. Update a Module

```json
{
  "projectSlug": "my-project",
  "moduleId": "module-uuid-here",
  "status": "done",
  "completedDate": "2026-03-10"
}
```

**Required fields**: `projectSlug`, `moduleId`

All other fields are optional - only include fields you want to change.

### 3. Create a Feature

```json
{
  "projectSlug": "my-project",
  "moduleId": "module-uuid-here",
  "title": "OAuth2 Integration",
  "description": "Support Google and GitHub OAuth",
  "acceptanceCriteria": "Users can sign in with Google or GitHub accounts",
  "ownerId": "user-uuid-here",
  "status": "backlog",
  "priority": "medium"
}
```

**Required fields**: `projectSlug`, `moduleId`, `title`, `ownerId`

**Note**: Feature has `acceptanceCriteria` field (optional).

### 4. Update a Feature

```json
{
  "projectSlug": "my-project",
  "featureId": "feature-uuid-here",
  "status": "review",
  "ownerId": "new-owner-uuid"
}
```

**Required fields**: `projectSlug`, `featureId`

### 5. Create an Issue

```json
{
  "projectSlug": "my-project",
  "featureId": "feature-uuid-here",
  "title": "Fix OAuth redirect URL bug",
  "description": "Redirect URL is incorrect after GitHub login",
  "acceptanceCriteria": "Redirect URL points to dashboard after login",
  "type": "bug",
  "status": "backlog",
  "priority": "critical",
  "targetDate": "2026-02-28",
  "assignedTo": "user-uuid-here"
}
```

**Required fields**: `projectSlug`, `featureId`, `title`

**Type options**: `feature`, `bug`, `task`, `optimization`, `refactor`, `documentation`, `research`

**Note**: Issue uses `assignedTo` field (not `ownerId` like Module/Feature).

### 6. Update an Issue

```json
{
  "projectSlug": "my-project",
  "issueId": "issue-uuid-here",
  "status": "done",
  "type": "feature",
  "completedDate": "2026-02-25"
}
```

**Required fields**: `projectSlug`, `issueId`

### 7. Delete a Module (with safety check)

```json
{
  "projectSlug": "my-project",
  "moduleId": "module-uuid-here"
}
```

Without `confirm: true`, returns a warning listing child features/issues. Add `"confirm": true` to proceed with cascade deletion.

### 8. Bulk Update Issues

```json
{
  "projectSlug": "my-project",
  "issueIds": ["issue-1-uuid", "issue-2-uuid", "issue-3-uuid"],
  "updates": {
    "status": "done",
    "priority": "high"
  }
}
```

Updates all specified issues atomically (uses DB transaction with rollback).

### 9. Create a Discussion

```json
{
  "projectSlug": "my-project",
  "title": "Architecture Review",
  "type": "question",
  "channelId": "channel-uuid-here",
  "firstMessage": "Let's discuss the new auth flow."
}
```

Supports channel-based, entity-linked (`discussableType` + `discussableId`), or both.

### 10. Send a Direct Message

```json
{
  "projectSlug": "my-project",
  "recipientUserId": "user-uuid-here",
  "content": "Hey, can you review my PR?"
}
```

## Testing

### Run Unit Tests

```bash
npm test                # All tests
npm run test:unit       # Unit tests only (src/)
```

**Unit tests** (22 total):
- `src/api/__tests__/client.test.ts` - API client methods (6 tests)
- Backend: `lib/utils/__tests__/apiKeys.test.ts` - Key generation/hashing (9 tests)
- Backend: `lib/auth/__tests__/requireApiKey.test.ts` - Auth middleware (7 tests)

### Run Integration Tests

```bash
npm run test:integration    # Integration tests (tests/integration/)
npm run test:all            # All tests (unit + integration)
```

**Integration tests** (13 skeleton tests):
- See `tests/integration/README.md` for setup instructions
- Tests are currently templates with commented-out API calls
- Require test database and seed data to run E2E

## Development

### Project Structure

```
haops-mcp-server/
├── src/
│   ├── index.ts              # Main MCP server (stdio transport)
│   ├── api/
│   │   ├── client.ts         # HAOps API HTTP client
│   │   └── __tests__/        # API client unit tests
│   └── types/
│       └── entities.ts       # TypeScript interfaces
├── tests/
│   └── integration/          # Integration tests (E2E)
├── dist/                     # Compiled JavaScript (npm run build)
├── package.json
└── README.md
```

### Adding New Tools

1. Add TypeScript types in `src/types/entities.ts` (if needed)
2. Add API client method in `src/api/client.ts`
3. Define tool schema in `src/index.ts` (ListToolsRequestSchema handler)
   - Include inputSchema with all parameters + required fields
4. Implement tool logic in CallToolRequestSchema handler
   - Extract args with proper TypeScript typing
   - Build request payload (only include defined fields)
   - Call API client method
   - Return formatted response
5. Write unit tests in `src/api/__tests__/`
6. Add usage example to this README

### Code Quality

- **TypeScript**: Strict mode enabled, proper typing required
- **Tests**: Jest with ts-jest for ESM modules
- **Linting**: ESLint with TypeScript plugin
- **Build**: `npm run build` compiles to `dist/` directory

## Troubleshooting

### "HAOPS_API_KEY environment variable is required"

- Ensure `.env` file exists in `haops-mcp-server/` directory
- Or set environment variables in Claude Desktop config

### "Cannot connect to HAOps API"

- Check `HAOPS_API_URL` points to running HAOps instance
- Verify HAOps server is accessible (try `curl $HAOPS_API_URL/api/projects`)

### "API key authentication failed"

- Generate new API key at HAOps → Admin → API Keys
- Copy full key (shown only once)
- Ensure key is not expired

## License

MIT
