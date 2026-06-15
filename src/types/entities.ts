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
  claimSettings: Record<string, unknown> | null;
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
  takenBy: string | null;
  takenByUserId: string | null;
  takenAt: string | null;
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
  takenBy: string | null;
  takenByUserId: string | null;
  takenAt: string | null;
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
  takenByUserId: string | null;
  takenAt: string | null;
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

export interface Channel {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  isDefault: boolean;
  position: number;
  createdAt: string;
  updatedAt: string;
}

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

// Agent Skills (F1) — composed protocols

export type SkillScope = 'system' | 'project';

export type SkillCategory =
  | 'review'
  | 'planning'
  | 'testing'
  | 'deployment'
  | 'communication'
  | 'memory'
  | 'safety'
  | 'resilience'
  | 'git'
  | 'database'
  | 'other';

/**
 * Request body for POST /api/skills.
 *
 * Server validation (mirrored from app/api/skills/route.ts):
 *   - scope='system'  → projectSlug MUST be omitted
 *   - scope='project' → projectSlug REQUIRED
 *   - name: kebab-case (1..100 chars, starts with a letter)
 *   - applicableRoles: non-empty array of {architect,dev,qa,devops} or ['*']
 */
export interface CreateSkillRequest {
  scope: SkillScope;
  name: string;
  description: string;
  content: string;
  category: SkillCategory;
  applicableRoles: string[];
  projectSlug?: string;
}

/**
 * Request body for PUT /api/skills/[name]?scope=&projectSlug=.
 *
 * At least one field must be supplied. A no-op PUT (no field differs from the
 * current row) returns the current row unchanged (200) WITHOUT bumping version.
 */
export interface UpdateSkillRequest {
  description?: string;
  content?: string;
  category?: SkillCategory;
  applicableRoles?: string[];
  isDeprecated?: boolean;
}

/**
 * Lifecycle transition action for composed-protocol assets (skills, role
 * templates, skill packs). The server exposes three POST endpoints per asset
 * at /api/{resource}/[name]/{action}; this enum is the discriminator for the
 * consolidated MCP tool surface (one tool per resource type with an
 * `action` enum, rather than 3×N separate tools).
 *
 * P2·I7 ships the routes server-side; P2·I8 wraps them here. The set is
 * intentionally fixed at three values — the resolver currently models the
 * lifecycle as draft → proposed → published → deprecated, and any future
 * "rollback" / "republish" transition would land as a new enum value.
 */
export type LifecycleTransitionAction = 'propose' | 'publish' | 'deprecate';

/**
 * Server-side 409 response shape for an invalid lifecycle transition.
 * Returned by POST /api/{skills|role-templates|skill-packs}/[name]/[action]
 * when the requested action is not in the allowed-transitions set for the
 * current lifecycle state. The MCP tool turns this into a helpful
 * "Cannot transition from X to Y — allowed: [...]" message.
 */
export interface InvalidTransitionError {
  error: 'invalid_transition';
  from: string;
  to: string;
  allowed: string[];
}

// Role Templates (Agent Skills F2 — composed protocols)

/**
 * Base role bucket for a role template. Mirrors `BASE_ROLES` in
 * `haops/lib/models/RoleTemplate.ts`. The `custom` value lets admins create
 * role templates that don't map to one of the four canonical agent roles
 * (architect/dev/qa/devops) — researcher slots are pre-blessed for the
 * science-haops surface.
 */
export type BaseRole =
  | 'architect'
  | 'dev'
  | 'qa'
  | 'devops'
  | 'researcher'
  | 'custom';

/**
 * Shape of each entry in the `defaultSkills` JSONB column on RoleTemplate.
 * `required: true` marks the skill as load-bearing for the template — the
 * web UI disables the per-project toggle and the protocol resolver refuses
 * to drop required skills (DECISIONS C2).
 */
export interface DefaultSkillRef {
  skillId: string;
  required: boolean;
}

export interface CreateRoleTemplateRequest {
  name: string;
  baseRole: BaseRole;
  baseBody: string;
  description?: string | null;
  defaultSkills?: DefaultSkillRef[];
}

export interface UpdateRoleTemplateRequest {
  baseRole?: BaseRole;
  description?: string | null;
  baseBody?: string;
  defaultSkills?: DefaultSkillRef[];
}

// ===== Cascade Preview Types (P·A·I4) =====

/**
 * Lightweight summary of a RoleTemplate row pinned to the old skill UUID.
 * Mirrors TemplateConsumer in lib/protocols/cascadePreview.ts.
 */
export interface CascadeTemplateConsumer {
  templateId: string;
  templateName: string;
  /** true if the stale skill was a REQUIRED entry in defaultSkills */
  required: boolean;
}

/**
 * Lightweight summary of a ProjectProtocol row pinned to the old skill UUID
 * via skillsConfig.enabledSkillIds[].
 */
export interface CascadeProtocolSkillConsumer {
  protocolId: string;
  projectId: string;
  role: string;
  version: number;
}

/**
 * Lightweight summary of a ProjectProtocol row pinned to the old template UUID
 * via templateId column.
 */
export interface CascadeProtocolTemplateConsumer {
  protocolId: string;
  projectId: string;
  role: string;
  version: number;
  stale: boolean;
}

/**
 * Lightweight summary of a SkillPack row pinned to the old skill UUID.
 */
export interface CascadePackConsumer {
  packId: string;
  packName: string;
}

/**
 * The cascade preview envelope returned by GET /api/skills/[name]/cascade-preview
 * and GET /api/role-templates/[name]/cascade-preview.
 *
 * For skill previews: templates, protocolsBySkill, and packs are populated;
 * protocolsByTemplate is empty (N/A for skill PUTs).
 * For template previews: only protocolsByTemplate is populated.
 *
 * mirrors CascadePreview in lib/protocols/cascadePreview.ts.
 */
export interface CascadePreview {
  count: number;
  templates: CascadeTemplateConsumer[];
  protocolsBySkill: CascadeProtocolSkillConsumer[];
  protocolsByTemplate: CascadeProtocolTemplateConsumer[];
  packs: CascadePackConsumer[];
  /** REQUIRED skills that would become (missing) if the caller doesn't cascade. */
  warnings: string[];
}

/**
 * Response envelope from GET /api/skills/[name]/cascade-preview.
 */
export interface SkillCascadePreview {
  skillId: string;
  skillName: string;
  cascadePreview: CascadePreview;
}

/**
 * Response envelope from GET /api/role-templates/[name]/cascade-preview.
 */
export interface RoleTemplateCascadePreview {
  templateId: string;
  templateName: string;
  cascadePreview: CascadePreview;
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
