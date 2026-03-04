# Integration Tests for HAOps MCP Server

## Overview

Integration tests verify end-to-end functionality of the MCP server by testing against a real or mocked HAOps API instance. These tests validate:

- All 6 MCP tools (Module/Feature/Issue CRUD)
- All 4 MCP resources (projects, modules, features, issues)
- Error handling (404, 401, validation errors)
- Data consistency and proper request/response formats

## Current Status

⚠️ **NOTE**: The integration tests in `mcp-tools.test.ts` are currently **skeleton tests** with commented-out API calls. They serve as a template for future implementation.

To make these tests functional, you need to:

1. **Set up a test database** - Clone production schema to a test DB
2. **Seed test data** - Create test project, users, and API keys
3. **Start HAOps dev server** - Run on localhost:3000 (or test port)
4. **Uncomment API calls** - Enable the actual `client.*()` method calls
5. **Add cleanup logic** - Delete test data after each test run

## Running Integration Tests

### Prerequisites

```bash
# 1. Set up test database
createdb feature_tracker_test

# 2. Run migrations on test DB
DATABASE_URL=postgres://user@localhost:5432/feature_tracker_test npx sequelize-cli db:migrate

# 3. Create test user and API key via admin UI or seeder
# (or run a seed script that creates test data)

# 4. Set environment variables
export HAOPS_API_URL=http://localhost:3000
export HAOPS_API_KEY=your-test-api-key-here
```

### Run Tests

```bash
# Run all integration tests
npm run test:integration

# Run specific test file
npm test -- tests/integration/mcp-tools.test.ts

# Run with coverage
npm test -- --coverage tests/integration/
```

### Expected Test Flow

1. **Setup phase**:
   - Initialize HAOpsApiClient with test API key
   - Ensure test project exists in database

2. **CRUD tests**:
   - Create module → verify response contains `id`, `title`, etc.
   - Update module → verify fields changed
   - Create feature → link to module
   - Update feature
   - Create issue → link to feature, test `type` enum
   - Update issue

3. **Read tests**:
   - List projects → verify array returned
   - List modules → verify filtering by project
   - List features
   - List issues

4. **Error tests**:
   - Invalid API key → 401 error
   - Non-existent entity → 404 error
   - Missing required fields → validation error

5. **Cleanup phase**:
   - Delete all created test entities
   - Restore database to clean state

## Test Data Requirements

For integration tests to run successfully, you need:

- **Test Project**: `slug: "test-project"` in database
- **Test User**: Active user with ID referenced in tests
- **API Key**: Valid, non-expired key for the test user
- **Database**: Empty tables or consistent seed data

## Mocking vs Real API

### Option 1: Real API (Recommended for E2E)
- Start local HAOps server (`npm run dev`)
- Tests hit actual API routes
- Database changes are real (requires cleanup)
- **Pros**: Tests full stack, catches DB issues
- **Cons**: Slower, requires server running

### Option 2: Mocked API (Recommended for CI/CD)
- Use `nock` or `msw` to mock HTTP responses
- No database or server required
- **Pros**: Fast, isolated, works in CI
- **Cons**: Doesn't test actual API logic

## Future Improvements

- [ ] Implement test database setup/teardown scripts
- [ ] Add seed data generation for consistent test state
- [ ] Uncomment and complete all test cases
- [ ] Add coverage threshold (target: 80%+)
- [ ] Integrate with CI/CD pipeline (GitHub Actions)
- [ ] Add mock server option for faster tests
- [ ] Test MCP resources (not just tools)
- [ ] Test concurrent operations (race conditions)

## Related Files

- `../src/api/client.ts` - API client being tested
- `../src/index.ts` - MCP server with tool handlers
- `../src/types/entities.ts` - TypeScript interfaces
- `../../lib/auth/requireApiKey.ts` - Authentication middleware

## Contact

For questions or issues with integration tests, contact the dev team.
