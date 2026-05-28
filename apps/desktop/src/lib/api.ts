import { invoke } from "@tauri-apps/api/core";
import type {
  AgentRunSummary,
  AppSettings,
  AiConnection,
  AiConnectionCheckResult,
  AiModelRefreshResult,
  ApprovalSummary,
  CoordinationExportSummary,
  CreatePlanningSessionInput,
  CreateTaskInput,
  DecidePlanDraftInput,
  EpicSummary,
  GitBranchSummary,
  GitCommitSummary,
  GitFileStatus,
  EffectiveSettings,
  LaunchState,
  NodeRuntimeSummary,
  PlannerConversationInput,
  PlannerConversationResult,
  PlanningMaterializationSummary,
  PlanningSessionDetail,
  PlanningSessionSummary,
  ProjectSettingsPatch,
  ProjectSnapshot,
  RunEventSummary,
  RunnerCheckResult,
  RunnerTemplateSummary,
  SavePlanDraftRevisionInput,
  TaskStatus,
  TaskGraphConflictSummary,
  TaskGraphExportSummary,
  TaskSummary,
  TaskTimelineEntry,
  TaskWorktreeSummary,
  TerminalCommandResult,
  TerminalDirectoryEntry,
  SaveTerminalScriptInput,
  TerminalPtySnapshot,
  TerminalPtySummary,
  TerminalSavedScriptSummary,
} from "./types";

export const api = {
  getLaunchState() {
    return invoke<LaunchState>("get_launch_state");
  },
  getAppSettings() {
    return invoke<AppSettings>("get_app_settings");
  },
  updateAppSettings(settings: AppSettings) {
    return invoke<AppSettings>("update_app_settings", { settings });
  },
  openProject(path: string, options: { reconcileStaleRuns?: boolean } = {}) {
    return invoke<ProjectSnapshot>("open_project", {
      path,
      reconcileStaleRuns: options.reconcileStaleRuns,
    });
  },
  openProjectById(projectId: string, options: { reconcileStaleRuns?: boolean } = {}) {
    return invoke<ProjectSnapshot>("open_project_by_id", {
      projectId,
      reconcileStaleRuns: options.reconcileStaleRuns,
    });
  },
  forgetProject(projectId: string) {
    return invoke<LaunchState>("forget_project", { projectId });
  },
  getProjectSnapshot(projectId: string) {
    return invoke<ProjectSnapshot>("get_project_snapshot", { projectId });
  },
  createEpic(projectId: string, title: string) {
    return invoke<EpicSummary>("create_epic", { projectId, input: { title } });
  },
  createTask(projectId: string, input: CreateTaskInput) {
    return invoke<TaskSummary>("create_task", { projectId, input });
  },
  updateProjectSettings(projectId: string, patch: ProjectSettingsPatch) {
    return invoke<EffectiveSettings>("update_project_settings", { projectId, patch });
  },
  runPlannerConversation(projectId: string, input: PlannerConversationInput) {
    return invoke<PlannerConversationResult>("run_planner_conversation", { projectId, input });
  },
  listPlanningSessions(projectId: string) {
    return invoke<PlanningSessionSummary[]>("list_planning_sessions", { projectId });
  },
  createPlanningSession(projectId: string, input: CreatePlanningSessionInput) {
    return invoke<PlanningSessionDetail>("create_planning_session", { projectId, input });
  },
  getPlanningSession(projectId: string, sessionId: string) {
    return invoke<PlanningSessionDetail>("get_planning_session", { projectId, sessionId });
  },
  savePlanDraftRevision(projectId: string, sessionId: string, input: SavePlanDraftRevisionInput) {
    return invoke<PlanningSessionDetail>("save_plan_draft_revision", { projectId, sessionId, input });
  },
  approvePlanDraft(projectId: string, draftId: string, input: DecidePlanDraftInput = {}) {
    return invoke<PlanningSessionDetail>("approve_plan_draft", { projectId, draftId, input });
  },
  rejectPlanDraft(projectId: string, draftId: string, input: DecidePlanDraftInput = {}) {
    return invoke<PlanningSessionDetail>("reject_plan_draft", { projectId, draftId, input });
  },
  materializePlanDraft(projectId: string, draftId: string) {
    return invoke<PlanningMaterializationSummary>("materialize_plan_draft", { projectId, draftId });
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
  checkOrchestratorConnection(connection: AiConnection) {
    return invoke<AiConnectionCheckResult>("check_orchestrator_connection", { connection });
  },
  refreshAiConnectionModels(projectId: string, connection: AiConnection) {
    return invoke<AiModelRefreshResult>("refresh_ai_connection_models", { projectId, connection });
  },
  refreshOrchestratorConnectionModels(connection: AiConnection) {
    return invoke<AiModelRefreshResult>("refresh_orchestrator_connection_models", { connection });
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
  exportTaskGraph(projectId: string, force = false) {
    return invoke<TaskGraphExportSummary>("export_task_graph", { projectId, force });
  },
  exportCoordinationSnapshot(projectId: string) {
    return invoke<CoordinationExportSummary>("export_coordination_snapshot", { projectId });
  },
  readTaskGraph(projectId: string) {
    return invoke<string | null>("read_task_graph", { projectId });
  },
  checkTaskGraphConflict(projectId: string) {
    return invoke<TaskGraphConflictSummary>("check_task_graph_conflict", { projectId });
  },
  openTaskGraph(projectId: string) {
    return invoke<TaskGraphConflictSummary>("open_task_graph", { projectId });
  },
  runStubRole(projectId: string, taskId: string, roleId: string) {
    return invoke<AgentRunSummary>("run_stub_role", { projectId, taskId, roleId });
  },
  prepareRoleContext(projectId: string, taskId: string, roleId: string) {
    return invoke<AgentRunSummary>("prepare_role_context", { projectId, taskId, roleId });
  },
  prepareRepairContext(projectId: string, repairRequestId: string) {
    return invoke<AgentRunSummary>("prepare_repair_context", { projectId, repairRequestId });
  },
  startNextRoleRun(projectId: string, taskId: string) {
    return invoke<AgentRunSummary>("start_next_role_run", { projectId, taskId });
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
  listTaskTimeline(projectId: string, taskId: string) {
    return invoke<TaskTimelineEntry[]>("list_task_timeline", { projectId, taskId });
  },
  listRunEvents(projectId: string, runId: string) {
    return invoke<RunEventSummary[]>("list_run_events", { projectId, runId });
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
  getTaskWorktreeChangedFiles(projectId: string, taskId: string) {
    return invoke<GitFileStatus[]>("get_task_worktree_changed_files", { projectId, taskId });
  },
  switchGitBranch(projectId: string, branchName: string) {
    return invoke<ProjectSnapshot>("switch_git_branch", { projectId, branchName });
  },
  listNodeRuntimes() {
    return invoke<NodeRuntimeSummary[]>("list_node_runtimes");
  },
  listTerminalDirectories(projectId: string, cwd: string) {
    return invoke<TerminalDirectoryEntry[]>("list_terminal_directories", { projectId, cwd });
  },
  runTerminalCommand(projectId: string, cwd: string, command: string) {
    return invoke<TerminalCommandResult>("run_terminal_command", {
      projectId,
      cwd,
      command,
    });
  },
  resolveTerminalCwd(projectId: string, cwd: string, path: string) {
    return invoke<string>("resolve_terminal_cwd", {
      projectId,
      cwd,
      path,
    });
  },
  startTerminalPty(
    projectId: string,
    terminalId: string,
    cwd: string,
    size: { cols: number; rows: number },
    nodeBinPath?: string | null,
  ) {
    return invoke<string>("start_terminal_pty", {
      projectId,
      terminalId,
      cwd,
      cols: size.cols,
      rows: size.rows,
      nodeBinPath,
    });
  },
  listTerminalPtys(projectId: string) {
    return invoke<TerminalPtySummary[]>("list_terminal_ptys", { projectId });
  },
  getTerminalPtySnapshot(terminalId: string) {
    return invoke<TerminalPtySnapshot | null>("get_terminal_pty_snapshot", { terminalId });
  },
  listTerminalSavedScripts(projectId: string) {
    return invoke<TerminalSavedScriptSummary[]>("list_terminal_saved_scripts", { projectId });
  },
  saveTerminalSavedScript(projectId: string, input: SaveTerminalScriptInput) {
    return invoke<TerminalSavedScriptSummary>("save_terminal_saved_script", { projectId, input });
  },
  markTerminalSavedScriptUsed(projectId: string, scriptId: string) {
    return invoke<TerminalSavedScriptSummary>("mark_terminal_saved_script_used", { projectId, scriptId });
  },
  deleteTerminalSavedScript(projectId: string, scriptId: string) {
    return invoke<void>("delete_terminal_saved_script", { projectId, scriptId });
  },
  writeTerminalPty(terminalId: string, data: string) {
    return invoke<void>("write_terminal_pty", { terminalId, data });
  },
  resizeTerminalPty(terminalId: string, size: { cols: number; rows: number }) {
    return invoke<void>("resize_terminal_pty", {
      terminalId,
      cols: size.cols,
      rows: size.rows,
    });
  },
  stopTerminalPty(terminalId: string) {
    return invoke<void>("stop_terminal_pty", { terminalId });
  },
};
