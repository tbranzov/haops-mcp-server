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

  // ---------------------------------------------------------------------------
  // P2·I8 — Lifecycle transition wrappers.
  //
  // The three transition methods (transitionSkill / transitionRoleTemplate /
  // transitionSkillPack) wrap POST /api/{resource}/[name]/[action] with an
  // empty `{}` body. The client-side guarantees we lock in here:
  //   (a) URL is /api/{resource}/{encodedName}/{action} with action plugged in
  //       verbatim (we trust the LifecycleTransitionAction type at the call
  //       site — no client-side action whitelisting)
  //   (b) body is exactly `{}` (the route ignores anything else; sending the
  //       echo'd args by mistake would be a spec violation)
  //   (c) scope/projectSlug compose the query string for skills only
  //   (d) name is URL-encoded so path-traversal can't smuggle in
  //   (e) HAOpsApiError bubbles for 404 / 409 so the dispatcher in
  //       src/index.ts can format the invalid_transition payload
  // ---------------------------------------------------------------------------
  describe('Lifecycle transitions (P2·I8)', () => {
    describe('transitionSkill', () => {
      it('POSTs to /api/skills/[name]/propose with empty body and no query when scope omitted query', async () => {
        // scope is supplied (required by signature) but defaults to system —
        // verify it ends up in the query string explicitly so server-side
        // routing has no ambiguity.
        const mockSkill = { id: 's1', name: 'foo', lifecycleState: 'proposed', version: 1 };
        const axiosInstance = mockCreate.mock.results[0].value;
        axiosInstance.post.mockResolvedValue({ data: mockSkill });

        const result = await client.transitionSkill({
          name: 'foo',
          scope: 'system',
          action: 'propose',
        });

        expect(axiosInstance.post).toHaveBeenCalledWith(
          '/api/skills/foo/propose?scope=system',
          {},
        );
        expect(result).toEqual(mockSkill);
      });

      it('POSTs publish action with scope=project and projectSlug in query', async () => {
        const mockSkill = { id: 's2', name: 'bar', lifecycleState: 'published', version: 2 };
        const axiosInstance = mockCreate.mock.results[0].value;
        axiosInstance.post.mockResolvedValue({ data: mockSkill });

        const result = await client.transitionSkill({
          name: 'bar',
          scope: 'project',
          action: 'publish',
          projectSlug: 'fdev',
        });

        expect(axiosInstance.post).toHaveBeenCalledWith(
          '/api/skills/bar/publish?scope=project&projectSlug=fdev',
          {},
        );
        expect(result).toEqual(mockSkill);
      });

      it('URL-encodes the skill name to block path traversal', async () => {
        const axiosInstance = mockCreate.mock.results[0].value;
        axiosInstance.post.mockResolvedValue({ data: {} });

        await client.transitionSkill({
          name: 'weird/name with space',
          scope: 'system',
          action: 'deprecate',
        });

        expect(axiosInstance.post).toHaveBeenCalledWith(
          '/api/skills/weird%2Fname%20with%20space/deprecate?scope=system',
          {},
        );
      });

      it('surfaces HAOpsApiError on 409 invalid_transition with the body attached for formatting', async () => {
        // The dispatcher in src/index.ts (formatTransitionError) reads
        // statusCode AND the response body's `from`/`to`/`allowed` fields
        // to render the prescriptive hint. Lock the body-passthrough here.
        const axiosInstance = mockCreate.mock.results[0].value;
        const error = {
          isAxiosError: true,
          response: {
            status: 409,
            data: {
              error: 'invalid_transition',
              from: 'published',
              to: 'proposed',
              allowed: ['deprecated'],
            },
          },
          message: 'Request failed with status code 409',
        };
        (mockedAxios.isAxiosError as unknown as jest.Mock) = jest
          .fn()
          .mockReturnValue(true);
        axiosInstance.post.mockRejectedValue(error);

        await expect(
          client.transitionSkill({ name: 'foo', scope: 'system', action: 'propose' }),
        ).rejects.toMatchObject({
          name: 'HAOpsApiError',
          statusCode: 409,
          message: 'invalid_transition',
          response: {
            error: 'invalid_transition',
            from: 'published',
            to: 'proposed',
            allowed: ['deprecated'],
          },
        });
      });

      it('surfaces HAOpsApiError on 404 (feature flag off)', async () => {
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
          client.transitionSkill({ name: 'foo', scope: 'system', action: 'publish' }),
        ).rejects.toThrow(HAOpsApiError);
      });
    });

    describe('transitionRoleTemplate', () => {
      it('POSTs to /api/role-templates/[name]/propose with empty body', async () => {
        const mockTemplate = {
          id: 'rt-1',
          name: 'custom-dev',
          lifecycleState: 'proposed',
          version: 1,
          isSystem: false,
        };
        const axiosInstance = mockCreate.mock.results[0].value;
        axiosInstance.post.mockResolvedValue({ data: mockTemplate });

        const result = await client.transitionRoleTemplate({
          name: 'custom-dev',
          action: 'propose',
        });

        expect(axiosInstance.post).toHaveBeenCalledWith(
          '/api/role-templates/custom-dev/propose',
          {},
        );
        expect(result).toEqual(mockTemplate);
      });

      it('POSTs publish without query params (templates are system-wide, no scope axis)', async () => {
        const axiosInstance = mockCreate.mock.results[0].value;
        axiosInstance.post.mockResolvedValue({ data: { id: 'rt-2', lifecycleState: 'published' } });

        await client.transitionRoleTemplate({ name: 'dev', action: 'publish' });

        expect(axiosInstance.post).toHaveBeenCalledWith(
          '/api/role-templates/dev/publish',
          {},
        );
      });

      it('URL-encodes the template name', async () => {
        const axiosInstance = mockCreate.mock.results[0].value;
        axiosInstance.post.mockResolvedValue({ data: {} });

        await client.transitionRoleTemplate({ name: 'team alpha', action: 'deprecate' });

        expect(axiosInstance.post).toHaveBeenCalledWith(
          '/api/role-templates/team%20alpha/deprecate',
          {},
        );
      });

      it('surfaces HAOpsApiError on 409 with the invalid_transition body for dispatcher formatting', async () => {
        const axiosInstance = mockCreate.mock.results[0].value;
        const error = {
          isAxiosError: true,
          response: {
            status: 409,
            data: {
              error: 'invalid_transition',
              from: 'draft',
              to: 'deprecate',
              allowed: ['propose'],
            },
          },
          message: 'Request failed with status code 409',
        };
        (mockedAxios.isAxiosError as unknown as jest.Mock) = jest
          .fn()
          .mockReturnValue(true);
        axiosInstance.post.mockRejectedValue(error);

        await expect(
          client.transitionRoleTemplate({ name: 'dev', action: 'deprecate' }),
        ).rejects.toMatchObject({
          statusCode: 409,
          message: 'invalid_transition',
          response: { from: 'draft', allowed: ['propose'] },
        });
      });
    });

    describe('transitionSkillPack', () => {
      it('POSTs to /api/skill-packs/[name]/propose with empty body', async () => {
        const mockPack = {
          id: 'pack-1',
          name: 'helpdesk-mvp',
          lifecycleState: 'proposed',
          category: 'helpdesk',
          skillIds: ['11111111-1111-1111-1111-111111111111'],
          isSystem: false,
        };
        const axiosInstance = mockCreate.mock.results[0].value;
        axiosInstance.post.mockResolvedValue({ data: mockPack });

        const result = await client.transitionSkillPack({
          name: 'helpdesk-mvp',
          action: 'propose',
        });

        expect(axiosInstance.post).toHaveBeenCalledWith(
          '/api/skill-packs/helpdesk-mvp/propose',
          {},
        );
        expect(result).toEqual(mockPack);
      });

      it('POSTs publish for a skill pack (no scope axis, no query string)', async () => {
        const axiosInstance = mockCreate.mock.results[0].value;
        axiosInstance.post.mockResolvedValue({ data: { id: 'pack-2', lifecycleState: 'published' } });

        await client.transitionSkillPack({ name: 'security-mvp', action: 'publish' });

        expect(axiosInstance.post).toHaveBeenCalledWith(
          '/api/skill-packs/security-mvp/publish',
          {},
        );
      });

      it('URL-encodes the pack name', async () => {
        const axiosInstance = mockCreate.mock.results[0].value;
        axiosInstance.post.mockResolvedValue({ data: {} });

        await client.transitionSkillPack({ name: 'odd/name', action: 'deprecate' });

        expect(axiosInstance.post).toHaveBeenCalledWith(
          '/api/skill-packs/odd%2Fname/deprecate',
          {},
        );
      });

      it('surfaces HAOpsApiError on 403 (system pack can not be deprecated)', async () => {
        const axiosInstance = mockCreate.mock.results[0].value;
        const error = {
          isAxiosError: true,
          response: {
            status: 403,
            data: { error: 'System skill packs cannot be deprecated' },
          },
          message: 'Request failed with status code 403',
        };
        (mockedAxios.isAxiosError as unknown as jest.Mock) = jest
          .fn()
          .mockReturnValue(true);
        axiosInstance.post.mockRejectedValue(error);

        await expect(
          client.transitionSkillPack({ name: 'helpdesk', action: 'deprecate' }),
        ).rejects.toThrow(HAOpsApiError);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // P·A·I1 — updateProtocol partial-body support.
  //
  // The server already supports carry-forward for every field in the protocol
  // PUT route. The client-side change makes `content` optional and stops
  // unconditionally placing it in the body, enabling agents to call with only
  // `templateId` (to rebind a role template) or only `skillsConfig` (to toggle
  // skills) without re-sending the full markdown body.
  // ---------------------------------------------------------------------------
  describe('updateProtocol partial-body (P·A·I1)', () => {
    it('PUTs with { templateId } only — body must NOT contain a content field', async () => {
      const mockResult = { id: 'proto-1', role: 'dev', version: 2, templateId: 'tmpl-uuid-xxx' };
      const axiosInstance = mockCreate.mock.results[0].value;
      axiosInstance.put.mockResolvedValue({ data: mockResult });

      const result = await client.updateProtocol(
        'fdev',
        'dev',
        undefined,       // content omitted
        undefined,       // changeSummary omitted
        'tmpl-uuid-xxx', // templateId provided
        undefined,       // skillsConfig omitted
      );

      const putCall = axiosInstance.put.mock.calls[0];
      const body = putCall[1] as Record<string, unknown>;
      // content must NOT appear in the PUT body when not supplied
      expect(body).not.toHaveProperty('content');
      // templateId must be forwarded
      expect(body.templateId).toBe('tmpl-uuid-xxx');
      // role must always be present
      expect(body.role).toBe('dev');
      expect(result).toEqual(mockResult);
    });

    it('PUTs with { skillsConfig } only — body must NOT contain a content field', async () => {
      const skillsConfig = { enabledSkillIds: ['skill-uuid-aaa', 'skill-uuid-bbb'] };
      const mockResult = { id: 'proto-2', role: 'qa', version: 3 };
      const axiosInstance = mockCreate.mock.results[0].value;
      axiosInstance.put.mockResolvedValue({ data: mockResult });

      await client.updateProtocol(
        'fdev',
        'qa',
        undefined,    // content omitted
        undefined,    // changeSummary omitted
        undefined,    // templateId omitted
        skillsConfig, // skillsConfig provided
      );

      const putCall = axiosInstance.put.mock.calls[0];
      const body = putCall[1] as Record<string, unknown>;
      expect(body).not.toHaveProperty('content');
      expect(body.skillsConfig).toEqual(skillsConfig);
      expect(body.role).toBe('qa');
    });

    it('PUTs with { content, changeSummary } — backward-compatible (existing usage)', async () => {
      const mockResult = { id: 'proto-3', role: 'architect', version: 5 };
      const axiosInstance = mockCreate.mock.results[0].value;
      axiosInstance.put.mockResolvedValue({ data: mockResult });

      await client.updateProtocol(
        'fdev',
        'architect',
        '# Boot section\nThis is the full protocol.',
        'Added new skill section',
        undefined,
        undefined,
      );

      const putCall = axiosInstance.put.mock.calls[0];
      const body = putCall[1] as Record<string, unknown>;
      expect(body.content).toBe('# Boot section\nThis is the full protocol.');
      expect(body.changeSummary).toBe('Added new skill section');
      expect(body.role).toBe('architect');
      // templateId + skillsConfig must NOT appear when not supplied
      expect(body).not.toHaveProperty('templateId');
      expect(body).not.toHaveProperty('skillsConfig');
    });
  });

  // ---------------------------------------------------------------------------
  // P·A·I3 — getProtocolHealth client method.
  //
  // Wraps GET /api/projects/[slug]/protocol/health?includeSnapshots=<bool>.
  // Guarantees:
  //   (a) URL is /api/projects/{slug}/protocol/health — no extra path segments
  //   (b) includeSnapshots=true is forwarded as a query param; false/omitted = no param
  //   (c) response.data is returned unwrapped (no envelope)
  //   (d) 404 → user-friendly HAOpsApiError about feature flag or project missing
  //   (e) Other non-2xx → raw HAOpsApiError from handleError()
  // ---------------------------------------------------------------------------
  describe('getProtocolHealth (P·A·I3)', () => {
    /** Minimal 4-role fixture — all ok, no drift */
    const makeHealthFixture = (overrides: Record<string, unknown> = {}) => ({
      roles: {
        architect: { warnings: [], skillCount: 27, missingCount: 0, deprecatedCount: 0, bytes: 4096, isLegacy: false },
        dev:       { warnings: [], skillCount: 22, missingCount: 0, deprecatedCount: 0, bytes: 1435, isLegacy: false },
        qa:        { warnings: [], skillCount: 17, missingCount: 0, deprecatedCount: 0, bytes: 1536, isLegacy: false },
        devops:    { warnings: [], skillCount: 22, missingCount: 0, deprecatedCount: 0, bytes: 2253, isLegacy: false },
      },
      summary: { totalWarnings: 0, totalMissing: 0, totalDeprecated: 0, status: 'ok' },
      packHealth: { totalPacksScanned: 3, warnings: [] },
      previousSnapshot: null,
      ...overrides,
    });

    it('GETs /api/projects/{slug}/protocol/health with no query when includeSnapshots is omitted', async () => {
      const fixture = makeHealthFixture();
      const axiosInstance = mockCreate.mock.results[0].value;
      axiosInstance.get.mockResolvedValue({ data: fixture });

      const result = await client.getProtocolHealth('fdev');

      expect(axiosInstance.get).toHaveBeenCalledWith('/api/projects/fdev/protocol/health');
      expect(result).toEqual(fixture);
    });

    it('appends ?includeSnapshots=true when the option is set', async () => {
      const fixture = makeHealthFixture({
        previousSnapshot: {
          scannedAt: '2026-06-15T10:00:00.000Z',
          roles: { architect: { warnings: [], skillCount: 26, missingCount: 0, deprecatedCount: 0, bytes: 4000, isLegacy: false } },
        },
      });
      const axiosInstance = mockCreate.mock.results[0].value;
      axiosInstance.get.mockResolvedValue({ data: fixture });

      const result = await client.getProtocolHealth('fdev', { includeSnapshots: true });

      expect(axiosInstance.get).toHaveBeenCalledWith(
        '/api/projects/fdev/protocol/health?includeSnapshots=true',
      );
      expect(result.previousSnapshot).not.toBeNull();
    });

    it('returns the response containing all 4 role names', async () => {
      const fixture = makeHealthFixture();
      const axiosInstance = mockCreate.mock.results[0].value;
      axiosInstance.get.mockResolvedValue({ data: fixture });

      const result = await client.getProtocolHealth('fdev');

      expect(result.roles).toHaveProperty('architect');
      expect(result.roles).toHaveProperty('dev');
      expect(result.roles).toHaveProperty('qa');
      expect(result.roles).toHaveProperty('devops');
    });

    it('returns role data with missingCount > 0 when a role has drift', async () => {
      const fixture = makeHealthFixture({
        roles: {
          architect: {
            warnings: ['missing: aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'],
            skillCount: 27,
            missingCount: 1,
            deprecatedCount: 0,
            bytes: 4096,
            isLegacy: false,
          },
          dev:    { warnings: [], skillCount: 22, missingCount: 0, deprecatedCount: 0, bytes: 1435, isLegacy: false },
          qa:     { warnings: [], skillCount: 17, missingCount: 0, deprecatedCount: 0, bytes: 1536, isLegacy: false },
          devops: { warnings: [], skillCount: 22, missingCount: 0, deprecatedCount: 0, bytes: 2253, isLegacy: false },
        },
        summary: { totalWarnings: 1, totalMissing: 1, totalDeprecated: 0, status: 'error' },
      });
      const axiosInstance = mockCreate.mock.results[0].value;
      axiosInstance.get.mockResolvedValue({ data: fixture });

      const result = await client.getProtocolHealth('fdev');

      expect(result.roles.architect.missingCount).toBe(1);
      expect(result.summary.status).toBe('error');
      expect(result.summary.totalMissing).toBe(1);
    });

    it('throws a user-friendly HAOpsApiError on 404 (feature flag off pattern)', async () => {
      const axiosInstance = mockCreate.mock.results[0].value;
      const error = {
        isAxiosError: true,
        response: {
          status: 404,
          data: { error: 'Composed protocols are not enabled' },
        },
        message: 'Request failed with status code 404',
      };
      (mockedAxios.isAxiosError as unknown as jest.Mock) = jest.fn().mockReturnValue(true);
      axiosInstance.get.mockRejectedValue(error);

      await expect(client.getProtocolHealth('fdev')).rejects.toMatchObject({
        name: 'HAOpsApiError',
        statusCode: 404,
        message: expect.stringContaining('Composed protocols feature may be disabled'),
      });
    });

    it('throws HAOpsApiError on 404 for a non-existent project slug', async () => {
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

      await expect(client.getProtocolHealth('nonexistent-slug')).rejects.toMatchObject({
        name: 'HAOpsApiError',
        statusCode: 404,
      });
    });

    it('bubbles HAOpsApiError on 403 (forbidden)', async () => {
      const axiosInstance = mockCreate.mock.results[0].value;
      const error = {
        isAxiosError: true,
        response: {
          status: 403,
          data: { error: 'Forbidden' },
        },
        message: 'Request failed with status code 403',
      };
      (mockedAxios.isAxiosError as unknown as jest.Mock) = jest.fn().mockReturnValue(true);
      axiosInstance.get.mockRejectedValue(error);

      await expect(client.getProtocolHealth('fdev')).rejects.toThrow(HAOpsApiError);
    });
  });

  // ===== Cascade Preview Tests (P·A·I4) =====

  describe('Cascade Preview (P·A·I4)', () => {
    // Shared fixture — a representative cascade preview response with all
    // three consumer types populated.
    const cascadePreviewFixture = {
      count: 4,
      templates: [
        { templateId: 'tpl-uuid-1', templateName: 'dev', required: true },
        { templateId: 'tpl-uuid-2', templateName: 'qa', required: false },
      ],
      protocolsBySkill: [
        {
          protocolId: 'proto-uuid-1',
          projectId: 'proj-uuid-1',
          role: 'architect',
          version: 3,
        },
      ],
      protocolsByTemplate: [],
      packs: [
        { packId: 'pack-uuid-1', packName: 'helpdesk-mvp' },
      ],
      warnings: [
        "WARNING: skill is REQUIRED in template 'dev' (tpl-uuid-1). Without ?cascade=true the template will reference a stale (non-current) skill UUID.",
      ],
    };

    describe('previewSkillCascade', () => {
      it('GETs /api/skills/[name]/cascade-preview with scope=system', async () => {
        const mockResponse = {
          skillId: 'skill-uuid-1',
          skillName: 'code-review',
          cascadePreview: cascadePreviewFixture,
        };
        const axiosInstance = mockCreate.mock.results[0].value;
        axiosInstance.get.mockResolvedValue({ data: mockResponse });

        const result = await client.previewSkillCascade('code-review', 'system');

        expect(axiosInstance.get).toHaveBeenCalledWith(
          '/api/skills/code-review/cascade-preview?scope=system',
        );
        expect(result).toEqual(mockResponse);
      });

      it('includes projectSlug when scope=project', async () => {
        const mockResponse = {
          skillId: 'skill-uuid-2',
          skillName: 'project-deploy',
          cascadePreview: { count: 0, templates: [], protocolsBySkill: [], protocolsByTemplate: [], packs: [], warnings: [] },
        };
        const axiosInstance = mockCreate.mock.results[0].value;
        axiosInstance.get.mockResolvedValue({ data: mockResponse });

        await client.previewSkillCascade('project-deploy', 'project', 'my-project');

        expect(axiosInstance.get).toHaveBeenCalledWith(
          '/api/skills/project-deploy/cascade-preview?scope=project&projectSlug=my-project',
        );
      });

      it('URL-encodes the skill name', async () => {
        const axiosInstance = mockCreate.mock.results[0].value;
        axiosInstance.get.mockResolvedValue({ data: { skillId: 'x', skillName: 'odd/name', cascadePreview: { count: 0, templates: [], protocolsBySkill: [], protocolsByTemplate: [], packs: [], warnings: [] } } });

        await client.previewSkillCascade('odd/name', 'system');

        expect(axiosInstance.get).toHaveBeenCalledWith(
          '/api/skills/odd%2Fname/cascade-preview?scope=system',
        );
      });

      it('surfaces HAOpsApiError on 404 (skill not found)', async () => {
        const axiosInstance = mockCreate.mock.results[0].value;
        const error = {
          isAxiosError: true,
          response: { status: 404, data: { error: 'Skill not found' } },
          message: 'Request failed with status code 404',
        };
        (mockedAxios.isAxiosError as unknown as jest.Mock) = jest.fn().mockReturnValue(true);
        axiosInstance.get.mockRejectedValue(error);

        await expect(
          client.previewSkillCascade('nonexistent', 'system'),
        ).rejects.toThrow(HAOpsApiError);
      });
    });

    describe('previewRoleTemplateCascade', () => {
      const templateCascadeFixture = {
        count: 2,
        templates: [],
        protocolsBySkill: [],
        protocolsByTemplate: [
          { protocolId: 'proto-uuid-1', projectId: 'proj-uuid-1', role: 'dev', version: 5, stale: true },
          { protocolId: 'proto-uuid-2', projectId: 'proj-uuid-2', role: 'architect', version: 3, stale: true },
        ],
        packs: [],
        warnings: [],
      };

      it('GETs /api/role-templates/[name]/cascade-preview', async () => {
        const mockResponse = {
          templateId: 'tpl-uuid-1',
          templateName: 'dev',
          cascadePreview: templateCascadeFixture,
        };
        const axiosInstance = mockCreate.mock.results[0].value;
        axiosInstance.get.mockResolvedValue({ data: mockResponse });

        const result = await client.previewRoleTemplateCascade('dev');

        expect(axiosInstance.get).toHaveBeenCalledWith(
          '/api/role-templates/dev/cascade-preview',
        );
        expect(result).toEqual(mockResponse);
      });

      it('URL-encodes the template name', async () => {
        const axiosInstance = mockCreate.mock.results[0].value;
        axiosInstance.get.mockResolvedValue({ data: { templateId: 'x', templateName: 'odd/name', cascadePreview: { count: 0, templates: [], protocolsBySkill: [], protocolsByTemplate: [], packs: [], warnings: [] } } });

        await client.previewRoleTemplateCascade('odd/name');

        expect(axiosInstance.get).toHaveBeenCalledWith(
          '/api/role-templates/odd%2Fname/cascade-preview',
        );
      });

      it('surfaces HAOpsApiError on 404 (template not found)', async () => {
        const axiosInstance = mockCreate.mock.results[0].value;
        const error = {
          isAxiosError: true,
          response: { status: 404, data: { error: 'Role template not found' } },
          message: 'Request failed with status code 404',
        };
        (mockedAxios.isAxiosError as unknown as jest.Mock) = jest.fn().mockReturnValue(true);
        axiosInstance.get.mockRejectedValue(error);

        await expect(
          client.previewRoleTemplateCascade('nonexistent'),
        ).rejects.toThrow(HAOpsApiError);
      });
    });

    describe('updateSkill with cascade flag', () => {
      it('PUT includes ?cascade=true when cascade=true', async () => {
        const mockSkill = { id: 'skill-uuid-1', name: 'code-review', version: 2, scope: 'system' };
        const axiosInstance = mockCreate.mock.results[0].value;
        axiosInstance.put.mockResolvedValue({ data: mockSkill });

        await client.updateSkill(
          'code-review',
          { scope: 'system', cascade: true },
          { content: 'updated content' },
        );

        expect(axiosInstance.put).toHaveBeenCalledWith(
          '/api/skills/code-review?scope=system&cascade=true',
          { content: 'updated content' },
        );
      });

      it('PUT without cascade flag does NOT append ?cascade=true', async () => {
        const mockSkill = { id: 'skill-uuid-1', name: 'code-review', version: 2, scope: 'system' };
        const axiosInstance = mockCreate.mock.results[0].value;
        axiosInstance.put.mockResolvedValue({ data: mockSkill });

        await client.updateSkill(
          'code-review',
          { scope: 'system' },
          { content: 'updated content' },
        );

        // URL should not contain cascade
        const callArg = axiosInstance.put.mock.calls[0][0] as string;
        expect(callArg).not.toContain('cascade');
      });

      it('PUT with cascade=false does NOT append ?cascade=true', async () => {
        const mockSkill = { id: 'skill-uuid-1', name: 'code-review', version: 2, scope: 'system' };
        const axiosInstance = mockCreate.mock.results[0].value;
        axiosInstance.put.mockResolvedValue({ data: mockSkill });

        await client.updateSkill(
          'code-review',
          { scope: 'system', cascade: false },
          { content: 'updated content' },
        );

        const callArg = axiosInstance.put.mock.calls[0][0] as string;
        expect(callArg).not.toContain('cascade');
      });
    });

    describe('updateRoleTemplate with cascade flag', () => {
      it('PUT includes ?cascade=true when cascade=true', async () => {
        const mockTemplate = { id: 'tpl-uuid-1', name: 'dev', version: 3 };
        const axiosInstance = mockCreate.mock.results[0].value;
        axiosInstance.put.mockResolvedValue({ data: mockTemplate });

        await client.updateRoleTemplate(
          'dev',
          { baseBody: 'updated body' },
          { cascade: true },
        );

        expect(axiosInstance.put).toHaveBeenCalledWith(
          '/api/role-templates/dev?cascade=true',
          { baseBody: 'updated body' },
        );
      });

      it('PUT without cascade opts does NOT append ?cascade=true', async () => {
        const mockTemplate = { id: 'tpl-uuid-1', name: 'dev', version: 3 };
        const axiosInstance = mockCreate.mock.results[0].value;
        axiosInstance.put.mockResolvedValue({ data: mockTemplate });

        await client.updateRoleTemplate('dev', { baseBody: 'updated body' });

        expect(axiosInstance.put).toHaveBeenCalledWith(
          '/api/role-templates/dev',
          { baseBody: 'updated body' },
        );
      });

      it('PUT with cascade=false does NOT append query param', async () => {
        const mockTemplate = { id: 'tpl-uuid-1', name: 'dev', version: 3 };
        const axiosInstance = mockCreate.mock.results[0].value;
        axiosInstance.put.mockResolvedValue({ data: mockTemplate });

        await client.updateRoleTemplate(
          'dev',
          { baseBody: 'updated body' },
          { cascade: false },
        );

        const callArg = axiosInstance.put.mock.calls[0][0] as string;
        expect(callArg).not.toContain('cascade');
      });
    });
  });

});
