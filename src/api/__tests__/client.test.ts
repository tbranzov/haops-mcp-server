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
