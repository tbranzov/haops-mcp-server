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
});
