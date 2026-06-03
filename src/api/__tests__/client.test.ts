import axios from 'axios';
import { HAOpsApiClient, HAOpsApiError } from '../client';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('HAOpsApiClient', () => {
  let client: HAOpsApiClient;
  const mockCreate = jest.fn();

  beforeEach(() => {
    mockCreate.mockReturnValue({
      get: jest.fn(),
      post: jest.fn(),
      put: jest.fn(),
      delete: jest.fn(),
    });
    mockedAxios.create = mockCreate;
    client = new HAOpsApiClient('http://localhost:3000', 'test-api-key');
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should create axios instance with correct config', () => {
    expect(mockCreate).toHaveBeenCalledWith({
      baseURL: 'http://localhost:3000',
      headers: {
        'Authorization': 'Bearer test-api-key',
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    });
  });

  describe('Projects', () => {
    it('should list projects', async () => {
      const mockProjects = [
        { id: '1', slug: 'test-project', title: 'Test Project' },
      ];
      const axiosInstance = mockCreate.mock.results[0].value;
      axiosInstance.get.mockResolvedValue({ data: mockProjects });

      const result = await client.listProjects();

      expect(axiosInstance.get).toHaveBeenCalledWith('/api/projects');
      expect(result).toEqual(mockProjects);
    });

    it('should get project by slug', async () => {
      const mockProject = { id: '1', slug: 'test-project', title: 'Test' };
      const axiosInstance = mockCreate.mock.results[0].value;
      axiosInstance.get.mockResolvedValue({ data: mockProject });

      const result = await client.getProject('test-project');

      expect(axiosInstance.get).toHaveBeenCalledWith('/api/projects/test-project');
      expect(result).toEqual(mockProject);
    });

    it('should handle 404 error', async () => {
      const axiosInstance = mockCreate.mock.results[0].value;
      const error = {
        isAxiosError: true,
        response: {
          status: 404,
          data: { error: 'Project not found' },
        },
        message: 'Request failed with status code 404',
      };
      (mockedAxios.isAxiosError as unknown as jest.Mock) = jest.fn().mockReturnValue(true);
      axiosInstance.get.mockRejectedValue(error);

      await expect(client.getProject('nonexistent')).rejects.toThrow(HAOpsApiError);
    });
  });

  describe('Modules', () => {
    it('should create module', async () => {
      const mockProject = { id: 'project-uuid-1', slug: 'test-project', title: 'Test Project' };
      const mockModule = { id: '1', title: 'New Module' };
      const axiosInstance = mockCreate.mock.results[0].value;
      // createModule calls resolveProjectId → getProject first, then posts
      axiosInstance.get.mockResolvedValue({ data: mockProject });
      axiosInstance.post.mockResolvedValue({ data: mockModule });

      const data = { title: 'New Module', ownerId: 'user-1' };
      const result = await client.createModule('test-project', data);

      expect(axiosInstance.get).toHaveBeenCalledWith('/api/projects/test-project');
      expect(axiosInstance.post).toHaveBeenCalledWith('/api/modules', { ...data, projectId: 'project-uuid-1' });
      expect(result).toEqual(mockModule);
    });

    it('should update module and return the raw entity', async () => {
      const mockModule = { id: '1', title: 'Updated Module' };
      const axiosInstance = mockCreate.mock.results[0].value;
      axiosInstance.put.mockResolvedValue({ data: mockModule });

      const data = { title: 'Updated Module' };
      const result = await client.updateModule('module-1', data);

      expect(axiosInstance.put).toHaveBeenCalledWith('/api/modules/module-1', data);
      expect(result).toEqual(mockModule);
    });
  });

  // PUT /api/{modules,features,issues}/[id] returns the raw entity, not an
  // envelope. An earlier client commit assumed { success, message, entity }
  // and unwrapped .entity — that yielded `undefined` in MCP update_* tools.
  // These tests lock in the raw-entity contract.
  describe('PUT returns raw entity (no envelope)', () => {
    it('updateFeature returns response.data directly', async () => {
      const mockFeature = { id: 'f1', title: 'F', takenBy: 'agent-1' };
      const axiosInstance = mockCreate.mock.results[0].value;
      axiosInstance.put.mockResolvedValue({ data: mockFeature });

      const result = await client.updateFeature('f1', { title: 'F' });

      expect(axiosInstance.put).toHaveBeenCalledWith('/api/features/f1', { title: 'F' });
      expect(result).toEqual(mockFeature);
      // Regression guard: the wrongly-unwrapped version returned undefined.
      expect(result).toBeDefined();
      expect((result as { id?: string }).id).toBe('f1');
      expect((result as { takenBy?: string }).takenBy).toBe('agent-1');
    });

    it('updateIssue returns response.data directly', async () => {
      const mockIssue = { id: 'i1', title: 'I', takenBy: 'agent-2', status: 'in-progress' };
      const axiosInstance = mockCreate.mock.results[0].value;
      axiosInstance.put.mockResolvedValue({ data: mockIssue });

      const result = await client.updateIssue('i1', { status: 'in-progress' });

      expect(axiosInstance.put).toHaveBeenCalledWith('/api/issues/i1', {
        status: 'in-progress',
      });
      expect(result).toEqual(mockIssue);
      expect(result).toBeDefined();
      expect((result as { id?: string }).id).toBe('i1');
      expect((result as { takenBy?: string }).takenBy).toBe('agent-2');
    });

    it('updateModule returns response.data directly', async () => {
      const mockModule = { id: 'm1', title: 'M', takenBy: 'agent-3' };
      const axiosInstance = mockCreate.mock.results[0].value;
      axiosInstance.put.mockResolvedValue({ data: mockModule });

      const result = await client.updateModule('m1', { title: 'M' });

      expect(result).toEqual(mockModule);
      expect((result as { id?: string }).id).toBe('m1');
    });
  });

  // Coverage for the F1/F4 Agent Skills client method. The URL shape is
  // /api/skills/{name} with scope, projectSlug, and version flowing through
  // query parameters (the server route uses query disambiguation, not a
  // separate /api/projects/[slug]/skills/[name] mount).
  describe('readSkill', () => {
    it('should read a system-scope skill with no options', async () => {
      const mockSkill = { id: 's1', name: 'foo', scope: 'system', version: 1 };
      const axiosInstance = mockCreate.mock.results[0].value;
      axiosInstance.get.mockResolvedValue({ data: mockSkill });

      const result = await client.readSkill('foo');

      expect(axiosInstance.get).toHaveBeenCalledWith('/api/skills/foo');
      expect(result).toEqual(mockSkill);
    });

    it('should read a project-scope skill with scope + projectSlug query params', async () => {
      const mockSkill = { id: 's2', name: 'foo', scope: 'project', version: 1 };
      const axiosInstance = mockCreate.mock.results[0].value;
      axiosInstance.get.mockResolvedValue({ data: mockSkill });

      const result = await client.readSkill('foo', {
        scope: 'project',
        projectSlug: 'bar',
      });

      expect(axiosInstance.get).toHaveBeenCalledWith(
        '/api/skills/foo?scope=project&projectSlug=bar',
      );
      expect(result).toEqual(mockSkill);
    });

    it('should pin a specific version via ?version', async () => {
      const mockSkill = { id: 's3', name: 'foo', scope: 'system', version: 3 };
      const axiosInstance = mockCreate.mock.results[0].value;
      axiosInstance.get.mockResolvedValue({ data: mockSkill });

      const result = await client.readSkill('foo', { version: 3 });

      expect(axiosInstance.get).toHaveBeenCalledWith('/api/skills/foo?version=3');
      expect(result).toEqual(mockSkill);
    });

    it('should throw HAOpsApiError on 404', async () => {
      const axiosInstance = mockCreate.mock.results[0].value;
      const error = {
        isAxiosError: true,
        response: {
          status: 404,
          data: { error: 'Skill not found' },
        },
        message: 'Request failed with status code 404',
      };
      (mockedAxios.isAxiosError as unknown as jest.Mock) = jest
        .fn()
        .mockReturnValue(true);
      axiosInstance.get.mockRejectedValue(error);

      await expect(client.readSkill('nonexistent')).rejects.toThrow(HAOpsApiError);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Skill CRUD client methods (P1·I1).
  //
  // The MCP tools haops_create_skill / haops_update_skill / haops_deprecate_skill
  // are thin wrappers over these client methods, so locking the URL / method /
  // body shape here guards against regressions in the tools too.
  // ──────────────────────────────────────────────────────────────────────────
  describe('createSkill', () => {
    it('POSTs /api/skills with the full system-skill body', async () => {
      const mockSkill = {
        id: 's-uuid',
        name: 'foo-skill',
        scope: 'system',
        version: 1,
        isCurrent: true,
        category: 'review',
      };
      const axiosInstance = mockCreate.mock.results[0].value;
      axiosInstance.post.mockResolvedValue({ data: mockSkill });

      const result = await client.createSkill({
        scope: 'system',
        name: 'foo-skill',
        description: 'Test skill',
        content: '# Markdown body',
        category: 'review',
        applicableRoles: ['dev', 'qa'],
      });

      expect(axiosInstance.post).toHaveBeenCalledWith('/api/skills', {
        scope: 'system',
        name: 'foo-skill',
        description: 'Test skill',
        content: '# Markdown body',
        category: 'review',
        applicableRoles: ['dev', 'qa'],
      });
      expect(result).toEqual(mockSkill);
    });

    it('POSTs /api/skills with projectSlug for project-scope skills', async () => {
      const mockSkill = { id: 's-uuid', name: 'p-skill', scope: 'project', version: 1 };
      const axiosInstance = mockCreate.mock.results[0].value;
      axiosInstance.post.mockResolvedValue({ data: mockSkill });

      const result = await client.createSkill({
        scope: 'project',
        name: 'p-skill',
        description: 'd',
        content: 'c',
        category: 'planning',
        applicableRoles: ['*'],
        projectSlug: 'fdev',
      });

      expect(axiosInstance.post).toHaveBeenCalledWith('/api/skills', {
        scope: 'project',
        name: 'p-skill',
        description: 'd',
        content: 'c',
        category: 'planning',
        applicableRoles: ['*'],
        projectSlug: 'fdev',
      });
      expect(result).toEqual(mockSkill);
    });

    it('throws HAOpsApiError on 409 conflict', async () => {
      const axiosInstance = mockCreate.mock.results[0].value;
      const error = {
        isAxiosError: true,
        response: {
          status: 409,
          data: { error: "A skill named 'foo' already exists in this scope" },
        },
        message: 'Request failed with status code 409',
      };
      (mockedAxios.isAxiosError as unknown as jest.Mock) = jest
        .fn()
        .mockReturnValue(true);
      axiosInstance.post.mockRejectedValue(error);

      await expect(
        client.createSkill({
          scope: 'system',
          name: 'foo',
          description: 'd',
          content: 'c',
          category: 'review',
          applicableRoles: ['dev'],
        }),
      ).rejects.toThrow(HAOpsApiError);
    });

    it('throws HAOpsApiError on 404 (feature flag off)', async () => {
      const axiosInstance = mockCreate.mock.results[0].value;
      const error = {
        isAxiosError: true,
        response: { status: 404, data: { error: 'Not found' } },
        message: 'Request failed with status code 404',
      };
      (mockedAxios.isAxiosError as unknown as jest.Mock) = jest
        .fn()
        .mockReturnValue(true);
      axiosInstance.post.mockRejectedValue(error);

      // The MCP tool layer translates this to a user-friendly hint about the
      // ENABLE_COMPOSED_PROTOCOLS flag; at the client layer it remains a
      // generic HAOpsApiError with the raw 'Not found' message.
      await expect(
        client.createSkill({
          scope: 'system',
          name: 'foo',
          description: 'd',
          content: 'c',
          category: 'review',
          applicableRoles: ['dev'],
        }),
      ).rejects.toThrow(HAOpsApiError);
    });
  });

  describe('updateSkill', () => {
    it('PUTs /api/skills/{name} with no query when scope omitted', async () => {
      const mockSkill = { id: 's2', name: 'foo', scope: 'system', version: 2 };
      const axiosInstance = mockCreate.mock.results[0].value;
      axiosInstance.put.mockResolvedValue({ data: mockSkill });

      const result = await client.updateSkill('foo', {}, { description: 'updated' });

      expect(axiosInstance.put).toHaveBeenCalledWith('/api/skills/foo', {
        description: 'updated',
      });
      expect(result).toEqual(mockSkill);
    });

    it('PUTs with ?scope=project&projectSlug=fdev for project-scope skills', async () => {
      const mockSkill = { id: 's2', name: 'foo', scope: 'project', version: 2 };
      const axiosInstance = mockCreate.mock.results[0].value;
      axiosInstance.put.mockResolvedValue({ data: mockSkill });

      const result = await client.updateSkill(
        'foo',
        { scope: 'project', projectSlug: 'fdev' },
        { content: 'new body', category: 'testing' },
      );

      expect(axiosInstance.put).toHaveBeenCalledWith(
        '/api/skills/foo?scope=project&projectSlug=fdev',
        { content: 'new body', category: 'testing' },
      );
      expect(result).toEqual(mockSkill);
    });

    it('forwards isDeprecated=true through the body', async () => {
      const mockSkill = { id: 's3', name: 'foo', scope: 'system', version: 3, isDeprecated: true };
      const axiosInstance = mockCreate.mock.results[0].value;
      axiosInstance.put.mockResolvedValue({ data: mockSkill });

      const result = await client.updateSkill('foo', { scope: 'system' }, { isDeprecated: true });

      expect(axiosInstance.put).toHaveBeenCalledWith('/api/skills/foo?scope=system', {
        isDeprecated: true,
      });
      expect((result as { isDeprecated?: boolean }).isDeprecated).toBe(true);
    });

    it('returns the current row unchanged on a server-detected no-op (no version bump)', async () => {
      // Server returns the current row (same version) when nothing differs.
      // We don't bump or wrap the response — the consumer reads `version` to
      // decide noop vs publish.
      const currentRow = { id: 's-current', name: 'foo', scope: 'system', version: 7 };
      const axiosInstance = mockCreate.mock.results[0].value;
      axiosInstance.put.mockResolvedValue({ data: currentRow });

      const result = await client.updateSkill('foo', {}, { description: 'same' });

      expect(result).toEqual(currentRow);
      expect((result as { version?: number }).version).toBe(7);
    });

    it('throws HAOpsApiError on 404 (skill missing or flag off)', async () => {
      const axiosInstance = mockCreate.mock.results[0].value;
      const error = {
        isAxiosError: true,
        response: { status: 404, data: { error: 'Skill not found' } },
        message: 'Request failed with status code 404',
      };
      (mockedAxios.isAxiosError as unknown as jest.Mock) = jest
        .fn()
        .mockReturnValue(true);
      axiosInstance.put.mockRejectedValue(error);

      await expect(
        client.updateSkill('nope', {}, { description: 'x' }),
      ).rejects.toThrow(HAOpsApiError);
    });
  });

  describe('deprecateSkill', () => {
    it('DELETEs /api/skills/{name} with no query when scope omitted', async () => {
      const mockResponse = { message: 'Skill deleted', versionCount: 3 };
      const axiosInstance = mockCreate.mock.results[0].value;
      axiosInstance.delete.mockResolvedValue({ data: mockResponse });

      const result = await client.deprecateSkill('foo');

      expect(axiosInstance.delete).toHaveBeenCalledWith('/api/skills/foo');
      expect(result).toEqual(mockResponse);
    });

    it('DELETEs with ?scope=project&projectSlug=fdev for project-scope skills', async () => {
      const mockResponse = { message: 'Skill deleted', versionCount: 1 };
      const axiosInstance = mockCreate.mock.results[0].value;
      axiosInstance.delete.mockResolvedValue({ data: mockResponse });

      const result = await client.deprecateSkill('foo', {
        scope: 'project',
        projectSlug: 'fdev',
      });

      expect(axiosInstance.delete).toHaveBeenCalledWith(
        '/api/skills/foo?scope=project&projectSlug=fdev',
      );
      expect(result.versionCount).toBe(1);
    });

    it('passes scope=system query when explicitly given', async () => {
      const mockResponse = { message: 'Skill deleted', versionCount: 2 };
      const axiosInstance = mockCreate.mock.results[0].value;
      axiosInstance.delete.mockResolvedValue({ data: mockResponse });

      await client.deprecateSkill('foo', { scope: 'system' });

      expect(axiosInstance.delete).toHaveBeenCalledWith('/api/skills/foo?scope=system');
    });

    it('throws HAOpsApiError on 404', async () => {
      const axiosInstance = mockCreate.mock.results[0].value;
      const error = {
        isAxiosError: true,
        response: { status: 404, data: { error: 'Skill not found' } },
        message: 'Request failed with status code 404',
      };
      (mockedAxios.isAxiosError as unknown as jest.Mock) = jest
        .fn()
        .mockReturnValue(true);
      axiosInstance.delete.mockRejectedValue(error);

      await expect(client.deprecateSkill('nonexistent')).rejects.toThrow(HAOpsApiError);
    });
  });

  // Coverage for the P1·I2 role-template CRUD client methods. These wrap
  // /api/role-templates and /api/role-templates/[name]. The URL/body shape
  // must match `app/api/role-templates/route.ts` + `[name]/route.ts` exactly
  // — the server validates names (kebab-case), baseRole (BASE_ROLES enum),
  // baseBody (non-empty), and defaultSkills (array of {skillId, required}).
  describe('Role Template CRUD (F2)', () => {
    describe('createRoleTemplate', () => {
      it('should POST minimal required fields and return the created row', async () => {
        const mockTemplate = {
          id: 'rt-1',
          name: 'custom-architect',
          baseRole: 'architect',
          baseBody: '# Boot\n…',
          description: null,
          defaultSkills: [],
          version: 1,
          isCurrent: true,
          isSystem: false,
        };
        const axiosInstance = mockCreate.mock.results[0].value;
        axiosInstance.post.mockResolvedValue({ data: mockTemplate });

        const result = await client.createRoleTemplate({
          name: 'custom-architect',
          baseRole: 'architect',
          baseBody: '# Boot\n…',
        });

        expect(axiosInstance.post).toHaveBeenCalledWith('/api/role-templates', {
          name: 'custom-architect',
          baseRole: 'architect',
          baseBody: '# Boot\n…',
        });
        expect(result).toEqual(mockTemplate);
      });

      it('should forward description + defaultSkills when supplied', async () => {
        const mockTemplate = { id: 'rt-2', name: 'dev-mobile', version: 1 };
        const axiosInstance = mockCreate.mock.results[0].value;
        axiosInstance.post.mockResolvedValue({ data: mockTemplate });

        await client.createRoleTemplate({
          name: 'dev-mobile',
          baseRole: 'dev',
          baseBody: 'body',
          description: 'Mobile dev template',
          defaultSkills: [
            { skillId: '11111111-1111-1111-1111-111111111111', required: true },
            { skillId: '22222222-2222-2222-2222-222222222222', required: false },
          ],
        });

        expect(axiosInstance.post).toHaveBeenCalledWith('/api/role-templates', {
          name: 'dev-mobile',
          baseRole: 'dev',
          baseBody: 'body',
          description: 'Mobile dev template',
          defaultSkills: [
            { skillId: '11111111-1111-1111-1111-111111111111', required: true },
            { skillId: '22222222-2222-2222-2222-222222222222', required: false },
          ],
        });
      });

      it('should bubble HAOpsApiError on 409 conflict', async () => {
        const axiosInstance = mockCreate.mock.results[0].value;
        const error = {
          isAxiosError: true,
          response: {
            status: 409,
            data: { error: "A role template named 'dev' already exists" },
          },
          message: 'Request failed with status code 409',
        };
        (mockedAxios.isAxiosError as unknown as jest.Mock) = jest
          .fn()
          .mockReturnValue(true);
        axiosInstance.post.mockRejectedValue(error);

        await expect(
          client.createRoleTemplate({
            name: 'dev',
            baseRole: 'dev',
            baseBody: 'body',
          }),
        ).rejects.toThrow(HAOpsApiError);
      });

      it('should bubble HAOpsApiError on 404 (composed-protocols flag off)', async () => {
        const axiosInstance = mockCreate.mock.results[0].value;
        const error = {
          isAxiosError: true,
          response: { status: 404, data: { error: 'Not found' } },
          message: 'Request failed with status code 404',
        };
        (mockedAxios.isAxiosError as unknown as jest.Mock) = jest
          .fn()
          .mockReturnValue(true);
        axiosInstance.post.mockRejectedValue(error);

        await expect(
          client.createRoleTemplate({
            name: 'x',
            baseRole: 'dev',
            baseBody: 'b',
          }),
        ).rejects.toThrow(HAOpsApiError);
      });
    });

    describe('updateRoleTemplate', () => {
      it('should PUT only supplied fields and return the new row', async () => {
        const mockTemplate = {
          id: 'rt-3',
          name: 'dev',
          baseRole: 'dev',
          version: 2,
          isCurrent: true,
        };
        const axiosInstance = mockCreate.mock.results[0].value;
        axiosInstance.put.mockResolvedValue({ data: mockTemplate });

        const result = await client.updateRoleTemplate('dev', {
          baseBody: '# New body',
        });

        expect(axiosInstance.put).toHaveBeenCalledWith('/api/role-templates/dev', {
          baseBody: '# New body',
        });
        expect(result).toEqual(mockTemplate);
      });

      it('should forward an empty body for a no-op PUT (server returns current row unchanged)', async () => {
        const mockTemplate = { id: 'rt-4', name: 'dev', version: 1 };
        const axiosInstance = mockCreate.mock.results[0].value;
        axiosInstance.put.mockResolvedValue({ data: mockTemplate });

        const result = await client.updateRoleTemplate('dev', {});

        expect(axiosInstance.put).toHaveBeenCalledWith('/api/role-templates/dev', {});
        expect(result).toEqual(mockTemplate);
      });

      it('should encode the template name into the URL path', async () => {
        const axiosInstance = mockCreate.mock.results[0].value;
        axiosInstance.put.mockResolvedValue({ data: { id: 'rt-5', name: 'team alpha' } });

        await client.updateRoleTemplate('team alpha', { description: 'x' });

        expect(axiosInstance.put).toHaveBeenCalledWith(
          '/api/role-templates/team%20alpha',
          { description: 'x' },
        );
      });

      it('should forward description=null to clear the field', async () => {
        const axiosInstance = mockCreate.mock.results[0].value;
        axiosInstance.put.mockResolvedValue({ data: { id: 'rt-6', name: 'dev' } });

        await client.updateRoleTemplate('dev', { description: null });

        expect(axiosInstance.put).toHaveBeenCalledWith('/api/role-templates/dev', {
          description: null,
        });
      });

      it('should bubble HAOpsApiError on 404', async () => {
        const axiosInstance = mockCreate.mock.results[0].value;
        const error = {
          isAxiosError: true,
          response: { status: 404, data: { error: 'Role template not found' } },
          message: 'Request failed with status code 404',
        };
        (mockedAxios.isAxiosError as unknown as jest.Mock) = jest
          .fn()
          .mockReturnValue(true);
        axiosInstance.put.mockRejectedValue(error);

        await expect(
          client.updateRoleTemplate('nonexistent', { baseBody: 'x' }),
        ).rejects.toThrow(HAOpsApiError);
      });
    });

    describe('deprecateRoleTemplate', () => {
      it('should DELETE and return the cascade summary', async () => {
        const axiosInstance = mockCreate.mock.results[0].value;
        const responseBody = { message: 'Role template deleted', versionCount: 3 };
        axiosInstance.delete.mockResolvedValue({ data: responseBody });

        const result = await client.deprecateRoleTemplate('custom-dev');

        expect(axiosInstance.delete).toHaveBeenCalledWith('/api/role-templates/custom-dev');
        expect(result).toEqual(responseBody);
      });

      it('should encode the template name into the URL path', async () => {
        const axiosInstance = mockCreate.mock.results[0].value;
        axiosInstance.delete.mockResolvedValue({
          data: { message: 'Role template deleted', versionCount: 1 },
        });

        await client.deprecateRoleTemplate('team alpha');

        expect(axiosInstance.delete).toHaveBeenCalledWith(
          '/api/role-templates/team%20alpha',
        );
      });

      it('should bubble HAOpsApiError on 403 (system template)', async () => {
        const axiosInstance = mockCreate.mock.results[0].value;
        const error = {
          isAxiosError: true,
          response: {
            status: 403,
            data: { error: 'System role templates cannot be deleted' },
          },
          message: 'Request failed with status code 403',
        };
        (mockedAxios.isAxiosError as unknown as jest.Mock) = jest
          .fn()
          .mockReturnValue(true);
        axiosInstance.delete.mockRejectedValue(error);

        await expect(client.deprecateRoleTemplate('architect')).rejects.toThrow(
          HAOpsApiError,
        );
      });

      it('should bubble HAOpsApiError on 404', async () => {
        const axiosInstance = mockCreate.mock.results[0].value;
        const error = {
          isAxiosError: true,
          response: { status: 404, data: { error: 'Role template not found' } },
          message: 'Request failed with status code 404',
        };
        (mockedAxios.isAxiosError as unknown as jest.Mock) = jest
          .fn()
          .mockReturnValue(true);
        axiosInstance.delete.mockRejectedValue(error);

        await expect(client.deprecateRoleTemplate('nonexistent')).rejects.toThrow(
          HAOpsApiError,
        );
      });
    });
  });


  // ---------------------------------------------------------------------------
  // P1·I3 — Skill Pack CRUD (create / update / deprecate).
  //
  // All three are admin-only and gated by ENABLE_COMPOSED_PROTOCOLS on the
  // server side, so the only client-side guarantees are:
  //   (a) the right URL is hit with the right HTTP verb
  //   (b) the body is forwarded verbatim (no client-side reshape of fields)
  //   (c) the raw entity comes back unwrapped (no envelope unwrapping)
  //   (d) HAOpsApiError surfaces on non-2xx responses (so the index.ts
  //       dispatcher can translate 404 → "feature flag off")
  // ---------------------------------------------------------------------------
  describe('Skill Pack CRUD (F7 / P1·I3)', () => {
    it('createSkillPack POSTs to /api/skill-packs with the full body and returns the raw entity', async () => {
      const mockPack = {
        id: 'pack-1',
        name: 'helpdesk-mvp',
        description: 'MVP helpdesk bundle',
        category: 'helpdesk',
        skillIds: ['11111111-1111-1111-1111-111111111111'],
        isFeatured: false,
        isSystem: false,
      };
      const axiosInstance = mockCreate.mock.results[0].value;
      axiosInstance.post.mockResolvedValue({ data: mockPack });

      const body = {
        name: 'helpdesk-mvp',
        description: 'MVP helpdesk bundle',
        category: 'helpdesk',
        skillIds: ['11111111-1111-1111-1111-111111111111'],
      };
      const result = await client.createSkillPack(body);

      expect(axiosInstance.post).toHaveBeenCalledWith(
        '/api/skill-packs',
        body,
      );
      expect(result).toEqual(mockPack);
    });

    it('createSkillPack omits optional fields when not supplied (skillIds default to server)', async () => {
      const mockPack = { id: 'pack-2', name: 'minimal', skillIds: [] };
      const axiosInstance = mockCreate.mock.results[0].value;
      axiosInstance.post.mockResolvedValue({ data: mockPack });

      const body = {
        name: 'minimal',
        description: 'min',
        category: 'other',
      };
      await client.createSkillPack(body);

      // Client must forward the body verbatim — no implicit skillIds: [].
      // The server defaults skillIds to [] when omitted. This locks the
      // contract so an inadvertent reshape doesn't silently send `[]` when
      // the agent omitted the field.
      expect(axiosInstance.post).toHaveBeenCalledWith(
        '/api/skill-packs',
        body,
      );
    });

    it('createSkillPack surfaces HAOpsApiError on 404 (feature flag off)', async () => {
      const axiosInstance = mockCreate.mock.results[0].value;
      const error = {
        isAxiosError: true,
        response: { status: 404, data: { error: 'Not found' } },
        message: 'Request failed with status code 404',
      };
      (mockedAxios.isAxiosError as unknown as jest.Mock) = jest
        .fn()
        .mockReturnValue(true);
      axiosInstance.post.mockRejectedValue(error);

      await expect(
        client.createSkillPack({
          name: 'x',
          description: 'x',
          category: 'other',
        }),
      ).rejects.toThrow(HAOpsApiError);
    });

    it('updateSkillPack PUTs to /api/skill-packs/[name] and returns the raw entity', async () => {
      const mockPack = {
        id: 'pack-1',
        name: 'helpdesk-mvp',
        description: 'Updated',
        category: 'helpdesk',
        skillIds: ['22222222-2222-2222-2222-222222222222'],
        isFeatured: true,
      };
      const axiosInstance = mockCreate.mock.results[0].value;
      axiosInstance.put.mockResolvedValue({ data: mockPack });

      const body = {
        description: 'Updated',
        skillIds: ['22222222-2222-2222-2222-222222222222'],
        isFeatured: true,
      };
      const result = await client.updateSkillPack('helpdesk-mvp', body);

      expect(axiosInstance.put).toHaveBeenCalledWith(
        '/api/skill-packs/helpdesk-mvp',
        body,
      );
      expect(result).toEqual(mockPack);
    });

    it('updateSkillPack url-encodes special characters in the name', async () => {
      // The kebab-case validator on the server rejects most exotic names, but
      // the client must still encode safely so an attacker-supplied name
      // can't smuggle a path traversal. Mirrors encodeURIComponent usage in
      // readSkill / readRoleTemplate / deprecateSkillPack.
      const axiosInstance = mockCreate.mock.results[0].value;
      axiosInstance.put.mockResolvedValue({ data: {} });

      await client.updateSkillPack('weird/name with space', { description: 'd' });

      expect(axiosInstance.put).toHaveBeenCalledWith(
        '/api/skill-packs/weird%2Fname%20with%20space',
        { description: 'd' },
      );
    });

    it('updateSkillPack accepts an empty patch body (no-op PUT)', async () => {
      // Server treats a no-op PUT as a 200 with the current row + no audit
      // row. Client must forward {} verbatim — don't reject it locally.
      const axiosInstance = mockCreate.mock.results[0].value;
      axiosInstance.put.mockResolvedValue({ data: { name: 'x' } });

      await client.updateSkillPack('x', {});

      expect(axiosInstance.put).toHaveBeenCalledWith(
        '/api/skill-packs/x',
        {},
      );
    });

    it('deprecateSkillPack DELETEs /api/skill-packs/[name] and returns the message payload', async () => {
      const axiosInstance = mockCreate.mock.results[0].value;
      axiosInstance.delete.mockResolvedValue({
        data: { message: 'Skill pack deleted' },
      });

      const result = await client.deprecateSkillPack('helpdesk-mvp');

      expect(axiosInstance.delete).toHaveBeenCalledWith(
        '/api/skill-packs/helpdesk-mvp',
      );
      expect(result).toEqual({ message: 'Skill pack deleted' });
    });

    it('deprecateSkillPack surfaces HAOpsApiError on 403 (system pack)', async () => {
      const axiosInstance = mockCreate.mock.results[0].value;
      const error = {
        isAxiosError: true,
        response: {
          status: 403,
          data: { error: 'System skill packs cannot be deleted' },
        },
        message: 'Request failed with status code 403',
      };
      (mockedAxios.isAxiosError as unknown as jest.Mock) = jest
        .fn()
        .mockReturnValue(true);
      axiosInstance.delete.mockRejectedValue(error);

      await expect(client.deprecateSkillPack('helpdesk')).rejects.toThrow(
        HAOpsApiError,
      );
    });
  });

});
