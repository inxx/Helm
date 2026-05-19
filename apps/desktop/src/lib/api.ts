import { invoke } from "@tauri-apps/api/core";
import type {
  AgentRunSummary,
  AiConnection,
  AiConnectionCheckResult,
  ApprovalSummary,
  CreateTaskInput,
  GitBranchSummary,
  GitCommitSummary,
  GitFileStatus,
  EffectiveSettings,
  LaunchState,
  ProjectSettingsPatch,
  ProjectSnapshot,
  RunnerCheckResult,
  RunnerTemplateSummary,
  TaskStatus,
  TaskWorktreeSummary,
  TerminalCommandResult,
} from "./types";

export const api = {
  getLaunchState() {
    return invoke<LaunchState>("get_launch_state");
  },
  openProject(path: string, options: { reconcileStaleRuns?: boolean } = {}) {
    return invoke<ProjectSnapshot>("open_project", {
      path,
      reconcileStaleRuns: options.reconcileStaleRuns,
    });
  },
  getProjectSnapshot(projectId: string) {
    return invoke<ProjectSnapshot>("get_project_snapshot", { projectId });
  },
  createEpic(projectId: string, title: string) {
    return invoke("create_epic", { projectId, input: { title } });
  },
  createTask(projectId: string, input: CreateTaskInput) {
    return invoke("create_task", { projectId, input });
  },
  updateProjectSettings(projectId: string, patch: ProjectSettingsPatch) {
    return invoke<EffectiveSettings>("update_project_settings", { projectId, patch });
  },
  listRunnerTemplates(projectId: string) {
    return invoke<RunnerTemplateSummary[]>("list_runner_templates", { projectId });
  },
  applyRunnerTemplate(projectId: string, templateId: string) {
    return invoke<EffectiveSettings>("apply_runner_template", { projectId, templateId });
  },
  checkRoleRunner(projectId: string, roleId: string) {
    return invoke<RunnerCheckResult>("check_role_runner", { projectId, roleId });
  },
  checkAiConnection(projectId: string, connection: AiConnection) {
    return invoke<AiConnectionCheckResult>("check_ai_connection", { projectId, connection });
  },
  updateTaskStatus(
    projectId: string,
    taskId: string,
    status: TaskStatus,
    statusReason?: string | null,
  ) {
    return invoke("update_task_status", {
      projectId,
      taskId,
      status,
      statusReason,
    });
  },
  getTaskWorktree(projectId: string, taskId: string) {
    return invoke<TaskWorktreeSummary | null>("get_task_worktree", { projectId, taskId });
  },
  ensureTaskWorktree(projectId: string, taskId: string) {
    return invoke<TaskWorktreeSummary>("ensure_task_worktree", { projectId, taskId });
  },
  runStubRole(projectId: string, taskId: string, roleId: string) {
    return invoke<AgentRunSummary>("run_stub_role", { projectId, taskId, roleId });
  },
  prepareRoleContext(projectId: string, taskId: string, roleId: string) {
    return invoke<AgentRunSummary>("prepare_role_context", { projectId, taskId, roleId });
  },
  runHostRole(projectId: string, runId: string) {
    return invoke<AgentRunSummary>("run_host_role", { projectId, runId });
  },
  retryHostRole(projectId: string, runId: string) {
    return invoke<AgentRunSummary>("retry_host_role", { projectId, runId });
  },
  cancelHostRole(projectId: string, runId: string) {
    return invoke<AgentRunSummary>("cancel_host_role", { projectId, runId });
  },
  listAgentRuns(projectId: string, taskId: string) {
    return invoke<AgentRunSummary[]>("list_agent_runs", { projectId, taskId });
  },
  readRunArtifact(projectId: string, runId: string, artifactName: string) {
    return invoke<string>("read_run_artifact", { projectId, runId, artifactName });
  },
  listApprovals(projectId: string, status?: ApprovalSummary["status"]) {
    return invoke<ApprovalSummary[]>("list_approvals", { projectId, status });
  },
  approveApproval(projectId: string, approvalId: string, reason: string) {
    return invoke<ApprovalSummary>("approve_approval", { projectId, approvalId, reason });
  },
  rejectApproval(projectId: string, approvalId: string, reason: string) {
    return invoke<ApprovalSummary>("reject_approval", { projectId, approvalId, reason });
  },
  getLocalBranches(projectId: string) {
    return invoke<GitBranchSummary[]>("get_local_branches", { projectId });
  },
  getRecentCommits(projectId: string, limit = 20) {
    return invoke<GitCommitSummary[]>("get_recent_commits", {
      projectId,
      limit,
    });
  },
  getChangedFiles(projectId: string) {
    return invoke<GitFileStatus[]>("get_changed_files", { projectId });
  },
  runTerminalCommand(
    projectId: string,
    cwdMode: "project" | "worktree",
    taskId: string | null,
    command: string,
  ) {
    return invoke<TerminalCommandResult>("run_terminal_command", {
      projectId,
      cwdMode,
      taskId,
      command,
    });
  },
};
