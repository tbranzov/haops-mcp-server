/**
 * TypeScript types for HAOps entities
 * Mirrors Sequelize models from main HAOps application
 */

export interface Project {
  id: string;
  title: string;
  slug: string;
  description: string | null;
  status: 'active' | 'on-hold' | 'completed' | 'archived';
  priority: 'low' | 'medium' | 'high' | 'critical';
  color: string;
  startDate: string | null;
  targetDate: string | null;
  completedDate: string | null;
  ownerId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface Module {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  notes: string | null;
  status: 'backlog' | 'in-progress' | 'review' | 'done' | 'blocked' | 'on-hold' | 'cancelled';
  priority: 'low' | 'medium' | 'high' | 'critical';
  startDate: string | null;
  targetDate: string | null;
  completedDate: string | null;
  ownerId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface Feature {
  id: string;
  moduleId: string;
  title: string;
  description: string | null;
  notes: string | null;
  acceptanceCriteria: string | null;
  status: 'backlog' | 'in-progress' | 'review' | 'done' | 'blocked' | 'on-hold' | 'cancelled';
  priority: 'low' | 'medium' | 'high' | 'critical';
  startDate: string | null;
  targetDate: string | null;
  completedDate: string | null;
  ownerId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: string;
  featureId: string;
  title: string;
  description: string | null;
  acceptanceCriteria: string | null;
  notes: string | null;
  type: 'feature' | 'bug' | 'optimization' | 'refactoring' | 'documentation' | 'research';
  status: 'backlog' | 'in-progress' | 'review' | 'done' | 'blocked' | 'on-hold' | 'cancelled';
  priority: 'low' | 'medium' | 'high' | 'critical';
  targetDate: string | null;
  completedDate: string | null;
  assignedTo: string | null;
  takenBy: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

// Request payloads
export interface CreateModuleRequest {
  title: string;
  projectId: string;
  description?: string;
  notes?: string;
  status?: Module['status'];
  priority?: Module['priority'];
  startDate?: string;
  targetDate?: string;
  ownerId: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateModuleRequest {
  title?: string;
  description?: string;
  notes?: string;
  status?: Module['status'];
  priority?: Module['priority'];
  startDate?: string;
  targetDate?: string;
  completedDate?: string;
  ownerId?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateFeatureRequest {
  moduleId: string;
  title: string;
  description?: string;
  notes?: string;
  acceptanceCriteria?: string;
  status?: Feature['status'];
  priority?: Feature['priority'];
  startDate?: string;
  targetDate?: string;
  ownerId: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateFeatureRequest {
  title?: string;
  description?: string;
  notes?: string;
  acceptanceCriteria?: string;
  status?: Feature['status'];
  priority?: Feature['priority'];
  startDate?: string;
  targetDate?: string;
  completedDate?: string;
  ownerId?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateIssueRequest {
  featureId: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string;
  notes?: string;
  type?: Issue['type'];
  status?: Issue['status'];
  priority?: Issue['priority'];
  targetDate?: string;
  assignedTo?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateIssueRequest {
  title?: string;
  description?: string;
  acceptanceCriteria?: string;
  notes?: string;
  type?: Issue['type'];
  status?: Issue['status'];
  priority?: Issue['priority'];
  targetDate?: string;
  completedDate?: string;
  assignedTo?: string;
  takenBy?: string | null;
  metadata?: Record<string, unknown>;
}

// Communication entities

export interface Discussion {
  id: string;
  channelId: string | null;
  discussableType: 'Module' | 'Feature' | 'Issue' | null;
  discussableId: string | null;
  type: 'extension' | 'bug' | 'optimization' | 'question' | 'general';
  title: string;
  status: 'open' | 'in-progress' | 'resolved' | 'closed';
  priority: 'low' | 'medium' | 'high' | 'critical' | null;
  createdBy: string;
  assignedTo: string | null;
  isLocked: boolean;
  isPinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DiscussionMessage {
  id: string;
  discussionId: string;
  parentMessageId: string | null;
  authorId: string;
  content: string;
  contentType: 'text' | 'markdown' | 'html' | 'code';
  edited: boolean;
  isPinned: boolean;
  reactions: Record<string, string[]>;
  createdAt: string;
  updatedAt: string;
}

export interface DirectMessage {
  id: string;
  projectId: string;
  senderId: string;
  recipientId: string;
  content: string;
  contentType: 'text' | 'markdown' | 'html' | 'code';
  isRead: boolean;
  createdAt: string;
  updatedAt: string;
}

// Communication request payloads

export interface CreateDiscussionRequest {
  title: string;
  type?: Discussion['type'];
  priority?: 'low' | 'medium' | 'high' | 'critical';
  channelId?: string;
  discussableType?: 'Module' | 'Feature' | 'Issue';
  discussableId?: string;
  firstMessage?: string;
  firstMessageContentType?: 'text' | 'markdown' | 'html' | 'code';
}

export interface CreateDiscussionMessageRequest {
  content: string;
  contentType?: DiscussionMessage['contentType'];
  parentMessageId?: string;
}

export interface CreateDirectMessageRequest {
  content: string;
  contentType?: DirectMessage['contentType'];
}

export interface UpdateDiscussionRequest {
  title?: string;
  type?: Discussion['type'];
  status?: Discussion['status'];
  priority?: Discussion['priority'];
  assignedTo?: string;
  isLocked?: boolean;
  isPinned?: boolean;
}

// Agent Memory

export type MemoryEntityType = 'project' | 'module' | 'feature';

export type MemoryTag = 'context' | 'decision' | 'progress' | 'issue' | 'review' | 'deploy';

export interface MemoryLogEntry {
  id: string;
  timestamp: string;
  author: string;
  tag: string;
  content: string;
  integrated: boolean;
}

export interface MemoryMeta {
  lastConsolidated: string | null;
  consolidatedBy: string | null;
  logRetentionDays: number;
}

export interface AgentMemory {
  baseText: string;
  log: MemoryLogEntry[];
  meta: MemoryMeta;
}

// Team management entities

export type ProjectMemberRole = 'owner' | 'admin' | 'project_manager' | 'member' | 'viewer';

export interface ProjectMember {
  id: string;
  projectId: string;
  userId: string;
  role: ProjectMemberRole;
  createdAt: string;
  updatedAt: string;
  user?: {
    id: string;
    username: string;
    fullName: string;
    email: string;
    avatarUrl: string | null;
  };
  stats?: {
    featuresOwned: number;
    featuresAssigned: number;
    issuesAssigned: number;
    discussions: number;
  };
}
