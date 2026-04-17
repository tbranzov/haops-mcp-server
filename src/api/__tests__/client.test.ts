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

    it('should update module and unwrap {success,entity} envelope', async () => {
      const mockModule = { id: '1', title: 'Updated Module' };
      const axiosInstance = mockCreate.mock.results[0].value;
      axiosInstance.put.mockResolvedValue({
        data: { success: true, message: 'Module updated', entity: mockModule },
      });

      const data = { title: 'Updated Module' };
      const result = await client.updateModule('module-1', data);

      expect(axiosInstance.put).toHaveBeenCalledWith('/api/modules/module-1', data);
      expect(result).toEqual(mockModule);
    });
  });

  describe('Envelope unwrapping — PUT /api/{modules,features,issues}/[id]', () => {
    it('updateFeature should unwrap response.data.entity', async () => {
      const mockFeature = { id: 'f1', title: 'F', takenBy: 'agent-1' };
      const axiosInstance = mockCreate.mock.results[0].value;
      axiosInstance.put.mockResolvedValue({
        data: { success: true, message: 'Feature updated', entity: mockFeature },
      });

      const result = await client.updateFeature('f1', { title: 'F' });

      expect(axiosInstance.put).toHaveBeenCalledWith('/api/features/f1', { title: 'F' });
      expect(result).toEqual(mockFeature);
      // Regression guard: the old (buggy) code would return the raw envelope and
      // takenBy would be undefined on the result.
      expect((result as { takenBy?: string }).takenBy).toBe('agent-1');
    });

    it('updateIssue should unwrap response.data.entity', async () => {
      const mockIssue = { id: 'i1', title: 'I', takenBy: 'agent-2', status: 'in-progress' };
      const axiosInstance = mockCreate.mock.results[0].value;
      axiosInstance.put.mockResolvedValue({
        data: { success: true, message: 'Issue updated', entity: mockIssue },
      });

      const result = await client.updateIssue('i1', { status: 'in-progress' });

      expect(axiosInstance.put).toHaveBeenCalledWith('/api/issues/i1', {
        status: 'in-progress',
      });
      expect(result).toEqual(mockIssue);
      expect((result as { takenBy?: string }).takenBy).toBe('agent-2');
    });
  });
});
