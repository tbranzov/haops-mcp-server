import axios, { AxiosInstance, AxiosError } from 'axios';
import type {
  Project,
  Module,
  Feature,
  Issue,
  Channel,
  Discussion,
  DiscussionMessage,
  DirectMessage,
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
  ProjectMember,
  ProjectMemberRole,
  AgentMemory,
  MemoryLogEntry,
  MemoryEntityType,
  MemoryTag,
} from '../types/entities.js';

interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

/**
 * HAOps POST /api/{module|feature|issue}/[id]/claim envelope.
 * Claim routes return { claimed: true, <entityKey>: T } where entityKey is
 * "module" | "feature" | "issue". See haops commit 3628dddd.
 *
 * Note: PUT /api/{modules|features|issues}/[id] does NOT use an envelope —
 * it returns the raw entity (see e.g. app/api/features/[id]/route.ts line 198
 * `return NextResponse.json(feature)` on commit 5d263eb). An earlier client
 * commit wrongly assumed an envelope and unwrapped `.entity`, which yielded
 * undefined for the `feature`/`module`/`issue` response in MCP update_* tools.
 */
type ClaimResponse<K extends string, T> = {
  claimed: boolean;
  message?: string;
} & { [P in K]: T };

export interface ListFilters {
  status?: string;
  priority?: string;
  limit?: number;
  offset?: number;
}

export interface ModuleFilters extends ListFilters {
  ownerId?: string;
}

export interface IssueFilters extends ListFilters {
  assignedTo?: string;
  type?: string;
}

export class HAOpsApiError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public response?: unknown
  ) {
    super(message);
    this.name = 'HAOpsApiError';
  }
}

export class HAOpsApiClient {
  private axios: AxiosInstance;
  private projectIdCache = new Map<string, string>();

  constructor(baseURL: string, apiKey: string) {
    this.axios = axios.create({
      baseURL,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    });
  }

  private handleError(error: unknown): never {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError<{ error?: string }>;
      const message = axiosError.response?.data?.error || axiosError.message;
      const statusCode = axiosError.response?.status;
      throw new HAOpsApiError(message, statusCode, axiosError.response?.data);
    }
    throw error;
  }

  // Generic HTTP request method for new endpoints
  async request(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, data?: Record<string, unknown>): Promise<unknown> {
    try {
      const response = await this.axios.request({ method, url, data });
      return response.data;
    } catch (error) {
      this.handleError(error);
    }
  }

  // Generic binary request (for endpoints that return files/ZIPs)
  async requestBinary(method: 'GET' | 'POST', url: string, data?: Record<string, unknown>): Promise<Buffer> {
    try {
      const response = await this.axios.request({ method, url, data, responseType: 'arraybuffer' });
      return Buffer.from(response.data);
    } catch (error) {
      this.handleError(error);
    }
  }

  // Generic text request (for export endpoints that return plain text/markdown)
  async requestText(method: 'GET' | 'POST', url: string): Promise<string> {
    try {
      const response = await this.axios.request({ method, url, responseType: 'text' });
      return typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
    } catch (error) {
      this.handleError(error);
      return '';
    }
  }

  // Generic FormData request (for file uploads — base64 → multipart/form-data)
  async requestFormData(url: string, filename: string, imageBase64: string, mimeType: string): Promise<unknown> {
    try {
      const FormData = (await import('form-data')).default;
      const buffer = Buffer.from(imageBase64, 'base64');
      const form = new FormData();
      form.append('file', buffer, { filename, contentType: mimeType });
      const response = await this.axios.post(url, form, {
        headers: { ...form.getHeaders() },
      });
      return response.data;
    } catch (error) {
      this.handleError(error);
    }
  }

  // Slug → UUID resolver (cached)
  async resolveProjectId(slug: string): Promise<string> {
    if (this.projectIdCache.has(slug)) {
      return this.projectIdCache.get(slug)!;
    }
    const project = await this.getProject(slug);
    this.projectIdCache.set(slug, project.id);
    return project.id;
  }

  // Projects
  async listProjects(): Promise<Project[]> {
    try {
      const response = await this.axios.get<Project[]>('/api/projects');
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async getProject(slug: string): Promise<Project> {
    try {
      const response = await this.axios.get<Project>(`/api/projects/${slug}`);
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  // Modules — flat routes: /api/modules
  async listModules(projectSlug: string, filters?: ModuleFilters): Promise<Module[]> {
    try {
      const projectId = await this.resolveProjectId(projectSlug);
      const params: Record<string, unknown> = { projectId, limit: filters?.limit || 100 };
      if (filters?.offset) params.page = Math.floor(filters.offset / (filters.limit || 100)) + 1;
      if (filters?.status) params.status = filters.status;
      if (filters?.priority) params.priority = filters.priority;
      if (filters?.ownerId) params.ownerId = filters.ownerId;
      const response = await this.axios.get<PaginatedResponse<Module>>('/api/modules', { params });
      return response.data.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async listModulesWithMeta(projectSlug: string, filters?: ModuleFilters): Promise<PaginatedResponse<Module>> {
    try {
      const projectId = await this.resolveProjectId(projectSlug);
      const params: Record<string, unknown> = { projectId, limit: filters?.limit || 100 };
      if (filters?.offset) params.page = Math.floor(filters.offset / (filters.limit || 100)) + 1;
      if (filters?.status) params.status = filters.status;
      if (filters?.priority) params.priority = filters.priority;
      if (filters?.ownerId) params.ownerId = filters.ownerId;
      const response = await this.axios.get<PaginatedResponse<Module>>('/api/modules', { params });
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async getModule(moduleId: string): Promise<Module> {
    try {
      const response = await this.axios.get<Module>(`/api/modules/${moduleId}`);
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async createModule(projectSlug: string, data: Omit<CreateModuleRequest, 'projectId'>): Promise<Module> {
    try {
      const projectId = await this.resolveProjectId(projectSlug);
      const response = await this.axios.post<Module>('/api/modules', { ...data, projectId });
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async updateModule(moduleId: string, data: UpdateModuleRequest): Promise<Module> {
    try {
      const response = await this.axios.put<Module>(`/api/modules/${moduleId}`, data);
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async deleteModule(moduleId: string): Promise<{ message: string }> {
    try {
      const response = await this.axios.delete<{ message: string }>(`/api/modules/${moduleId}`);
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async countFeaturesByModule(moduleId: string): Promise<{ count: number; features: Feature[] }> {
    try {
      const response = await this.axios.get<PaginatedResponse<Feature>>('/api/features', {
        params: { moduleId, limit: 100 },
      });
      return { count: response.data.total, features: response.data.data };
    } catch (error) {
      return this.handleError(error);
    }
  }

  // Features — flat routes: /api/features
  async listFeatures(projectSlug: string, filters?: ListFilters): Promise<Feature[]> {
    try {
      // Features filter by moduleId, not projectId.
      // List all modules first, then fetch features for each.
      const modules = await this.listModules(projectSlug);
      const allFeatures: Feature[] = [];
      for (const mod of modules) {
        const params: Record<string, unknown> = { moduleId: mod.id, limit: 100 };
        if (filters?.status) params.status = filters.status;
        if (filters?.priority) params.priority = filters.priority;
        const response = await this.axios.get<PaginatedResponse<Feature>>('/api/features', { params });
        allFeatures.push(...response.data.data);
      }
      return allFeatures;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async getFeature(featureId: string): Promise<Feature> {
    try {
      const response = await this.axios.get<Feature>(`/api/features/${featureId}`);
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async createFeature(data: CreateFeatureRequest): Promise<Feature> {
    try {
      const response = await this.axios.post<Feature>('/api/features', data);
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async updateFeature(featureId: string, data: UpdateFeatureRequest): Promise<Feature> {
    try {
      const response = await this.axios.put<Feature>(`/api/features/${featureId}`, data);
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async deleteFeature(featureId: string): Promise<{ message: string }> {
    try {
      const response = await this.axios.delete<{ message: string }>(`/api/features/${featureId}`);
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async countIssuesByFeature(featureId: string): Promise<{ count: number; issues: Issue[] }> {
    try {
      const response = await this.axios.get<PaginatedResponse<Issue>>('/api/issues', {
        params: { featureId, limit: 100 },
      });
      return { count: response.data.total, issues: response.data.data };
    } catch (error) {
      return this.handleError(error);
    }
  }

  // Issues — flat routes: /api/issues
  async listIssues(projectSlug: string, filters?: IssueFilters): Promise<Issue[]> {
    try {
      // Issues filter by featureId, not projectId.
      // List all features first, then fetch issues for each.
      const features = await this.listFeatures(projectSlug);
      const allIssues: Issue[] = [];
      for (const feat of features) {
        const params: Record<string, unknown> = { featureId: feat.id, limit: 100 };
        if (filters?.status) params.status = filters.status;
        if (filters?.priority) params.priority = filters.priority;
        if (filters?.assignedTo) params.assignedTo = filters.assignedTo;
        if (filters?.type) params.type = filters.type;
        const response = await this.axios.get<PaginatedResponse<Issue>>('/api/issues', { params });
        allIssues.push(...response.data.data);
      }
      return allIssues;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async getIssue(issueId: string): Promise<Issue> {
    try {
      const response = await this.axios.get<Issue>(`/api/issues/${issueId}`);
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async createIssue(data: CreateIssueRequest): Promise<Issue> {
    try {
      const response = await this.axios.post<Issue>('/api/issues', data);
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async updateIssue(issueId: string, data: UpdateIssueRequest): Promise<Issue> {
    try {
      const response = await this.axios.put<Issue>(`/api/issues/${issueId}`, data);
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async deleteIssue(issueId: string): Promise<{ message: string }> {
    try {
      const response = await this.axios.delete<{ message: string }>(`/api/issues/${issueId}`);
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async claimIssue(
    issueId: string,
    options?: { checkOnly?: boolean }
  ): Promise<{
    success: boolean;
    message: string;
    canResume?: boolean;
    canClaim?: boolean;
    claimedBy?: string;
    lastActivity?: string;
    issue: Issue;
  }> {
    try {
      // 1. GET issue to check status and takenBy
      const issue = await this.getIssue(issueId);

      // Check if claimable (not done or cancelled)
      if (issue.status === 'done' || issue.status === 'cancelled') {
        return {
          success: false,
          message: `Cannot claim issue with status: ${issue.status}`,
          issue,
        };
      }

      // Check if already claimed
      if (issue.takenBy) {
        // Note: We can't know "my" API key name from client side
        // So we just return claimedBy info
        if (options?.checkOnly) {
          return {
            success: false,
            message: `Already claimed by "${issue.takenBy}"`,
            canClaim: false,
            claimedBy: issue.takenBy,
            lastActivity: issue.updatedAt || '',
            issue,
          };
        }

        // Try to claim anyway - server will check if it's the same API key
        try {
          const response = await this.axios.put<Issue>(
            `/api/issues/${issueId}`,
            { status: 'in-progress' }
          );

          return {
            success: true,
            message: 'Already claimed by you',
            canResume: true,
            issue: response.data,
          };
        } catch (error) {
          // 409 means another agent owns it
          if (axios.isAxiosError(error) && error.response?.status === 409) {
            return {
              success: false,
              message: `Already claimed by "${issue.takenBy}"`,
              claimedBy: issue.takenBy,
              lastActivity: issue.updatedAt || '',
              issue,
            };
          }
          throw error;
        }
      }

      // Issue is available - check only or claim
      if (options?.checkOnly) {
        return {
          success: true,
          message: 'Issue is available to claim',
          canClaim: true,
          issue,
        };
      }

      // Claim the issue (PUT status=in-progress)
      try {
        const response = await this.axios.put<Issue>(
          `/api/issues/${issueId}`,
          { status: 'in-progress' }
        );

        return {
          success: true,
          message: 'Issue claimed successfully',
          issue: response.data,
        };
      } catch (error) {
        // Race condition - another agent claimed it between GET and PUT
        if (axios.isAxiosError(error) && error.response?.status === 409) {
          const errorData = error.response.data as any;
          let claimedBy = errorData.takenBy;

          // Fallback: if takenBy missing in error response, re-fetch for current data
          if (!claimedBy) {
            try {
              const freshIssue = await this.getIssue(issueId);
              claimedBy = freshIssue.takenBy || 'unknown';
              return {
                success: false,
                message: 'Race condition: issue was claimed by another agent',
                claimedBy,
                issue: freshIssue,
              };
            } catch {
              // If re-fetch also fails, use what we have
              claimedBy = 'unknown';
            }
          }

          return {
            success: false,
            message: 'Race condition: issue was claimed by another agent',
            claimedBy,
            issue,
          };
        }
        throw error;
      }
    } catch (error) {
      return this.handleError(error);
    }
  }

  async claimFeature(
    featureId: string,
    options?: { checkOnly?: boolean }
  ): Promise<{
    success: boolean;
    message: string;
    canResume?: boolean;
    canClaim?: boolean;
    claimedBy?: string;
    lastActivity?: string;
    feature: Feature;
  }> {
    try {
      const feature = await this.getFeature(featureId);

      if (feature.status === 'done' || feature.status === 'cancelled') {
        return {
          success: false,
          message: `Cannot claim feature with status: ${feature.status}`,
          feature,
        };
      }

      const currentClaimer = feature.takenBy || feature.takenByUserId;
      if (currentClaimer) {
        if (options?.checkOnly) {
          return {
            success: false,
            message: `Already claimed by "${feature.takenBy || 'a user'}"`,
            canClaim: false,
            claimedBy: feature.takenBy || feature.takenByUserId || 'unknown',
            lastActivity: feature.takenAt || feature.updatedAt || '',
            feature,
          };
        }

        try {
          const response = await this.axios.post<ClaimResponse<'feature', Feature>>(
            `/api/features/${featureId}/claim`
          );
          return {
            success: true,
            message: 'Feature claimed successfully',
            feature: response.data.feature,
          };
        } catch (error) {
          if (axios.isAxiosError(error) && error.response?.status === 409) {
            return {
              success: false,
              message: `Already claimed by "${feature.takenBy || 'another user'}"`,
              claimedBy: feature.takenBy || feature.takenByUserId || 'unknown',
              lastActivity: feature.takenAt || feature.updatedAt || '',
              feature,
            };
          }
          throw error;
        }
      }

      if (options?.checkOnly) {
        return {
          success: true,
          message: 'Feature is available to claim',
          canClaim: true,
          feature,
        };
      }

      try {
        const response = await this.axios.post<ClaimResponse<'feature', Feature>>(
          `/api/features/${featureId}/claim`
        );
        return {
          success: true,
          message: 'Feature claimed successfully',
          feature: response.data.feature,
        };
      } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 409) {
          try {
            const freshFeature = await this.getFeature(featureId);
            return {
              success: false,
              message: 'Race condition: feature was claimed by another agent',
              claimedBy: freshFeature.takenBy || freshFeature.takenByUserId || 'unknown',
              feature: freshFeature,
            };
          } catch {
            return {
              success: false,
              message: 'Race condition: feature was claimed by another agent',
              claimedBy: 'unknown',
              feature,
            };
          }
        }
        throw error;
      }
    } catch (error) {
      return this.handleError(error);
    }
  }

  async claimModule(
    moduleId: string,
    options?: { checkOnly?: boolean }
  ): Promise<{
    success: boolean;
    message: string;
    canResume?: boolean;
    canClaim?: boolean;
    claimedBy?: string;
    lastActivity?: string;
    module: Module;
  }> {
    try {
      const mod = await this.getModule(moduleId);

      if (mod.status === 'done' || mod.status === 'cancelled') {
        return {
          success: false,
          message: `Cannot claim module with status: ${mod.status}`,
          module: mod,
        };
      }

      const currentClaimer = mod.takenBy || mod.takenByUserId;
      if (currentClaimer) {
        if (options?.checkOnly) {
          return {
            success: false,
            message: `Already claimed by "${mod.takenBy || 'a user'}"`,
            canClaim: false,
            claimedBy: mod.takenBy || mod.takenByUserId || 'unknown',
            lastActivity: mod.takenAt || mod.updatedAt || '',
            module: mod,
          };
        }

        try {
          const response = await this.axios.post<ClaimResponse<'module', Module>>(
            `/api/modules/${moduleId}/claim`
          );
          return {
            success: true,
            message: 'Module claimed successfully',
            module: response.data.module,
          };
        } catch (error) {
          if (axios.isAxiosError(error) && error.response?.status === 409) {
            return {
              success: false,
              message: `Already claimed by "${mod.takenBy || 'another user'}"`,
              claimedBy: mod.takenBy || mod.takenByUserId || 'unknown',
              lastActivity: mod.takenAt || mod.updatedAt || '',
              module: mod,
            };
          }
          throw error;
        }
      }

      if (options?.checkOnly) {
        return {
          success: true,
          message: 'Module is available to claim',
          canClaim: true,
          module: mod,
        };
      }

      try {
        const response = await this.axios.post<ClaimResponse<'module', Module>>(
          `/api/modules/${moduleId}/claim`
        );
        return {
          success: true,
          message: 'Module claimed successfully',
          module: response.data.module,
        };
      } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 409) {
          try {
            const freshModule = await this.getModule(moduleId);
            return {
              success: false,
              message: 'Race condition: module was claimed by another agent',
              claimedBy: freshModule.takenBy || freshModule.takenByUserId || 'unknown',
              module: freshModule,
            };
          } catch {
            return {
              success: false,
              message: 'Race condition: module was claimed by another agent',
              claimedBy: 'unknown',
              module: mod,
            };
          }
        }
        throw error;
      }
    } catch (error) {
      return this.handleError(error);
    }
  }

  async bulkUpdateIssues(
    issueIds: string[],
    updates: { status?: string; priority?: string; assignedTo?: string }
  ): Promise<{ updated: number; issues: Issue[] }> {
    try {
      const response = await this.axios.patch<{ updated: number; issues: Issue[] }>(
        '/api/issues/bulk',
        { issueIds, updates }
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  // Health Check — analyzes entities for stale, inconsistent, or problematic states
  async workEntityHealthCheck(options: {
    projectId?: string;
    entityType?: 'module' | 'feature' | 'issue' | 'all';
    checks?: string[];
    staleThresholdHours?: number;
    verbosity?: 'summary' | 'normal' | 'detailed';
  } = {}): Promise<{
    summary: { totalChecked: number; issuesFound: number; byType: Record<string, number> };
    findings?: Array<{
      type: string;
      severity: 'error' | 'warning' | 'info';
      entityType: string;
      entityId: string;
      entityTitle: string;
      takenBy?: string | null;
      takenByUserId?: string | null;
      takenAt?: string | null;
      lastActivity?: string;
      staleDuration?: string;
      recommendation: string;
      details?: unknown;
    }>;
  }> {
    const {
      entityType = 'all',
      checks: selectedChecks,
      staleThresholdHours = 24,
      verbosity = 'normal',
    } = options;

    const allChecks = [
      'stale_in_progress',
      'inconsistent_taken',
      'orphaned_taken',
      'multiple_stuck',
      'long_review',
      'blocked_without_note',
    ];
    const checksToRun = selectedChecks || allChecks;

    type Finding = {
      type: string;
      severity: 'error' | 'warning' | 'info';
      entityType: string;
      entityId: string;
      entityTitle: string;
      takenBy?: string | null;
      takenByUserId?: string | null;
      takenAt?: string | null;
      lastActivity?: string;
      staleDuration?: string;
      recommendation: string;
      details?: unknown;
    };

    const findings: Finding[] = [];
    let totalChecked = 0;
    const now = new Date();

    // Fetch projects to iterate
    const projects = await this.listProjects();

    // Collect all entities
    const allIssues: Issue[] = [];
    const allModules: Module[] = [];
    const allFeatures: Feature[] = [];

    for (const proj of projects) {
      if (options.projectId && proj.id !== options.projectId) continue;

      if (entityType === 'all' || entityType === 'module') {
        try {
          const modules = await this.listModules(proj.slug);
          allModules.push(...modules);
        } catch { /* skip if error */ }
      }
      if (entityType === 'all' || entityType === 'feature') {
        try {
          const features = await this.listFeatures(proj.slug);
          allFeatures.push(...features);
        } catch { /* skip if error */ }
      }
      if (entityType === 'all' || entityType === 'issue') {
        try {
          const issues = await this.listIssues(proj.slug);
          allIssues.push(...issues);
        } catch { /* skip if error */ }
      }
    }

    totalChecked = allModules.length + allFeatures.length + allIssues.length;

    // Helper: calculate hours since last update
    const hoursSince = (dateStr: string) => {
      const diff = now.getTime() - new Date(dateStr).getTime();
      return diff / (1000 * 60 * 60);
    };

    const formatDuration = (hours: number) => {
      if (hours < 1) return `${Math.round(hours * 60)} minutes`;
      if (hours < 24) return `${Math.round(hours)} hours`;
      return `${Math.round(hours / 24)} days`;
    };

    // Check 1: stale_in_progress — use takenAt when available, fall back to updatedAt
    if (checksToRun.includes('stale_in_progress')) {
      for (const issue of allIssues) {
        if (issue.status === 'in-progress') {
          const activityDate = issue.takenAt || issue.updatedAt;
          const hours = hoursSince(activityDate);
          if (hours > staleThresholdHours) {
            findings.push({
              type: 'stale_in_progress',
              severity: 'warning',
              entityType: 'Issue',
              entityId: issue.id,
              entityTitle: issue.title,
              takenBy: issue.takenBy,
              takenByUserId: issue.takenByUserId,
              takenAt: issue.takenAt,
              lastActivity: activityDate,
              staleDuration: formatDuration(hours),
              recommendation: 'Check if agent/user is still working. Consider releasing claim.',
              ...(verbosity === 'detailed' && { details: issue }),
            });
          }
        }
      }
      for (const mod of allModules) {
        if (mod.status === 'in-progress') {
          const activityDate = mod.takenAt || mod.updatedAt;
          const hours = hoursSince(activityDate);
          if (hours > staleThresholdHours) {
            findings.push({
              type: 'stale_in_progress',
              severity: 'warning',
              entityType: 'Module',
              entityId: mod.id,
              entityTitle: mod.title,
              takenBy: mod.takenBy,
              takenByUserId: mod.takenByUserId,
              takenAt: mod.takenAt,
              lastActivity: activityDate,
              staleDuration: formatDuration(hours),
              recommendation: 'Check if agent/user is still working. Consider releasing claim.',
              ...(verbosity === 'detailed' && { details: mod }),
            });
          }
        }
      }
      for (const feat of allFeatures) {
        if (feat.status === 'in-progress') {
          const activityDate = feat.takenAt || feat.updatedAt;
          const hours = hoursSince(activityDate);
          if (hours > staleThresholdHours) {
            findings.push({
              type: 'stale_in_progress',
              severity: 'warning',
              entityType: 'Feature',
              entityId: feat.id,
              entityTitle: feat.title,
              takenBy: feat.takenBy,
              takenByUserId: feat.takenByUserId,
              takenAt: feat.takenAt,
              lastActivity: activityDate,
              staleDuration: formatDuration(hours),
              recommendation: 'Check if agent/user is still working. Consider releasing claim.',
              ...(verbosity === 'detailed' && { details: feat }),
            });
          }
        }
      }
    }

    // Check 2: inconsistent_taken — claimed but status is backlog/cancelled (all entity types)
    if (checksToRun.includes('inconsistent_taken')) {
      const checkInconsistent = (entities: Array<{ id: string; title: string; status: string; takenBy: string | null; takenByUserId: string | null; takenAt: string | null; updatedAt: string }>, typeName: string) => {
        for (const entity of entities) {
          const isClaimed = entity.takenBy || entity.takenByUserId;
          if (isClaimed && (entity.status === 'backlog' || entity.status === 'cancelled')) {
            findings.push({
              type: 'inconsistent_taken',
              severity: 'error',
              entityType: typeName,
              entityId: entity.id,
              entityTitle: entity.title,
              takenBy: entity.takenBy,
              takenByUserId: entity.takenByUserId,
              takenAt: entity.takenAt,
              lastActivity: entity.updatedAt,
              recommendation: `Data inconsistency. Clear claim for ${entity.status} ${typeName.toLowerCase()}.`,
              ...(verbosity === 'detailed' && { details: entity }),
            });
          }
        }
      };
      checkInconsistent(allIssues, 'Issue');
      checkInconsistent(allFeatures, 'Feature');
      checkInconsistent(allModules, 'Module');
    }

    // Check 3: orphaned_taken — compare takenBy values against real API key names (all entity types)
    if (checksToRun.includes('orphaned_taken')) {
      const entitiesWithTakenBy: Array<{ id: string; title: string; takenBy: string | null; takenByUserId: string | null; takenAt: string | null; updatedAt: string; _type: string }> = [
        ...allIssues.filter(i => i.takenBy).map(i => ({ ...i, _type: 'Issue' })),
        ...allFeatures.filter(f => f.takenBy).map(f => ({ ...f, _type: 'Feature' })),
        ...allModules.filter(m => m.takenBy).map(m => ({ ...m, _type: 'Module' })),
      ];
      if (entitiesWithTakenBy.length > 0) {
        try {
          const apiKeysResponse = await this.axios.get<{
            global: Array<{ name: string }>;
            project: Array<{ name: string }>;
          }>('/api/admin/settings/api-keys');
          const allKeyNames = new Set([
            ...apiKeysResponse.data.global.map(k => k.name),
            ...apiKeysResponse.data.project.map(k => k.name),
          ]);

          for (const entity of entitiesWithTakenBy) {
            if (!allKeyNames.has(entity.takenBy!)) {
              findings.push({
                type: 'orphaned_taken',
                severity: 'warning',
                entityType: entity._type,
                entityId: entity.id,
                entityTitle: entity.title,
                takenBy: entity.takenBy,
                takenByUserId: entity.takenByUserId,
                takenAt: entity.takenAt,
                lastActivity: entity.updatedAt,
                recommendation: 'API key deleted or renamed. Consider clearing claim.',
                ...(verbosity === 'detailed' && { details: entity }),
              });
            }
          }
        } catch {
          // Admin endpoint may require admin-level API key — skip silently
        }
      }
    }

    // Check 4: multiple_stuck — group by agent (takenBy) and human (takenByUserId) across all entity types
    if (checksToRun.includes('multiple_stuck')) {
      type ClaimEntry = { id: string; title: string; entityType: string; updatedAt: string };
      const claimerCounts = new Map<string, ClaimEntry[]>();

      const addClaim = (claimerKey: string, entry: ClaimEntry) => {
        if (!claimerCounts.has(claimerKey)) claimerCounts.set(claimerKey, []);
        claimerCounts.get(claimerKey)!.push(entry);
      };

      for (const issue of allIssues) {
        if (issue.status === 'in-progress') {
          if (issue.takenBy) addClaim(`agent:${issue.takenBy}`, { id: issue.id, title: issue.title, entityType: 'Issue', updatedAt: issue.updatedAt });
          if (issue.takenByUserId) addClaim(`user:${issue.takenByUserId}`, { id: issue.id, title: issue.title, entityType: 'Issue', updatedAt: issue.updatedAt });
        }
      }
      for (const feat of allFeatures) {
        if (feat.status === 'in-progress') {
          if (feat.takenBy) addClaim(`agent:${feat.takenBy}`, { id: feat.id, title: feat.title, entityType: 'Feature', updatedAt: feat.updatedAt });
          if (feat.takenByUserId) addClaim(`user:${feat.takenByUserId}`, { id: feat.id, title: feat.title, entityType: 'Feature', updatedAt: feat.updatedAt });
        }
      }
      for (const mod of allModules) {
        if (mod.status === 'in-progress') {
          if (mod.takenBy) addClaim(`agent:${mod.takenBy}`, { id: mod.id, title: mod.title, entityType: 'Module', updatedAt: mod.updatedAt });
          if (mod.takenByUserId) addClaim(`user:${mod.takenByUserId}`, { id: mod.id, title: mod.title, entityType: 'Module', updatedAt: mod.updatedAt });
        }
      }

      for (const [claimerKey, entries] of claimerCounts.entries()) {
        if (entries.length >= 3) {
          const [type, name] = claimerKey.split(':');
          const label = type === 'agent' ? name : `user ${name}`;
          findings.push({
            type: 'multiple_stuck',
            severity: 'warning',
            entityType: 'Mixed',
            entityId: entries[0].id,
            entityTitle: `${label} has ${entries.length} in-progress work items`,
            takenBy: type === 'agent' ? name : null,
            takenByUserId: type === 'user' ? name : null,
            recommendation: type === 'agent'
              ? 'Agent may be crashed or overloaded. Investigate.'
              : 'User has many concurrent claims. Verify workload.',
            ...(verbosity === 'detailed' && {
              details: entries.map(e => ({ id: e.id, title: e.title, entityType: e.entityType, updatedAt: e.updatedAt })),
            }),
          });
        }
      }
    }

    // Check 5: long_review
    if (checksToRun.includes('long_review')) {
      for (const issue of allIssues) {
        if (issue.status === 'review') {
          const hours = hoursSince(issue.updatedAt);
          if (hours > staleThresholdHours) {
            findings.push({
              type: 'long_review',
              severity: 'info',
              entityType: 'Issue',
              entityId: issue.id,
              entityTitle: issue.title,
              takenBy: issue.takenBy,
              takenByUserId: issue.takenByUserId,
              takenAt: issue.takenAt,
              lastActivity: issue.updatedAt,
              staleDuration: formatDuration(hours),
              recommendation: 'Entity waiting for review. Notify architect or assignee.',
              ...(verbosity === 'detailed' && { details: issue }),
            });
          }
        }
      }
    }

    // Check 6: blocked_without_note
    if (checksToRun.includes('blocked_without_note')) {
      for (const issue of allIssues) {
        if (issue.status === 'blocked' && (!issue.notes || issue.notes.trim() === '')) {
          findings.push({
            type: 'blocked_without_note',
            severity: 'warning',
            entityType: 'Issue',
            entityId: issue.id,
            entityTitle: issue.title,
            takenBy: issue.takenBy,
            takenByUserId: issue.takenByUserId,
            takenAt: issue.takenAt,
            lastActivity: issue.updatedAt,
            recommendation: 'Add explanation to notes field.',
            ...(verbosity === 'detailed' && { details: issue }),
          });
        }
      }
      for (const mod of allModules) {
        if (mod.status === 'blocked' && (!mod.notes || mod.notes.trim() === '')) {
          findings.push({
            type: 'blocked_without_note',
            severity: 'warning',
            entityType: 'Module',
            entityId: mod.id,
            entityTitle: mod.title,
            takenBy: mod.takenBy,
            takenByUserId: mod.takenByUserId,
            takenAt: mod.takenAt,
            lastActivity: mod.updatedAt,
            recommendation: 'Add explanation to notes field.',
            ...(verbosity === 'detailed' && { details: mod }),
          });
        }
      }
      for (const feat of allFeatures) {
        if (feat.status === 'blocked' && (!feat.notes || feat.notes.trim() === '')) {
          findings.push({
            type: 'blocked_without_note',
            severity: 'warning',
            entityType: 'Feature',
            entityId: feat.id,
            entityTitle: feat.title,
            takenBy: feat.takenBy,
            takenByUserId: feat.takenByUserId,
            takenAt: feat.takenAt,
            lastActivity: feat.updatedAt,
            recommendation: 'Add explanation to notes field.',
            ...(verbosity === 'detailed' && { details: feat }),
          });
        }
      }
    }

    // Build summary
    const byType: Record<string, number> = {};
    for (const f of findings) {
      byType[f.type] = (byType[f.type] || 0) + 1;
    }

    const result: {
      summary: { totalChecked: number; issuesFound: number; byType: Record<string, number> };
      findings?: typeof findings;
    } = {
      summary: { totalChecked, issuesFound: findings.length, byType },
    };

    if (verbosity !== 'summary') {
      result.findings = findings;
    }

    return result;
  }

  // Discussions — project-scoped: /api/projects/{slug}/discussions
  async createDiscussion(projectSlug: string, data: CreateDiscussionRequest): Promise<Discussion> {
    try {
      const response = await this.axios.post<Discussion>(
        `/api/projects/${projectSlug}/discussions`,
        data
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async listDiscussions(
    projectSlug: string,
    filters?: {
      entityType?: 'Module' | 'Feature' | 'Issue';
      entityId?: string;
      channelId?: string;
      status?: string;
    }
  ): Promise<Discussion[]> {
    try {
      const params = new URLSearchParams();
      if (filters?.entityType) params.set('entityType', filters.entityType);
      if (filters?.entityId) params.set('entityId', filters.entityId);
      if (filters?.channelId) params.set('channelId', filters.channelId);
      if (filters?.status) params.set('status', filters.status);
      const query = params.toString() ? `?${params.toString()}` : '';
      const response = await this.axios.get<Discussion[]>(
        `/api/projects/${projectSlug}/discussions${query}`
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async postMessage(
    projectSlug: string,
    discussionId: string,
    data: CreateDiscussionMessageRequest
  ): Promise<DiscussionMessage> {
    try {
      const response = await this.axios.post<DiscussionMessage>(
        `/api/projects/${projectSlug}/discussions/${discussionId}/messages`,
        data
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  // Channels — project-scoped: /api/projects/{slug}/channels
  async listChannels(projectSlug: string): Promise<Channel[]> {
    try {
      const response = await this.axios.get<Channel[]>(
        `/api/projects/${projectSlug}/channels`
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  // Direct Messages — project-scoped: /api/projects/{slug}/dm/{userId}
  async sendDM(
    projectSlug: string,
    recipientUserId: string,
    data: CreateDirectMessageRequest
  ): Promise<DirectMessage> {
    try {
      const response = await this.axios.post<DirectMessage>(
        `/api/projects/${projectSlug}/dm/${recipientUserId}`,
        data
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  // Team Management — project-scoped: /api/projects/{slug}/team, /members
  async listMembers(projectSlug: string): Promise<ProjectMember[]> {
    try {
      const response = await this.axios.get<ProjectMember[]>(
        `/api/projects/${projectSlug}/team`
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async addMember(
    projectSlug: string,
    userId: string,
    role?: ProjectMemberRole
  ): Promise<ProjectMember> {
    try {
      const data: { userId: string; role?: string } = { userId };
      if (role) data.role = role;
      const response = await this.axios.post<ProjectMember>(
        `/api/projects/${projectSlug}/members`,
        data
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async updateMemberRole(
    projectSlug: string,
    userId: string,
    role: ProjectMemberRole
  ): Promise<ProjectMember> {
    try {
      const response = await this.axios.put<ProjectMember>(
        `/api/projects/${projectSlug}/members/${userId}`,
        { role }
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  // Activity & Audit — project-scoped + admin
  async getEntityActivity(
    projectSlug: string,
    entityType: string,
    entityId: string
  ): Promise<unknown[]> {
    try {
      const response = await this.axios.get<unknown[]>(
        `/api/projects/${projectSlug}/activity/${entityType}/${entityId}`
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async getAuditLog(filters?: {
    page?: number;
    limit?: number;
    action?: string;
    entityType?: string;
  }): Promise<{ data: unknown[]; total: number; page: number; limit: number }> {
    try {
      const params: Record<string, unknown> = {};
      if (filters?.page) params.page = filters.page;
      if (filters?.limit) params.limit = filters.limit;
      if (filters?.action) params.action = filters.action;
      if (filters?.entityType) params.entityType = filters.entityType;
      const response = await this.axios.get<{ data: unknown[]; total: number; page: number; limit: number }>(
        '/api/admin/audit',
        { params }
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  // Discussion CRUD operations (7 new methods)

  async getDiscussion(projectSlug: string, discussionId: string): Promise<Discussion> {
    try {
      const response = await this.axios.get<Discussion>(
        `/api/projects/${projectSlug}/discussions/${discussionId}`
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async getDiscussionMessages(
    projectSlug: string,
    discussionId: string,
    page = 1,
    limit = 50
  ): Promise<{ data: DiscussionMessage[]; total: number; page: number; limit: number }> {
    try {
      const response = await this.axios.get<{ data: DiscussionMessage[]; total: number; page: number; limit: number }>(
        `/api/projects/${projectSlug}/discussions/${discussionId}/messages?page=${page}&limit=${limit}`
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async listDMConversations(projectSlug: string): Promise<unknown[]> {
    try {
      const response = await this.axios.get<unknown[]>(
        `/api/projects/${projectSlug}/dm/conversations`
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async getDMHistory(
    projectSlug: string,
    userId: string,
    page = 1,
    limit = 50
  ): Promise<{ data: DirectMessage[]; total: number; page: number; limit: number }> {
    try {
      const response = await this.axios.get<{ data: DirectMessage[]; total: number; page: number; limit: number }>(
        `/api/projects/${projectSlug}/dm/${userId}?page=${page}&limit=${limit}`
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async updateDiscussion(
    projectSlug: string,
    discussionId: string,
    data: UpdateDiscussionRequest
  ): Promise<Discussion> {
    try {
      const response = await this.axios.put<Discussion>(
        `/api/projects/${projectSlug}/discussions/${discussionId}`,
        data
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async markDMRead(projectSlug: string, userId: string): Promise<{ count: number }> {
    try {
      const response = await this.axios.post<{ count: number }>(
        `/api/projects/${projectSlug}/dm/${userId}/read`
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async editMessage(
    projectSlug: string,
    discussionId: string,
    messageId: string,
    data: { content: string; contentType?: string }
  ): Promise<DiscussionMessage> {
    try {
      const response = await this.axios.put<DiscussionMessage>(
        `/api/projects/${projectSlug}/discussions/${discussionId}/messages/${messageId}`,
        data
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async deleteMessage(
    projectSlug: string,
    discussionId: string,
    messageId: string
  ): Promise<{ message: string }> {
    try {
      const response = await this.axios.delete<{ message: string }>(
        `/api/projects/${projectSlug}/discussions/${discussionId}/messages/${messageId}`
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async deleteDiscussion(projectSlug: string, discussionId: string): Promise<{ message: string }> {
    try {
      const response = await this.axios.delete<{ message: string }>(
        `/api/projects/${projectSlug}/discussions/${discussionId}`
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  // Agent Memory — project-scoped: /api/projects/{slug}/memory/{entityType}/{entityId}

  async readMemory(
    projectSlug: string,
    entityType: MemoryEntityType,
    entityId: string,
    full = false,
  ): Promise<AgentMemory> {
    try {
      const query = full ? '?full=true' : '';
      const response = await this.axios.get<AgentMemory>(
        `/api/projects/${projectSlug}/memory/${entityType}/${entityId}${query}`
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async appendMemoryLog(
    projectSlug: string,
    entityType: MemoryEntityType,
    entityId: string,
    tag: MemoryTag,
    content: string,
  ): Promise<MemoryLogEntry> {
    try {
      const response = await this.axios.post<MemoryLogEntry>(
        `/api/projects/${projectSlug}/memory/${entityType}/${entityId}`,
        { tag, content },
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async consolidateMemory(
    projectSlug: string,
    entityType: MemoryEntityType,
    entityId: string,
    newBaseText: string,
    integrateUpTo?: string,
  ): Promise<{ success: boolean; consolidatedBy: string }> {
    try {
      const body: Record<string, unknown> = { newBaseText };
      if (integrateUpTo) body.integrateUpTo = integrateUpTo;
      const response = await this.axios.put<{ success: boolean; consolidatedBy: string }>(
        `/api/projects/${projectSlug}/memory/${entityType}/${entityId}/consolidate`,
        body,
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  // ===== Protocol Methods =====

  async readProtocol(
    projectSlug: string,
    role: string,
    version?: number,
  ): Promise<Record<string, unknown>> {
    try {
      let query = `?role=${encodeURIComponent(role)}`;
      if (version !== undefined) query += `&version=${version}`;
      const response = await this.axios.get<Record<string, unknown>>(
        `/api/projects/${projectSlug}/protocol${query}`,
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async updateProtocol(
    projectSlug: string,
    role: string,
    content: string,
    changeSummary?: string,
  ): Promise<Record<string, unknown>> {
    try {
      const body: Record<string, unknown> = { role, content };
      if (changeSummary) body.changeSummary = changeSummary;
      const response = await this.axios.put<Record<string, unknown>>(
        `/api/projects/${projectSlug}/protocol`,
        body,
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async listProtocolVersions(
    projectSlug: string,
    role: string,
  ): Promise<{ versions: Array<Record<string, unknown>> }> {
    try {
      const response = await this.axios.get<{ versions: Array<Record<string, unknown>> }>(
        `/api/projects/${projectSlug}/protocol/history?role=${encodeURIComponent(role)}`,
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  // ===== Testing MCP Tools =====

  async reportTestRun(
    projectSlug: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    try {
      const response = await this.axios.post<Record<string, unknown>>(
        `/api/projects/${projectSlug}/test-runs/report`,
        data,
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async getTestHealth(
    projectSlug: string,
    entityType?: string,
    entityId?: string,
  ): Promise<Record<string, unknown>> {
    try {
      const params: Record<string, string> = {};
      if (entityType) params.entityType = entityType;
      if (entityId) params.entityId = entityId;
      const response = await this.axios.get<Record<string, unknown>>(
        `/api/projects/${projectSlug}/test-health`,
        { params },
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async listTests(
    projectSlug: string,
    filters?: Record<string, unknown>,
  ): Promise<unknown[]> {
    try {
      const params: Record<string, unknown> = {};
      if (filters) {
        if (filters.type) params.type = filters.type;
        if (filters.runner) params.runner = filters.runner;
        if (filters.suiteId) params.suiteId = filters.suiteId;
        if (filters.testableType) params.testableType = filters.testableType;
        if (filters.testableId) params.testableId = filters.testableId;
        if (filters.limit) params.limit = filters.limit;
      }
      const response = await this.axios.get<unknown[]>(
        `/api/projects/${projectSlug}/tests`,
        { params },
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async listTestRuns(
    projectSlug: string,
    filters?: Record<string, unknown>,
  ): Promise<unknown[]> {
    try {
      const params: Record<string, unknown> = {};
      if (filters) {
        if (filters.runner) params.runner = filters.runner;
        if (filters.environment) params.environment = filters.environment;
        if (filters.limit) params.limit = filters.limit;
      }
      const response = await this.axios.get<unknown[]>(
        `/api/projects/${projectSlug}/test-runs`,
        { params },
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async linkTestsToEntity(
    projectSlug: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    try {
      const response = await this.axios.put<Record<string, unknown>>(
        `/api/projects/${projectSlug}/tests/link`,
        data,
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async listTestSuites(
    projectSlug: string,
  ): Promise<unknown[]> {
    try {
      const response = await this.axios.get<unknown[]>(
        `/api/projects/${projectSlug}/test-suites`,
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async exportTestSuite(
    projectSlug: string,
    suiteId: string,
  ): Promise<Record<string, unknown>> {
    try {
      const response = await this.axios.get<Record<string, unknown>>(
        `/api/projects/${projectSlug}/test-suites/${suiteId}/export`,
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async importTestSuite(
    projectSlug: string,
    bundle: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    try {
      const response = await this.axios.post<Record<string, unknown>>(
        `/api/projects/${projectSlug}/test-suites/import`,
        bundle,
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  // ===== Git MCP Tools =====

  async gitListFiles(
    projectSlug: string,
    path?: string,
    ref?: string,
    repositoryName?: string,
  ): Promise<Record<string, unknown>> {
    try {
      const params: Record<string, string> = {};
      if (path) params.path = path;
      if (ref) params.ref = ref;
      if (repositoryName) params.repo = repositoryName;
      const response = await this.axios.get<Record<string, unknown>>(
        `/api/projects/${projectSlug}/git/files`,
        { params },
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async gitReadFile(
    projectSlug: string,
    filePath: string,
    ref?: string,
    repositoryName?: string,
  ): Promise<Record<string, unknown>> {
    try {
      const params: Record<string, string> = {};
      if (ref) params.ref = ref;
      if (repositoryName) params.repo = repositoryName;
      const response = await this.axios.get<Record<string, unknown>>(
        `/api/projects/${projectSlug}/git/files/${filePath}`,
        { params },
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async gitCommitLog(
    projectSlug: string,
    limit?: number,
    ref?: string,
    path?: string,
    repositoryName?: string,
  ): Promise<Record<string, unknown>> {
    try {
      const params: Record<string, string> = {};
      if (limit) params.limit = String(limit);
      if (ref) params.ref = ref;
      if (path) params.path = path;
      if (repositoryName) params.repo = repositoryName;
      const response = await this.axios.get<Record<string, unknown>>(
        `/api/projects/${projectSlug}/git/commits`,
        { params },
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async gitGetRemoteUrl(
    projectSlug: string,
    repositoryName?: string,
  ): Promise<Record<string, unknown>> {
    try {
      const params: Record<string, string> = {};
      if (repositoryName) params.repo = repositoryName;
      const response = await this.axios.get<Record<string, unknown>>(
        `/api/projects/${projectSlug}/git/remote`,
        { params },
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  // ===== SSH Key Management =====

  async listSshKeys(): Promise<Record<string, unknown>[]> {
    try {
      const response = await this.axios.get<Record<string, unknown>[]>(
        '/api/user/ssh-keys',
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async addSshKey(
    name: string,
    publicKey: string,
  ): Promise<Record<string, unknown>> {
    try {
      const response = await this.axios.post<Record<string, unknown>>(
        '/api/user/ssh-keys',
        { name, publicKey },
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async revokeSshKey(keyId: string): Promise<Record<string, unknown>> {
    try {
      const response = await this.axios.delete<Record<string, unknown>>(
        `/api/user/ssh-keys/${keyId}`,
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  // ===== Merge Requests =====

  async listMergeRequests(
    projectSlug: string,
    params?: { repositoryName?: string; status?: string; targetBranch?: string; limit?: number },
  ): Promise<{ data: Record<string, unknown>[]; total: number }> {
    try {
      const queryParams: Record<string, string> = {};
      if (params?.repositoryName) queryParams.repo = params.repositoryName;
      if (params?.status) queryParams.status = params.status;
      if (params?.targetBranch) queryParams.targetBranch = params.targetBranch;
      if (params?.limit) queryParams.limit = String(params.limit);
      const response = await this.axios.get<{ data: Record<string, unknown>[]; total: number }>(
        `/api/projects/${projectSlug}/git/merge-requests`,
        { params: queryParams },
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async createMergeRequest(
    projectSlug: string,
    data: {
      repositoryName?: string;
      sourceBranch: string;
      targetBranch: string;
      title: string;
      description?: string;
    },
  ): Promise<Record<string, unknown>> {
    try {
      const response = await this.axios.post<Record<string, unknown>>(
        `/api/projects/${projectSlug}/git/merge-requests`,
        data,
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async getMergeRequest(
    projectSlug: string,
    mergeRequestId: string,
  ): Promise<Record<string, unknown>> {
    try {
      const response = await this.axios.get<Record<string, unknown>>(
        `/api/projects/${projectSlug}/git/merge-requests/${mergeRequestId}`,
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async reviewMergeRequest(
    projectSlug: string,
    mergeRequestId: string,
    data: { verdict: string; body?: string },
  ): Promise<Record<string, unknown>> {
    try {
      const response = await this.axios.post<Record<string, unknown>>(
        `/api/projects/${projectSlug}/git/merge-requests/${mergeRequestId}/reviews`,
        data,
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async mergeMergeRequest(
    projectSlug: string,
    mergeRequestId: string,
    data?: { deleteSourceBranch?: boolean; mergeCommitMessage?: string },
  ): Promise<Record<string, unknown>> {
    try {
      const response = await this.axios.post<Record<string, unknown>>(
        `/api/projects/${projectSlug}/git/merge-requests/${mergeRequestId}/merge`,
        data || {},
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async getBranchDiff(
    projectSlug: string,
    params: { repositoryName?: string; sourceBranch: string; targetBranch: string },
  ): Promise<Record<string, unknown>> {
    try {
      const queryParams: Record<string, string> = {
        source: params.sourceBranch,
        target: params.targetBranch,
      };
      if (params.repositoryName) queryParams.repo = params.repositoryName;
      const response = await this.axios.get<Record<string, unknown>>(
        `/api/projects/${projectSlug}/git/branch-diff`,
        { params: queryParams },
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  // ===== Project Updates =====

  async listUpdates(
    projectSlug: string,
    params?: { updateType?: string; status?: string; limit?: number },
  ): Promise<{ data: Record<string, unknown>[]; total: number }> {
    try {
      const queryParams: Record<string, string> = {};
      if (params?.updateType) queryParams.updateType = params.updateType;
      if (params?.status) queryParams.status = params.status;
      if (params?.limit) queryParams.limit = String(params.limit);
      const response = await this.axios.get<{ data: Record<string, unknown>[]; total: number }>(
        `/api/projects/${projectSlug}/updates`,
        { params: queryParams },
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async downloadUpdate(
    projectSlug: string,
    updateId: string,
  ): Promise<Record<string, unknown>> {
    try {
      const response = await this.axios.get<Record<string, unknown>>(
        `/api/projects/${projectSlug}/updates/${updateId}/download`,
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }
}
