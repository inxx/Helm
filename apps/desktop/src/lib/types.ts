export type TaskStatus =
  | "Planned"
  | "Ready"
  | "Coding"
  | "PlanVerification"
  | "CodeReview"
  | "Testing"
  | "MergeWaiting"
  | "Merged"
  | "Done"
  | "Blocked";

export interface CommandError {
  code: string;
  message: string;
  details?: string;
}

export interface ProjectSummary {
  id: string;
  rootPath: string;
  name: string;
  baseBranch: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RecentProjectSummary {
  id: string;
  name: string;
  rootPath: string;
  lastOpenedAt: number;
}

export interface LaunchState {
  recentProjects: RecentProjectSummary[];
  activeProjectId: string | null;
  activeProjectRootPath: string | null;
  snapshot: ProjectSnapshot | null;
  restoreError: CommandError | null;
}

export interface EffectiveSettings {
  rolePresets: unknown;
  aiConnections: AiConnection[];
  roleAssignments: RoleAssignment[];
  worktreeRoot: string | null;
  obsidianVaultPath: string | null;
  tokenBudget: number | null;
  artifactRetentionDays: number | null;
}

export interface AiConnection {
  id: string;
  label: string;
  provider: "fixture" | "codex" | "claude" | string;
  commandArgs: string[];
  healthCheckArgs?: string[];
  timeoutSeconds: number;
  enabled: boolean;
  defaultModel?: string | null;
  availableModels?: string[];
  defaultEffort?: string | null;
}

export interface RoleRunnerSelection {
  connectionId: string;
  model?: string | null;
  effort?: string | null;
}

export interface RoleAssignment {
  roleId: "planner" | "coder" | "plan_verifier" | "code_reviewer" | "tester";
  selectionMode: "single" | "multiple";
  selections: RoleRunnerSelection[];
  /** Legacy shape retained for older persisted project settings. */
  connectionIds: string[];
  aggregationPolicy?: "all_pass" | "any_pass" | "manual_decision" | null;
}

export interface RunnerTemplateSummary {
  id: string;
  label: string;
  description: string;
}

export interface RunnerCheckResult {
  roleId: string;
  available: boolean;
  command: string[];
  message: string;
}

export interface AiConnectionCheckResult {
  connectionId: string;
  available: boolean;
  command: string[];
  message: string;
  availableModels?: string[];
  modelRefreshMessage?: string;
}

export interface EpicSummary {
  id: string;
  projectId: string;
  title: string;
  status: string;
  planPath: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskExternalRefSummary {
  id: string;
  projectId: string;
  taskId: string;
  refType: string;
  refValue: string;
  refTitle: string | null;
  createdAt: string;
}

export interface TaskSummary {
  id: string;
  projectId: string;
  epicId: string | null;
  title: string;
  description: string;
  status: TaskStatus;
  statusReason: string | null;
  sortOrder: number;
  externalRefs: TaskExternalRefSummary[];
  createdAt: string;
  updatedAt: string;
  lastTransitionAt: string;
}

export interface TaskWorktreeSummary {
  id: string;
  projectId: string;
  taskId: string;
  branchName: string;
  worktreePath: string;
  baseBranch: string | null;
  headHash: string | null;
  status: "Active" | "Archived";
  createdAt: string;
  updatedAt: string;
}

export interface AuditLogEntry {
  id: string;
  projectId: string;
  entityType: string;
  entityId: string | null;
  eventType: string;
  payload: unknown;
  createdAt: string;
}

export interface TaskCounts {
  total: number;
  done: number;
  byStatus: Record<string, number>;
}

export interface GitRepositoryState {
  currentBranch: string | null;
  head: string | null;
  isDetached: boolean;
  dirtyCount: number;
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  userName: string | null;
  userEmail: string | null;
}

export interface GitBranchSummary {
  branchName: string;
  headHash: string;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  isCurrent: boolean;
}

export type GitGraphCellKind =
  | "empty"
  | "pipe"
  | "commit"
  | "branch-right"
  | "branch-left"
  | "merge-right"
  | "merge-left"
  | "horizontal"
  | "horizontal-pipe"
  | "tee-right"
  | "tee-left"
  | "tee-up";

export interface GitGraphCell {
  kind: GitGraphCellKind;
  colorIndex: number | null;
  secondaryColorIndex: number | null;
}

export interface GitCommitSummary {
  hash: string;
  shortHash: string;
  graphCells: GitGraphCell[];
  graphConnectorRows: GitGraphCell[][];
  graphLane: number;
  graphColorIndex: number;
  authorName: string;
  authorEmail: string;
  committedAt: string;
  subject: string;
  refs: string[];
  isMine: boolean;
  isHead: boolean;
}

export interface GitFileStatus {
  path: string;
  status: string;
  staged: boolean;
  renamedFrom: string | null;
}

export interface ProjectSnapshot {
  project: ProjectSummary;
  settings: EffectiveSettings;
  repository: GitRepositoryState;
  epics: EpicSummary[];
  tasks: TaskSummary[];
  approvals: ApprovalSummary[];
  taskCounts: TaskCounts;
  auditTail: AuditLogEntry[];
}

export interface CreateTaskInput {
  epicId?: string | null;
  title: string;
  description?: string;
  externalRefs?: Array<{
    refType: "JiraEpic" | "JiraTask" | "MarkdownPlan" | "PlainText" | "Url";
    refValue: string;
    refTitle?: string | null;
  }>;
}

export interface ProjectSettingsPatch {
  rolePresets?: unknown;
  aiConnections?: AiConnection[];
  roleAssignments?: RoleAssignment[];
  worktreeRoot?: string | null;
  obsidianVaultPath?: string | null;
  tokenBudget?: number | null;
  artifactRetentionDays?: number | null;
}

export interface TerminalCommandResult {
  cwd: string;
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export interface AgentRunSummary {
  id: string;
  projectId: string;
  taskId: string;
  roleId: string;
  status: string;
  artifactDir: string;
  summaryPath: string;
  resultPath: string;
  stdoutLogPath: string;
  stderrLogPath: string;
  exitCode: number | null;
  resultStatus: "pass" | "fail" | "needs_changes" | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalSummary {
  id: string;
  projectId: string;
  entityType: "Task" | "AgentRun";
  entityId: string;
  approvalType: "PlanApproval" | "RunApproval" | "ManualStatusChange";
  status: "Pending" | "Approved" | "Rejected" | "Expired";
  requestedReason: string;
  decisionReason: string | null;
  requestedAt: string;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
