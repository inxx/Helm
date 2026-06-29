mod db;
mod git;
mod github_app;
mod jira;
mod models;

use crate::models::{
    AgentRunSummary, AgentSessionSummary, AiConnectionCheckResult, AiModelRefreshResult,
    AppSettings, AppendTaskInstructionInput, ApprovalSummary, CommandError, CommandResult,
    ConversationMessage, CoordinationExportSummary, CreateEpicInput, CreatePlanningSessionInput,
    CreateTaskInput,
    DecidePlanDraftInput, EffectiveSettings, EpicSummary, GitBranchSummary, GitCommitSummary,
    GitFileDiff, GitFileStatus, GitRepositoryState, JiraIssueSummary, JiraTransition,
    NodeRuntimeSummary, OrchestratorConversationInput, OrchestratorSettings, PlannerConversationInput,
    PlannerConversationResult,
    PlanningMaterializationSummary, PlanningSessionDetail, PlanningSessionSummary, ProjectContext,
    ProjectSettingsPatch, ProjectSnapshot, ProjectSummary, PullRequestDetail, PullRequestSummary,
    RunEventSummary, RunnerCheckResult, RunnerTemplateSummary, SavePlanDraftRevisionInput,
    SaveTerminalScriptInput, TaskCompletionGitSummary, TaskGraphConflictSummary,
    TaskGraphExportSummary, TaskSummary, TaskTimelineEntry, TaskWorktreeSummary,
    TerminalCommandResult, TerminalDirectoryEntry, TerminalSavedScriptSummary,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::env;
use std::ffi::CString;
use std::fs;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc, Mutex,
};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, State};

const MAX_RECENT_PROJECTS: usize = 12;
const AI_CLI_SMOKE_SENTINEL: &str = "HELM_CLI_OK";
const MAX_TERMINAL_HISTORY_CHARS: usize = 250_000;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredRecentProject {
    id: String,
    name: String,
    root_path: String,
    last_opened_at: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredLaunchState {
    version: u32,
    recent_projects: Vec<StoredRecentProject>,
    active_project_id: Option<String>,
    active_project_root_path: Option<String>,
    updated_at: Option<String>,
}

impl Default for StoredLaunchState {
    fn default() -> Self {
        Self {
            version: 1,
            recent_projects: Vec::new(),
            active_project_id: None,
            active_project_root_path: None,
            updated_at: None,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LaunchState {
    recent_projects: Vec<StoredRecentProject>,
    active_project_id: Option<String>,
    active_project_root_path: Option<String>,
    snapshot: Option<ProjectSnapshot>,
    restore_error: Option<CommandError>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ControlTowerProjectSummary {
    recent: StoredRecentProject,
    snapshot: Option<ProjectSnapshot>,
    runs: Vec<AgentRunSummary>,
    error: Option<CommandError>,
}

#[derive(Default)]
struct AppState {
    projects: Mutex<HashMap<String, ProjectContext>>,
    running_runs: Mutex<HashMap<String, Arc<AtomicBool>>>,
    queue_workers: Mutex<HashMap<String, Arc<AtomicBool>>>,
    terminal_sessions: Mutex<HashMap<String, PtySession>>,
    role_pty_sessions: Mutex<HashMap<String, RolePtySession>>,
    handoff_watcher: Mutex<Option<Child>>,
}

struct PtySession {
    child_pid: libc::pid_t,
    writer: Arc<Mutex<fs::File>>,
    state: Arc<Mutex<TerminalSessionState>>,
    startup_dir: Option<PathBuf>,
}

struct RolePtySession {
    child_pid: libc::pid_t,
    writer: Arc<Mutex<fs::File>>,
}

#[derive(Debug)]
struct TerminalSessionState {
    terminal_id: String,
    project_id: String,
    cwd: String,
    node_bin_path: Option<String>,
    cols: u16,
    rows: u16,
    running: bool,
    exit_code: Option<i32>,
    seq: u64,
    history: String,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TerminalPtySummary {
    terminal_id: String,
    project_id: String,
    cwd: String,
    node_bin_path: Option<String>,
    cols: u16,
    rows: u16,
    running: bool,
    exit_code: Option<i32>,
    seq: u64,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TerminalPtySnapshot {
    terminal_id: String,
    project_id: String,
    cwd: String,
    node_bin_path: Option<String>,
    cols: u16,
    rows: u16,
    running: bool,
    exit_code: Option<i32>,
    seq: u64,
    history: String,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TerminalPtyOutput {
    terminal_id: String,
    data: String,
    seq: u64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TerminalPtyExit {
    terminal_id: String,
    exit_code: i32,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RolePtyOutput {
    session_id: String,
    project_id: String,
    task_id: String,
    role_id: String,
    data: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RolePtyReady {
    session_id: String,
    project_id: String,
    task_id: String,
    role_id: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RolePtyExit {
    session_id: String,
    project_id: String,
    task_id: String,
    role_id: String,
    exit_code: i32,
}

#[tauri::command]
fn open_project(
    path: String,
    reconcile_stale_runs: Option<bool>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> CommandResult<ProjectSnapshot> {
    let snapshot = open_project_from_path(
        Path::new(&path),
        &state,
        &app,
        reconcile_stale_runs.unwrap_or(false),
    )?;
    remember_project(&app, &snapshot.project)?;
    Ok(snapshot)
}

#[tauri::command]
fn open_project_by_id(
    project_id: String,
    reconcile_stale_runs: Option<bool>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> CommandResult<ProjectSnapshot> {
    let stored = load_stored_launch_state(&app)?;
    let root_path = stored
        .recent_projects
        .iter()
        .find(|project| project.id == project_id)
        .map(|project| project.root_path.clone())
        .or_else(|| {
            if stored.active_project_id.as_deref() == Some(project_id.as_str()) {
                stored.active_project_root_path.clone()
            } else {
                None
            }
        })
        .ok_or_else(|| {
            CommandError::validation(
                "등록된 프로젝트 경로를 찾지 못했습니다. 프로젝트 추가로 Git 저장소를 다시 등록해주세요.",
            )
        })?;
    let snapshot = open_project_from_path(
        Path::new(&root_path),
        &state,
        &app,
        reconcile_stale_runs.unwrap_or(false),
    )?;
    remember_project(&app, &snapshot.project)?;
    Ok(snapshot)
}

#[tauri::command]
fn forget_project(
    project_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> CommandResult<LaunchState> {
    let mut stored = load_stored_launch_state(&app)?;
    let removed_root = stored
        .recent_projects
        .iter()
        .find(|project| project.id == project_id)
        .map(|project| project.root_path.clone());
    stored
        .recent_projects
        .retain(|project| project.id != project_id);

    let active_removed = stored.active_project_id.as_deref() == Some(project_id.as_str())
        || removed_root
            .as_deref()
            .map(|root| stored.active_project_root_path.as_deref() == Some(root))
            .unwrap_or(false);

    if active_removed {
        stored.active_project_id = None;
        stored.active_project_root_path = None;
    }
    stored.updated_at = Some(db::now());
    save_stored_launch_state(&app, &stored)?;

    state
        .projects
        .lock()
        .map_err(|_| CommandError::new("IoFailed", "프로젝트 상태를 갱신하지 못했습니다."))?
        .remove(&project_id);
    stop_project_queue_worker(&state, &project_id);
    stop_project_role_pty_sessions(&state, &project_id);

    Ok(LaunchState {
        recent_projects: stored.recent_projects,
        active_project_id: stored.active_project_id,
        active_project_root_path: stored.active_project_root_path,
        snapshot: None,
        restore_error: None,
    })
}

#[tauri::command]
fn get_launch_state(state: State<'_, AppState>, app: AppHandle) -> CommandResult<LaunchState> {
    let mut stored = load_stored_launch_state(&app)?;
    let restore_root = stored.active_project_root_path.clone().or_else(|| {
        stored
            .recent_projects
            .first()
            .map(|project| project.root_path.clone())
    });

    let mut snapshot = None;
    let mut restore_error = None;

    if let Some(root_path) = restore_root {
        match open_project_from_path(Path::new(&root_path), &state, &app, true) {
            Ok(next) => {
                remember_project(&app, &next.project)?;
                stored = load_stored_launch_state(&app)?;
                snapshot = Some(next);
            }
            Err(err) => {
                restore_error = Some(err);
            }
        }
    }

    Ok(LaunchState {
        recent_projects: stored.recent_projects,
        active_project_id: stored.active_project_id,
        active_project_root_path: stored.active_project_root_path,
        snapshot,
        restore_error,
    })
}

#[tauri::command]
fn get_app_settings(app: AppHandle) -> CommandResult<AppSettings> {
    load_app_settings(&app)
}

#[tauri::command]
fn update_app_settings(
    settings: AppSettings,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<AppSettings> {
    let settings = normalize_app_settings(settings);
    save_app_settings(&app, &settings)?;
    sync_app_settings_to_recent_projects(&app, &state, &settings)?;
    Ok(settings)
}

#[tauri::command]
fn get_project_snapshot(
    project_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> CommandResult<ProjectSnapshot> {
    let context = match project_context(&state, &project_id) {
        Ok(context) => context,
        Err(err) if err.code == "ProjectNotOpen" => {
            let stored = load_stored_launch_state(&app)?;
            let root_path = stored
                .recent_projects
                .iter()
                .find(|project| project.id == project_id)
                .map(|project| project.root_path.clone())
                .or_else(|| {
                    if stored.active_project_id.as_deref() == Some(project_id.as_str()) {
                        stored.active_project_root_path.clone()
                    } else {
                        None
                    }
                })
                .ok_or(err)?;
            open_project_from_path(Path::new(&root_path), &state, &app, false)?;
            project_context(&state, &project_id)?
        }
        Err(err) => return Err(err),
    };
    let conn = db::open_existing_db(&context.db_path)?;
    let project = db::get_project(&conn, &project_id)?;
    project_snapshot(&conn, &context.root_path, project)
}

#[tauri::command]
fn list_control_tower_projects(
    limit: Option<i64>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> CommandResult<Vec<ControlTowerProjectSummary>> {
    let stored = load_stored_launch_state(&app)?;
    let run_limit = limit.unwrap_or(80);
    let mut summaries = Vec::new();

    for recent in stored.recent_projects {
        match open_project_from_path(Path::new(&recent.root_path), &state, &app, false) {
            Ok(snapshot) => {
                let runs = match project_context(&state, &snapshot.project.id)
                    .and_then(|context| db::open_existing_db(&context.db_path))
                    .and_then(|conn| db::list_project_runs(&conn, &snapshot.project.id, run_limit))
                {
                    Ok(runs) => runs,
                    Err(error) => {
                        summaries.push(ControlTowerProjectSummary {
                            recent,
                            snapshot: Some(snapshot),
                            runs: Vec::new(),
                            error: Some(error),
                        });
                        continue;
                    }
                };
                summaries.push(ControlTowerProjectSummary {
                    recent,
                    snapshot: Some(snapshot),
                    runs,
                    error: None,
                });
            }
            Err(error) => summaries.push(ControlTowerProjectSummary {
                recent,
                snapshot: None,
                runs: Vec::new(),
                error: Some(error),
            }),
        }
    }

    Ok(summaries)
}

#[tauri::command]
fn get_effective_settings(
    project_id: String,
    state: State<'_, AppState>,
) -> CommandResult<EffectiveSettings> {
    let context = project_context(&state, &project_id)?;
    let conn = db::open_existing_db(&context.db_path)?;
    db::effective_settings(&conn, &project_id)
}

#[tauri::command]
fn update_project_settings(
    project_id: String,
    patch: ProjectSettingsPatch,
    state: State<'_, AppState>,
) -> CommandResult<EffectiveSettings> {
    let context = project_context(&state, &project_id)?;
    let conn = db::open_existing_db(&context.db_path)?;
    db::update_settings(&conn, &project_id, patch)
}

#[tauri::command]
async fn run_planner_conversation(
    project_id: String,
    input: PlannerConversationInput,
    state: State<'_, AppState>,
) -> CommandResult<PlannerConversationResult> {
    let context = project_context(&state, &project_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        run_planner_conversation_blocking(project_id, input, context)
    })
    .await
    .map_err(|err| CommandError::io("planner 작업 thread가 중단되었습니다.", err))?
}

fn run_planner_conversation_blocking(
    project_id: String,
    input: PlannerConversationInput,
    context: ProjectContext,
) -> CommandResult<PlannerConversationResult> {
    let conn = db::open_existing_db(&context.db_path)?;
    let settings = db::effective_settings(&conn, &project_id)?;
    let prompt = build_planner_prompt(&context.root_path, &input);
    let commands = resolve_planning_commands(&settings, &context.root_path, &input, "planner", &prompt)?;
    run_planning_commands(&context.root_path, commands)
}

#[tauri::command]
async fn run_planner_consultation(
    project_id: String,
    input: PlannerConversationInput,
    state: State<'_, AppState>,
) -> CommandResult<Vec<PlannerConversationResult>> {
    let context = project_context(&state, &project_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        run_planner_consultation_blocking(project_id, input, context)
    })
    .await
    .map_err(|err| CommandError::io("planner 협의 thread가 중단되었습니다.", err))?
}

fn run_planner_consultation_blocking(
    project_id: String,
    input: PlannerConversationInput,
    context: ProjectContext,
) -> CommandResult<Vec<PlannerConversationResult>> {
    let conn = db::open_existing_db(&context.db_path)?;
    let settings = db::effective_settings(&conn, &project_id)?;
    let prompt = build_planner_prompt(&context.root_path, &input);

    // 협의 대상 모델은 plan_verifier(계획 검토자) 역할 배정을 그대로 따른다 — 고정값 없음.
    let selections = settings
        .role_assignments
        .as_array()
        .and_then(|items| {
            items
                .iter()
                .find(|item| item.get("roleId").and_then(Value::as_str) == Some("plan_verifier"))
        })
        .map(assignment_selections)
        .unwrap_or_default();
    if selections.is_empty() {
        return Err(CommandError::validation(
            "계획 검토자(plan_verifier) 역할에 배정된 AI 연결이 없습니다. 설정에서 모델을 배정하세요.",
        ));
    }

    let mut results = Vec::new();
    let mut seen = HashSet::new();
    let mut failures = Vec::new();
    for selection in &selections {
        let Some(connection_id) = selection.get("connectionId").and_then(Value::as_str) else {
            continue;
        };
        if connection_id.is_empty() || !seen.insert(connection_id.to_string()) {
            continue;
        }
        let Some(connection) = settings.ai_connections.as_array().and_then(|items| {
            items
                .iter()
                .find(|item| item.get("id").and_then(Value::as_str) == Some(connection_id))
        }) else {
            failures.push(format!("{connection_id}: AI CLI 연결을 찾을 수 없습니다."));
            continue;
        };
        match resolve_planning_command_for_connection(
            &context.root_path,
            &input,
            &prompt,
            selection,
            connection,
        ) {
            Ok(command) => results.push(run_single_planning_command(&context.root_path, command)),
            Err(error) => {
                failures.push(format!("{connection_id}: {}", command_error_summary(&error)))
            }
        }
    }

    if results.is_empty() {
        return Err(CommandError::with_details(
            "ValidationFailed",
            "실행 가능한 계획 검토자 연결이 없습니다.",
            failures.join("\n"),
        ));
    }

    Ok(results)
}

fn run_single_planning_command(
    root_path: &Path,
    command: PlanningCommandSpec,
) -> PlannerConversationResult {
    match run_direct_command_with_timeout_env(
        root_path,
        &command.command,
        Duration::from_secs(command.timeout_seconds),
        &command.env,
    ) {
        Ok(output) => planner_result_from_output(command, output),
        Err(error) => PlannerConversationResult {
            connection_id: command.connection_id,
            provider: command.provider,
            command: command.command,
            response_text: String::new(),
            stderr: command_error_summary(&error),
            exit_code: -1,
            timed_out: false,
            elapsed_ms: 0,
        },
    }
}

#[tauri::command]
async fn run_orchestrator_conversation(
    project_id: String,
    input: OrchestratorConversationInput,
    state: State<'_, AppState>,
) -> CommandResult<PlannerConversationResult> {
    let context = project_context(&state, &project_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        run_orchestrator_conversation_blocking(project_id, input, context)
    })
    .await
    .map_err(|err| CommandError::io("orchestrator 작업 thread가 중단되었습니다.", err))?
}

fn run_orchestrator_conversation_blocking(
    project_id: String,
    input: OrchestratorConversationInput,
    context: ProjectContext,
) -> CommandResult<PlannerConversationResult> {
    let conn = db::open_existing_db(&context.db_path)?;
    let settings = db::effective_settings(&conn, &project_id)?;
    let prompt = build_orchestrator_prompt(&context.root_path, &input);
    // The orchestrator borrows the planner's CLI connection by default; only the prompt and project
    // root matter because the default provider args reference {planPrompt}/{projectRoot}.
    let adapter = PlannerConversationInput {
        message: input.goal_text.clone(),
        goal_text: input.goal_text.clone(),
        current_draft_json: None,
    };
    let commands =
        resolve_planning_commands(&settings, &context.root_path, &adapter, "orchestrator", &prompt)?;
    run_planning_commands(&context.root_path, commands)
}

fn run_planning_commands(
    root_path: &Path,
    commands: Vec<PlanningCommandSpec>,
) -> CommandResult<PlannerConversationResult> {
    let mut failures = Vec::new();
    let mut last_output = None;

    for command in commands {
        match run_direct_command_with_timeout_env(
            root_path,
            &command.command,
            Duration::from_secs(command.timeout_seconds),
            &command.env,
        ) {
            Ok(output) if output.exit_code == 0 && !output.timed_out => {
                return Ok(planner_result_from_output(command, output));
            }
            Ok(output) => {
                failures.push(format_planning_attempt_failure(&command, &output));
                last_output = Some((command, output));
            }
            Err(error) => failures.push(format!(
                "{} planning command 실행 실패: {}",
                planning_command_label(&command),
                command_error_summary(&error)
            )),
        }
    }

    if let Some((command, mut output)) = last_output {
        output.stderr = append_planning_failure_details(output.stderr, &failures);
        return Ok(planner_result_from_output(command, output));
    }

    Err(CommandError::with_details(
        "IoFailed",
        "planner command를 실행하지 못했습니다.",
        failures.join("\n"),
    ))
}

#[tauri::command]
fn list_planning_sessions(
    project_id: String,
    state: State<'_, AppState>,
) -> CommandResult<Vec<PlanningSessionSummary>> {
    let context = project_context(&state, &project_id)?;
    let conn = db::open_existing_db(&context.db_path)?;
    db::list_planning_sessions(&conn, &project_id)
}

#[tauri::command]
fn create_planning_session(
    project_id: String,
    input: CreatePlanningSessionInput,
    state: State<'_, AppState>,
) -> CommandResult<PlanningSessionDetail> {
    let context = project_context(&state, &project_id)?;
    let mut conn = db::open_existing_db(&context.db_path)?;
    db::create_planning_session(&mut conn, &project_id, input)
}

#[tauri::command]
fn get_planning_session(
    project_id: String,
    session_id: String,
    state: State<'_, AppState>,
) -> CommandResult<PlanningSessionDetail> {
    let context = project_context(&state, &project_id)?;
    let conn = db::open_existing_db(&context.db_path)?;
    db::get_planning_session(&conn, &project_id, &session_id)
}

#[tauri::command]
fn save_plan_draft_revision(
    project_id: String,
    session_id: String,
    input: SavePlanDraftRevisionInput,
    state: State<'_, AppState>,
) -> CommandResult<PlanningSessionDetail> {
    let context = project_context(&state, &project_id)?;
    let mut conn = db::open_existing_db(&context.db_path)?;
    db::save_plan_draft_revision(
        &mut conn,
        &context.root_path,
        &project_id,
        &session_id,
        input,
    )
}

#[tauri::command]
fn approve_plan_draft(
    project_id: String,
    draft_id: String,
    input: DecidePlanDraftInput,
    state: State<'_, AppState>,
) -> CommandResult<PlanningSessionDetail> {
    let context = project_context(&state, &project_id)?;
    let mut conn = db::open_existing_db(&context.db_path)?;
    db::approve_plan_draft(&mut conn, &project_id, &draft_id, input)
}

#[tauri::command]
fn reject_plan_draft(
    project_id: String,
    draft_id: String,
    input: DecidePlanDraftInput,
    state: State<'_, AppState>,
) -> CommandResult<PlanningSessionDetail> {
    let context = project_context(&state, &project_id)?;
    let mut conn = db::open_existing_db(&context.db_path)?;
    db::reject_plan_draft(&mut conn, &project_id, &draft_id, input)
}

#[tauri::command]
fn materialize_plan_draft(
    project_id: String,
    draft_id: String,
    state: State<'_, AppState>,
) -> CommandResult<PlanningMaterializationSummary> {
    let context = project_context(&state, &project_id)?;
    let mut conn = db::open_existing_db(&context.db_path)?;
    db::materialize_plan_draft(&mut conn, &project_id, &draft_id)
}

#[tauri::command]
fn list_runner_templates(
    project_id: String,
    state: State<'_, AppState>,
) -> CommandResult<Vec<RunnerTemplateSummary>> {
    let _ = project_context(&state, &project_id)?;
    Ok(runner_templates()
        .into_iter()
        .map(|template| RunnerTemplateSummary {
            id: template.id.to_string(),
            label: template.label.to_string(),
            description: template.description.to_string(),
        })
        .collect())
}

#[tauri::command]
fn apply_runner_template(
    project_id: String,
    template_id: String,
    state: State<'_, AppState>,
) -> CommandResult<EffectiveSettings> {
    let context = project_context(&state, &project_id)?;
    let conn = db::open_existing_db(&context.db_path)?;
    let template = runner_templates()
        .into_iter()
        .find(|item| item.id == template_id)
        .ok_or_else(|| CommandError::validation("지원하지 않는 runner template입니다."))?;
    db::update_settings(
        &conn,
        &project_id,
        ProjectSettingsPatch {
            role_presets: Some((template.presets)()),
            ai_connections: Some((template.connections)()),
            role_assignments: Some((template.assignments)()),
            role_policies: None,
            automation_policy: None,
            conductor_config: None,
            worktree_root: None,
            worktree_setup: None,
            jira_config: None,
            obsidian_vault_path: None,
            obsidian_artifact_path: None,
            token_budget: None,
            artifact_retention_days: None,
        },
    )
}

#[tauri::command]
fn check_role_runner(
    project_id: String,
    role_id: String,
    state: State<'_, AppState>,
) -> CommandResult<RunnerCheckResult> {
    let context = project_context(&state, &project_id)?;
    let conn = db::open_existing_db(&context.db_path)?;
    let settings = db::effective_settings(&conn, &project_id)?;
    let command = role_command_for_check(&settings.role_presets, &role_id)?;
    if command.is_empty() {
        return Ok(RunnerCheckResult {
            role_id,
            available: false,
            command,
            message: "role preset에 command가 없습니다.".to_string(),
        });
    }

    let resolved_command = resolve_command_args(&context.root_path, &command);
    let check = if resolved_command
        .iter()
        .any(|part| part.contains("fixture-runner.mjs"))
    {
        Command::new(&resolved_command[0])
            .args(&resolved_command[1..])
            .arg("--health")
            .output()
    } else {
        Command::new(&resolved_command[0]).arg("--version").output()
    };

    match check {
        Ok(output) if output.status.success() => Ok(RunnerCheckResult {
            role_id,
            available: true,
            command: resolved_command,
            message: "runner command를 실행할 수 있습니다.".to_string(),
        }),
        Ok(output) => Ok(RunnerCheckResult {
            role_id,
            available: false,
            command: resolved_command,
            message: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        }),
        Err(err) => Ok(RunnerCheckResult {
            role_id,
            available: false,
            command: resolved_command,
            message: err.to_string(),
        }),
    }
}

#[tauri::command]
fn check_ai_connection(
    project_id: String,
    connection: Value,
    state: State<'_, AppState>,
) -> CommandResult<AiConnectionCheckResult> {
    let context = project_context(&state, &project_id)?;
    check_connection_with_cwd(connection, &context.root_path)
}

#[tauri::command]
fn check_orchestrator_connection(
    connection: Value,
    app: AppHandle,
) -> CommandResult<AiConnectionCheckResult> {
    let cwd = app_settings_cwd(&app)?;
    check_connection_with_cwd(connection, &cwd)
}

fn check_connection_with_cwd(
    connection: Value,
    cwd: &Path,
) -> CommandResult<AiConnectionCheckResult> {
    let connection_id = connection
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    let command = connection_command_for_check(&connection, cwd)?;
    if command.is_empty() {
        return Ok(AiConnectionCheckResult {
            connection_id,
            available: false,
            command,
            message: "AI CLI 연결에 실행 가능한 planning smoke command가 없습니다.".to_string(),
            available_models: None,
            model_refresh_message: None,
        });
    }

    let timeout = connection_check_timeout_seconds(&connection);
    let env_overrides = connection_env(&connection);
    let check = run_direct_command_with_timeout_env(
        cwd,
        &command,
        Duration::from_secs(timeout),
        &env_overrides,
    );

    match check {
        Ok(output) if output.exit_code == 0 && !output.timed_out => {
            if is_antigravity_chat_command(&command) {
                return Ok(AiConnectionCheckResult {
                    connection_id,
                    available: true,
                    command,
                    message: "Antigravity CLI chat command를 실행할 수 있습니다.".to_string(),
                    available_models: None,
                    model_refresh_message: Some(
                        "Antigravity CLI는 응답을 stdout이 아니라 IDE chat 세션에서 처리합니다."
                            .to_string(),
                    ),
                });
            }
            if !smoke_output_contains_sentinel(&output) {
                let message = command_output_message(&output);
                return Ok(AiConnectionCheckResult {
                    connection_id,
                    available: false,
                    command,
                    message: if message.is_empty() {
                        format!(
                            "AI CLI smoke prompt는 종료됐지만 확인 문구({AI_CLI_SMOKE_SENTINEL})를 받지 못했습니다."
                        )
                    } else {
                        format!(
                            "AI CLI smoke prompt는 종료됐지만 확인 문구({AI_CLI_SMOKE_SENTINEL})를 받지 못했습니다. {}",
                            ai_cli_failure_hint(connection.get("provider").and_then(Value::as_str), &message)
                        )
                    },
                    available_models: None,
                    model_refresh_message: None,
                });
            }
            let model_refresh = refresh_available_models(&connection, cwd);
            Ok(AiConnectionCheckResult {
                connection_id,
                available: true,
                command,
                message: "AI CLI smoke prompt를 실행할 수 있습니다.".to_string(),
                available_models: model_refresh.models,
                model_refresh_message: model_refresh.message,
            })
        }
        Ok(output) => {
            let message = command_output_message(&output);
            let hint =
                ai_cli_failure_hint(connection.get("provider").and_then(Value::as_str), &message);
            Ok(AiConnectionCheckResult {
                connection_id,
                available: false,
                command,
                message: if output.timed_out {
                    format!("AI CLI smoke prompt가 timeout 되었습니다. {hint}")
                } else if message.is_empty() {
                    format!(
                        "AI CLI smoke prompt가 exit code {}로 실패했습니다.",
                        output.exit_code
                    )
                } else if message.starts_with("ERROR:") {
                    message
                } else {
                    format!(
                        "AI CLI smoke prompt가 exit code {}로 실패했습니다. {hint}",
                        output.exit_code
                    )
                },
                available_models: None,
                model_refresh_message: None,
            })
        }
        Err(err) => Ok(AiConnectionCheckResult {
            connection_id,
            available: false,
            command,
            message: command_error_summary(&err),
            available_models: None,
            model_refresh_message: None,
        }),
    }
}

#[tauri::command]
fn refresh_ai_connection_models(
    project_id: String,
    connection: Value,
    state: State<'_, AppState>,
) -> CommandResult<AiModelRefreshResult> {
    let context = project_context(&state, &project_id)?;
    refresh_connection_models_with_cwd(connection, &context.root_path)
}

#[tauri::command]
fn refresh_orchestrator_connection_models(
    connection: Value,
    app: AppHandle,
) -> CommandResult<AiModelRefreshResult> {
    let cwd = app_settings_cwd(&app)?;
    refresh_connection_models_with_cwd(connection, &cwd)
}

fn refresh_connection_models_with_cwd(
    connection: Value,
    cwd: &Path,
) -> CommandResult<AiModelRefreshResult> {
    let connection_id = connection
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    let refresh = refresh_available_models(&connection, cwd);

    Ok(AiModelRefreshResult {
        connection_id,
        message: refresh
            .message
            .unwrap_or_else(|| "모델 목록 갱신 결과가 없습니다.".to_string()),
        available_models: refresh.models,
    })
}

#[tauri::command]
fn list_epics(project_id: String, state: State<'_, AppState>) -> CommandResult<Vec<EpicSummary>> {
    let context = project_context(&state, &project_id)?;
    let conn = db::open_existing_db(&context.db_path)?;
    db::list_epics(&conn, &project_id)
}

#[tauri::command]
fn create_epic(
    project_id: String,
    input: CreateEpicInput,
    state: State<'_, AppState>,
) -> CommandResult<EpicSummary> {
    let context = project_context(&state, &project_id)?;
    let mut conn = db::open_existing_db(&context.db_path)?;
    db::create_epic(&mut conn, &project_id, input)
}

#[tauri::command]
fn list_tasks(project_id: String, state: State<'_, AppState>) -> CommandResult<Vec<TaskSummary>> {
    let context = project_context(&state, &project_id)?;
    let conn = db::open_existing_db(&context.db_path)?;
    db::list_tasks(&conn, &project_id)
}

#[tauri::command]
fn create_task(
    project_id: String,
    input: CreateTaskInput,
    state: State<'_, AppState>,
) -> CommandResult<TaskSummary> {
    let context = project_context(&state, &project_id)?;
    let mut conn = db::open_existing_db(&context.db_path)?;
    db::create_task(&mut conn, &project_id, input)
}

#[tauri::command]
fn append_task_instruction(
    project_id: String,
    task_id: String,
    input: AppendTaskInstructionInput,
    state: State<'_, AppState>,
) -> CommandResult<TaskSummary> {
    let context = project_context(&state, &project_id)?;
    let mut conn = db::open_existing_db(&context.db_path)?;
    db::append_task_instruction(&mut conn, &project_id, &task_id, &input.message)
}

#[tauri::command]
fn update_task_status(
    project_id: String,
    task_id: String,
    status: String,
    status_reason: Option<String>,
    state: State<'_, AppState>,
) -> CommandResult<TaskSummary> {
    let context = project_context(&state, &project_id)?;
    let mut conn = db::open_existing_db(&context.db_path)?;
    db::update_task_status(&mut conn, &project_id, &task_id, &status, status_reason)
}

#[tauri::command]
fn approve_task_completion_with_git(
    project_id: String,
    task_id: String,
    state: State<'_, AppState>,
) -> CommandResult<TaskCompletionGitSummary> {
    let context = project_context(&state, &project_id)?;
    let mut conn = db::open_existing_db(&context.db_path)?;
    let task = db::get_task(&conn, &task_id)?;
    if task.project_id != project_id {
        return Err(CommandError::validation("대상 태스크를 찾을 수 없습니다."));
    }
    if task.status != "MergeWaiting" {
        return Err(CommandError::validation(
            "테스트를 통과해 머지 대기 상태인 태스크만 완료 승인할 수 있습니다.",
        ));
    }

    // PR이 있으면(CodeReview에서 생성됨) 사용자 트리거 머지 → Merged.
    // 머지는 GitHub 측에서 일어나고 로컬 main HEAD는 직접 건드리지 않는다.
    if let Some((_url, number)) = db::find_pr_ref(&conn, &task_id)? {
        git::merge_pull_request(Path::new(&context.root_path), number)?;
        let branch_name = db::get_task_worktree(&conn, &project_id, &task_id)?
            .map(|worktree| worktree.branch_name)
            .unwrap_or_default();
        let updated_task = db::update_task_status(
            &mut conn,
            &project_id,
            &task_id,
            "Merged",
            Some(format!("사용자 PR #{number} 머지")),
        )?;
        return Ok(TaskCompletionGitSummary {
            task: updated_task,
            branch_name,
            commit_hash: String::new(),
            pushed: false,
            pr_number: Some(number),
            merged: true,
        });
    }

    // 폴백: PR이 없으면(변경 없음 등으로 CodeReview에서 PR 미생성) 기존 commit+push → Done.
    let worktree = db::get_task_worktree(&conn, &project_id, &task_id)?
        .ok_or_else(|| CommandError::validation("완료 승인할 task worktree를 찾을 수 없습니다."))?;
    let worktree_path = Path::new(&worktree.worktree_path);
    let changed_files = git::changed_files(worktree_path)?;
    if changed_files.is_empty() {
        return Err(CommandError::validation(
            "커밋할 변경사항이 없습니다. Git 화면에서 worktree 상태를 확인해주세요.",
        ));
    }
    let branch_name = git::current_branch(worktree_path).ok_or_else(|| {
        CommandError::validation("detached HEAD 상태에서는 완료 승인 push를 실행할 수 없습니다.")
    })?;
    let commit_message = format_task_completion_commit_message(&task.title);
    git::stage_all(worktree_path)?;
    let commit_hash = git::commit_staged(worktree_path, &commit_message)?;
    git::push_branch(worktree_path, &branch_name)?;
    let updated_task = db::update_task_status(
        &mut conn,
        &project_id,
        &task_id,
        "Done",
        Some(format!(
            "작업 완료 승인: commit {} push origin/{}",
            short_commit_hash(&commit_hash),
            branch_name
        )),
    )?;

    Ok(TaskCompletionGitSummary {
        task: updated_task,
        branch_name,
        commit_hash,
        pushed: true,
        pr_number: None,
        merged: false,
    })
}

fn format_task_completion_commit_message(title: &str) -> String {
    let title = title
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string();
    if title.is_empty() {
        "feat: 작업 완료".to_string()
    } else if title.starts_with("feat:") {
        title
    } else {
        format!("feat: {title}")
    }
}

fn short_commit_hash(commit_hash: &str) -> String {
    commit_hash.chars().take(7).collect()
}

#[tauri::command]
fn delete_task(
    project_id: String,
    task_id: String,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    let context = project_context(&state, &project_id)?;
    let mut conn = db::open_existing_db(&context.db_path)?;
    // 세션 삭제는 진행 중인 run을 막지 않고 함께 정리한다: 이 앱이 구동 중인 라이브 run엔 취소
    // 플래그를 세우고, db::cancel_task_runs가 host 프로세스 그룹을 kill한 뒤 상태를 Canceled로
    // 내린다 → delete_task의 "실행 중이면 거부" 가드를 통과한다.
    let active_runs = db::list_active_runs_for_task(&conn, &project_id, &task_id)?;
    if !active_runs.is_empty() {
        if let Ok(running_runs) = state.running_runs.lock() {
            for (run_id, _) in &active_runs {
                if let Some(cancellation) = running_runs.get(run_id) {
                    cancellation.store(true, Ordering::SeqCst);
                }
            }
        }
        db::cancel_task_runs(&conn, &project_id, &task_id)?;
    }
    // worktree 정보는 DB 삭제(cascade) 전에 읽어둔다 — 삭제 후엔 task_worktrees 행이 사라진다.
    let worktree = db::get_task_worktree(&conn, &project_id, &task_id)?;
    db::delete_task(&mut conn, &project_id, &task_id)?;
    // 디스크 worktree와 로컬 branch는 FK cascade 대상이 아니다. DB 삭제가 성공한 뒤에만,
    // best-effort로 정리해 고아 worktree/브랜치가 남지 않게 한다(실패해도 삭제는 이미 확정).
    if let Some(worktree) = worktree {
        // in-place(current_branch) 모드는 worktree가 프로젝트 root를 가리킨다 — 사용자의
        // 워킹트리·현재 브랜치이므로 절대 제거/삭제하지 않는다.
        if Path::new(&worktree.worktree_path) != context.root_path {
            let _ = git::remove_worktree(&context.root_path, Path::new(&worktree.worktree_path));
            // worktree admin 엔트리가 남으면 branch -D가 "checked out"으로 거부되므로 prune 후 삭제한다.
            git::prune_worktrees(&context.root_path);
            let _ = git::delete_branch(&context.root_path, &worktree.branch_name, false);
        }
    }
    Ok(())
}

#[tauri::command]
fn get_task_worktree(
    project_id: String,
    task_id: String,
    state: State<'_, AppState>,
) -> CommandResult<Option<TaskWorktreeSummary>> {
    let context = project_context(&state, &project_id)?;
    let conn = db::open_existing_db(&context.db_path)?;
    db::get_task_worktree(&conn, &project_id, &task_id)
}

#[tauri::command]
fn ensure_task_worktree(
    project_id: String,
    task_id: String,
    state: State<'_, AppState>,
) -> CommandResult<TaskWorktreeSummary> {
    let context = project_context(&state, &project_id)?;
    let mut conn = db::open_existing_db(&context.db_path)?;
    db::ensure_task_worktree(&mut conn, &context.root_path, &project_id, &task_id)
}

#[tauri::command]
fn export_task_graph(
    project_id: String,
    force: Option<bool>,
    state: State<'_, AppState>,
) -> CommandResult<TaskGraphExportSummary> {
    let context = project_context(&state, &project_id)?;
    let conn = db::open_existing_db(&context.db_path)?;
    db::export_task_graph(
        &conn,
        &context.root_path,
        &project_id,
        force.unwrap_or(false),
    )
}

#[tauri::command]
fn export_coordination_snapshot(
    project_id: String,
    state: State<'_, AppState>,
) -> CommandResult<CoordinationExportSummary> {
    let context = project_context(&state, &project_id)?;
    let conn = db::open_existing_db(&context.db_path)?;
    db::export_coordination_snapshot(&conn, &context.root_path, &project_id)
}

#[tauri::command]
fn read_task_graph(
    project_id: String,
    state: State<'_, AppState>,
) -> CommandResult<Option<String>> {
    let context = project_context(&state, &project_id)?;
    db::read_task_graph(&context.root_path)
}

#[tauri::command]
fn check_task_graph_conflict(
    project_id: String,
    state: State<'_, AppState>,
) -> CommandResult<TaskGraphConflictSummary> {
    let context = project_context(&state, &project_id)?;
    db::check_task_graph_conflict(&context.root_path)
}

#[tauri::command]
fn open_task_graph(
    project_id: String,
    state: State<'_, AppState>,
) -> CommandResult<TaskGraphConflictSummary> {
    let context = project_context(&state, &project_id)?;
    let summary = db::check_task_graph_conflict(&context.root_path)?;
    if !summary.exists {
        return Err(CommandError::validation(
            "tasks.md가 아직 없습니다. 먼저 Task graph를 재생성해주세요.",
        ));
    }
    open_file_path(&db::task_graph_path(&context.root_path))?;
    Ok(summary)
}

#[tauri::command]
fn list_audit_logs(
    project_id: String,
    limit: Option<i64>,
    state: State<'_, AppState>,
) -> CommandResult<Vec<models::AuditLogEntry>> {
    let context = project_context(&state, &project_id)?;
    let conn = db::open_existing_db(&context.db_path)?;
    db::audit_tail(&conn, &project_id, limit.unwrap_or(30))
}

#[tauri::command]
fn get_repository_state(
    project_id: String,
    state: State<'_, AppState>,
) -> CommandResult<GitRepositoryState> {
    let context = project_context(&state, &project_id)?;
    git::repository_state(&context.root_path)
}

#[tauri::command]
fn get_local_branches(
    project_id: String,
    state: State<'_, AppState>,
) -> CommandResult<Vec<GitBranchSummary>> {
    let context = project_context(&state, &project_id)?;
    git::local_branches(&context.root_path)
}

#[tauri::command]
fn get_recent_commits(
    project_id: String,
    limit: Option<i64>,
    state: State<'_, AppState>,
) -> CommandResult<Vec<GitCommitSummary>> {
    let context = project_context(&state, &project_id)?;
    git::recent_commits(&context.root_path, limit.unwrap_or(20))
}

#[tauri::command]
fn get_changed_files(
    project_id: String,
    state: State<'_, AppState>,
) -> CommandResult<Vec<GitFileStatus>> {
    let context = project_context(&state, &project_id)?;
    git::changed_files(&context.root_path)
}

#[tauri::command]
fn list_pull_requests(
    project_id: String,
    state: State<'_, AppState>,
) -> CommandResult<Vec<PullRequestSummary>> {
    let context = project_context(&state, &project_id)?;
    git::pull_requests(&context.root_path)
}

#[tauri::command]
async fn list_all_pull_requests(app: AppHandle) -> CommandResult<Vec<PullRequestSummary>> {
    // ponytail: sequential gh calls over ≤12 recents; parallelize if it drags.
    // gh shellouts block — keep them off the UI thread so navigating to PRs doesn't freeze.
    tauri::async_runtime::spawn_blocking(move || {
        let stored = load_stored_launch_state(&app)?;
        let mut all = Vec::new();
        for project in stored.recent_projects {
            let mut pulls = git::pull_requests(Path::new(&project.root_path))?;
            for pr in &mut pulls {
                pr.project_id = project.id.clone();
                pr.project_name = project.name.clone();
            }
            all.append(&mut pulls);
        }
        Ok(all)
    })
    .await
    .map_err(|err| CommandError::io("PR 조회 thread가 중단되었습니다.", err))?
}

#[tauri::command]
async fn pull_request_detail(
    project_id: String,
    number: i64,
    state: State<'_, AppState>,
) -> CommandResult<PullRequestDetail> {
    let context = project_context(&state, &project_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        git::pull_request_detail(&context.root_path, number)
    })
    .await
    .map_err(|err| CommandError::io("PR 상세 조회 thread가 중단되었습니다.", err))?
}

#[tauri::command]
async fn pull_request_diff(
    project_id: String,
    number: i64,
    state: State<'_, AppState>,
) -> CommandResult<String> {
    let context = project_context(&state, &project_id)?;
    tauri::async_runtime::spawn_blocking(move || git::pull_request_diff(&context.root_path, number))
        .await
        .map_err(|err| CommandError::io("PR diff 조회 thread가 중단되었습니다.", err))?
}

#[tauri::command]
fn approve_pull_request(
    project_id: String,
    number: i64,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    let context = project_context(&state, &project_id)?;
    git::approve_pull_request(&context.root_path, number)
}

#[tauri::command]
fn merge_pull_request(
    project_id: String,
    number: i64,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    let context = project_context(&state, &project_id)?;
    git::merge_pull_request(&context.root_path, number)
}

#[tauri::command]
fn list_jira_issues(
    project_id: String,
    state: State<'_, AppState>,
) -> CommandResult<Vec<JiraIssueSummary>> {
    let context = project_context(&state, &project_id)?;
    let conn = db::open_existing_db(&context.db_path)?;
    let settings = db::effective_settings(&conn, &project_id)?;
    jira::list_issues(&project_id, &settings.jira_config)
}

#[tauri::command]
fn list_jira_transitions(
    project_id: String,
    issue_key: String,
    state: State<'_, AppState>,
) -> CommandResult<Vec<JiraTransition>> {
    let context = project_context(&state, &project_id)?;
    let conn = db::open_existing_db(&context.db_path)?;
    let settings = db::effective_settings(&conn, &project_id)?;
    jira::list_transitions(&project_id, &settings.jira_config, &issue_key)
}

#[tauri::command]
fn set_jira_status(
    project_id: String,
    issue_key: String,
    transition_id: String,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    let context = project_context(&state, &project_id)?;
    let conn = db::open_existing_db(&context.db_path)?;
    let settings = db::effective_settings(&conn, &project_id)?;
    jira::transition_issue(
        &project_id,
        &settings.jira_config,
        &issue_key,
        &transition_id,
    )
}

#[tauri::command]
fn set_jira_token(project_id: String, token: String) -> CommandResult<()> {
    jira::set_token(&project_id, &token)
}

#[tauri::command]
fn jira_token_status(project_id: String) -> CommandResult<bool> {
    jira::token_status(&project_id)
}

#[tauri::command]
fn set_github_app_credentials(
    project_id: String,
    connection_id: Option<String>,
    app_id: String,
    private_key: String,
) -> CommandResult<()> {
    github_app::set_credentials(&project_id, connection_id.as_deref(), &app_id, &private_key)
}

#[tauri::command]
fn github_app_credentials_status(
    project_id: String,
    connection_id: Option<String>,
) -> CommandResult<bool> {
    github_app::credentials_status(&project_id, connection_id.as_deref())
}

#[tauri::command]
fn open_external(url: String) -> CommandResult<()> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(CommandError::new(
            "InvalidUrl",
            "http(s) 링크만 열 수 있습니다.",
        ));
    }
    // ponytail: macOS `open`; the backend already depends on unix-only APIs.
    Command::new("open")
        .arg(&url)
        .spawn()
        .map_err(|err| CommandError::io("링크를 열지 못했습니다.", err))?;
    Ok(())
}

#[tauri::command]
fn get_ignored_files(
    project_id: String,
    state: State<'_, AppState>,
) -> CommandResult<Vec<GitFileStatus>> {
    let context = project_context(&state, &project_id)?;
    git::ignored_files(&context.root_path, 200)
}

#[tauri::command]
fn get_file_diff(
    project_id: String,
    path: String,
    mode: String,
    state: State<'_, AppState>,
) -> CommandResult<GitFileDiff> {
    let context = project_context(&state, &project_id)?;
    git::file_diff(&context.root_path, &path, &mode)
}

#[tauri::command]
fn get_commit_changed_files(
    project_id: String,
    commit_hash: String,
    state: State<'_, AppState>,
) -> CommandResult<Vec<GitFileStatus>> {
    let context = project_context(&state, &project_id)?;
    git::commit_changed_files(&context.root_path, &commit_hash)
}

#[tauri::command]
fn get_commit_file_diff(
    project_id: String,
    commit_hash: String,
    path: String,
    state: State<'_, AppState>,
) -> CommandResult<GitFileDiff> {
    let context = project_context(&state, &project_id)?;
    git::commit_file_diff(&context.root_path, &commit_hash, &path)
}

#[tauri::command]
fn get_task_worktree_changed_files(
    project_id: String,
    task_id: String,
    state: State<'_, AppState>,
) -> CommandResult<Vec<GitFileStatus>> {
    let context = project_context(&state, &project_id)?;
    let conn = db::open_existing_db(&context.db_path)?;
    let worktree = db::get_task_worktree(&conn, &project_id, &task_id)?
        .ok_or_else(|| CommandError::validation("태스크 worktree가 아직 준비되지 않았습니다."))?;
    git::changed_files(Path::new(&worktree.worktree_path))
}

#[tauri::command]
fn switch_git_branch(
    project_id: String,
    branch_name: String,
    state: State<'_, AppState>,
) -> CommandResult<ProjectSnapshot> {
    let branch_name = branch_name.trim();
    if branch_name.is_empty() {
        return Err(CommandError::validation("전환할 branch를 선택해주세요."));
    }

    let context = project_context(&state, &project_id)?;
    if !git::branch_exists(&context.root_path, branch_name)? {
        return Err(CommandError::validation("로컬 branch를 찾을 수 없습니다."));
    }

    git::switch_branch(&context.root_path, branch_name)?;
    let conn = db::open_existing_db(&context.db_path)?;
    let project = db::get_project(&conn, &project_id)?;
    project_snapshot(&conn, &context.root_path, project)
}

#[tauri::command]
fn delete_local_branch(
    project_id: String,
    branch_name: String,
    delete_remote: bool,
    state: State<'_, AppState>,
) -> CommandResult<Vec<GitBranchSummary>> {
    let branch_name = branch_name.trim();
    if branch_name.is_empty() {
        return Err(CommandError::validation("삭제할 branch를 선택해주세요."));
    }

    let context = project_context(&state, &project_id)?;
    git::delete_branch(&context.root_path, branch_name, delete_remote)?;
    git::local_branches(&context.root_path)
}

#[tauri::command]
fn list_node_runtimes() -> CommandResult<Vec<NodeRuntimeSummary>> {
    Ok(discover_node_runtimes())
}

#[tauri::command]
fn list_terminal_directories(
    project_id: String,
    cwd: String,
    state: State<'_, AppState>,
) -> CommandResult<Vec<TerminalDirectoryEntry>> {
    let context = project_context(&state, &project_id)?;
    let current = resolve_terminal_path(&context.root_path, &cwd, ".")?;
    let mut entries = Vec::new();

    entries.push(TerminalDirectoryEntry {
        path: context.root_path.to_string_lossy().to_string(),
        label: "프로젝트 루트".to_string(),
        kind: "projectRoot".to_string(),
    });

    if let Some(parent) = current.parent() {
        entries.push(TerminalDirectoryEntry {
            path: parent.to_string_lossy().to_string(),
            label: "↑ ..".to_string(),
            kind: "parent".to_string(),
        });
    }

    let root_path = context.root_path.to_string_lossy().to_string();
    for (path, branch) in git::list_worktrees(&context.root_path) {
        if path == root_path {
            continue; // 메인 워크트리는 이미 "프로젝트 루트"로 표시된다.
        }
        let label = branch.unwrap_or_else(|| {
            Path::new(&path)
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_else(|| path.clone())
        });
        entries.push(TerminalDirectoryEntry {
            path,
            label: format!("⎇ {label}"),
            kind: "worktree".to_string(),
        });
    }

    let mut child_dirs = fs::read_dir(&current)
        .map_err(|err| CommandError::io("디렉토리 목록을 읽지 못했습니다.", err))?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            if matches!(name.as_str(), ".git" | ".helm") {
                return None;
            }
            Some(TerminalDirectoryEntry {
                path: entry.path().to_string_lossy().to_string(),
                label: name,
                kind: "child".to_string(),
            })
        })
        .collect::<Vec<_>>();
    child_dirs.sort_by(|left, right| left.label.cmp(&right.label));
    entries.extend(child_dirs);

    Ok(entries)
}

// 에디터: 디렉토리 안의 폴더 + 파일을 함께 반환한다(터미널 목록과 달리 파일 포함).
#[tauri::command]
fn list_editor_entries(
    project_id: String,
    cwd: String,
    state: State<'_, AppState>,
) -> CommandResult<Vec<TerminalDirectoryEntry>> {
    let context = project_context(&state, &project_id)?;
    let current = resolve_terminal_path(&context.root_path, &cwd, ".")?;
    let mut entries = Vec::new();

    entries.push(TerminalDirectoryEntry {
        path: context.root_path.to_string_lossy().to_string(),
        label: "프로젝트 루트".to_string(),
        kind: "projectRoot".to_string(),
    });
    if let Some(parent) = current.parent() {
        entries.push(TerminalDirectoryEntry {
            path: parent.to_string_lossy().to_string(),
            label: "↑ ..".to_string(),
            kind: "parent".to_string(),
        });
    }

    let mut dirs = Vec::new();
    let mut files = Vec::new();
    for entry in fs::read_dir(&current)
        .map_err(|err| CommandError::io("디렉토리 목록을 읽지 못했습니다.", err))?
        .filter_map(Result::ok)
    {
        let name = entry.file_name().to_string_lossy().to_string();
        if matches!(name.as_str(), ".git" | ".helm") {
            continue;
        }
        let is_dir = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
        let item = TerminalDirectoryEntry {
            path: entry.path().to_string_lossy().to_string(),
            label: name,
            kind: if is_dir {
                "child".to_string()
            } else {
                "file".to_string()
            },
        };
        if is_dir {
            dirs.push(item);
        } else {
            files.push(item);
        }
    }
    dirs.sort_by(|left, right| left.label.cmp(&right.label));
    files.sort_by(|left, right| left.label.cmp(&right.label));
    entries.extend(dirs);
    entries.extend(files);
    Ok(entries)
}

// 프로젝트 루트 밖으로 빠져나가는 경로를 차단한다(canonicalize 후 starts_with 검사).
fn resolve_editor_file(project_root: &Path, path: &str) -> CommandResult<PathBuf> {
    let target = resolve_terminal_path(project_root, "", path)?;
    let root = project_root
        .canonicalize()
        .unwrap_or_else(|_| project_root.to_path_buf());
    if !target.starts_with(&root) {
        return Err(CommandError::validation(
            "프로젝트 폴더 밖의 파일은 열 수 없습니다.",
        ));
    }
    Ok(target)
}

#[tauri::command]
fn read_editor_file(
    project_id: String,
    path: String,
    state: State<'_, AppState>,
) -> CommandResult<String> {
    let context = project_context(&state, &project_id)?;
    let target = resolve_editor_file(&context.root_path, &path)?;
    fs::read_to_string(&target).map_err(|err| CommandError::io("파일을 읽지 못했습니다.", err))
}

#[tauri::command]
fn write_editor_file(
    project_id: String,
    path: String,
    contents: String,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    let context = project_context(&state, &project_id)?;
    let target = resolve_editor_file(&context.root_path, &path)?;
    fs::write(&target, contents).map_err(|err| CommandError::io("파일을 저장하지 못했습니다.", err))
}

#[tauri::command]
fn run_terminal_command(
    project_id: String,
    cwd: String,
    command: String,
    state: State<'_, AppState>,
) -> CommandResult<TerminalCommandResult> {
    let command = command.trim().to_string();
    if command.is_empty() {
        return Err(CommandError::validation("실행할 명령을 입력해주세요."));
    }
    let context = project_context(&state, &project_id)?;
    let cwd = resolve_terminal_path(&context.root_path, &cwd, ".")?;
    if !cwd.is_dir() {
        return Err(CommandError::validation("터미널 cwd를 찾을 수 없습니다."));
    }

    let output = run_shell_command(&cwd, &command, Duration::from_secs(600))?;
    Ok(TerminalCommandResult {
        cwd: cwd.to_string_lossy().to_string(),
        command,
        stdout: output.stdout,
        stderr: output.stderr,
        exit_code: output.exit_code,
        timed_out: output.timed_out,
    })
}

#[tauri::command]
fn resolve_terminal_cwd(
    project_id: String,
    cwd: String,
    path: String,
    state: State<'_, AppState>,
) -> CommandResult<String> {
    let context = project_context(&state, &project_id)?;
    let next = resolve_terminal_path(&context.root_path, &cwd, &path)?;
    if !next.is_dir() {
        return Err(CommandError::validation("이동할 경로를 찾을 수 없습니다."));
    }
    Ok(next.to_string_lossy().to_string())
}

#[tauri::command]
fn start_terminal_pty(
    project_id: String,
    terminal_id: String,
    cwd: String,
    cols: Option<u16>,
    rows: Option<u16>,
    node_bin_path: Option<String>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> CommandResult<String> {
    let context = project_context(&state, &project_id)?;
    let cwd = resolve_terminal_path(&context.root_path, &cwd, ".")?;
    if !cwd.is_dir() {
        return Err(CommandError::validation("터미널 cwd를 찾을 수 없습니다."));
    }
    let node_bin_path = resolve_node_bin_path(node_bin_path)?;
    let cols = cols.unwrap_or(120).max(20);
    let rows = rows.unwrap_or(32).max(4);

    if let Some((writer, session_state)) = terminal_session_handles(&state, &terminal_id)? {
        let (existing_project_id, existing_cwd, running) = {
            let session_state = session_state.lock().map_err(|_| {
                CommandError::new("IoFailed", "터미널 세션 상태를 읽지 못했습니다.")
            })?;
            (
                session_state.project_id.clone(),
                session_state.cwd.clone(),
                session_state.running,
            )
        };

        if existing_project_id != project_id {
            return Err(CommandError::validation(
                "다른 프로젝트의 터미널 세션 ID와 충돌했습니다.",
            ));
        }

        if running {
            resize_pty_writer(&writer, cols, rows)?;
        }
        update_terminal_session_size(&session_state, cols, rows)?;
        return Ok(existing_cwd);
    }

    let pty = spawn_pty_shell(
        &project_id,
        &terminal_id,
        &cwd,
        cols,
        rows,
        node_bin_path.as_deref(),
        app,
    )?;
    state
        .terminal_sessions
        .lock()
        .map_err(|_| CommandError::new("IoFailed", "터미널 세션 상태를 저장하지 못했습니다."))?
        .insert(terminal_id, pty);

    Ok(cwd.to_string_lossy().to_string())
}

#[tauri::command]
fn list_terminal_ptys(
    project_id: Option<String>,
    state: State<'_, AppState>,
) -> CommandResult<Vec<TerminalPtySummary>> {
    if let Some(project_id) = project_id.as_deref() {
        let _ = project_context(&state, project_id)?;
    }
    let sessions = state
        .terminal_sessions
        .lock()
        .map_err(|_| CommandError::new("IoFailed", "터미널 세션 상태를 읽지 못했습니다."))?;
    let mut summaries = sessions
        .values()
        .filter_map(|session| {
            let state = session.state.lock().ok()?;
            if project_id
                .as_deref()
                .is_none_or(|project_id| state.project_id == project_id)
            {
                Some(state.summary())
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    summaries.sort_by(|left, right| left.created_at.cmp(&right.created_at));
    Ok(summaries)
}

#[tauri::command]
fn get_terminal_pty_snapshot(
    terminal_id: String,
    state: State<'_, AppState>,
) -> CommandResult<Option<TerminalPtySnapshot>> {
    let session_state = {
        let sessions = state
            .terminal_sessions
            .lock()
            .map_err(|_| CommandError::new("IoFailed", "터미널 세션 상태를 읽지 못했습니다."))?;
        sessions
            .get(&terminal_id)
            .map(|session| session.state.clone())
    };
    let Some(session_state) = session_state else {
        return Ok(None);
    };
    let session_state = session_state
        .lock()
        .map_err(|_| CommandError::new("IoFailed", "터미널 세션 상태를 읽지 못했습니다."))?;
    Ok(Some(session_state.snapshot()))
}

#[tauri::command]
fn write_terminal_pty(
    terminal_id: String,
    data: String,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    let writer = {
        let sessions = state
            .terminal_sessions
            .lock()
            .map_err(|_| CommandError::new("IoFailed", "터미널 세션 상태를 읽지 못했습니다."))?;
        sessions
            .get(&terminal_id)
            .map(|session| session.writer.clone())
            .ok_or_else(|| CommandError::validation("터미널 세션을 찾을 수 없습니다."))?
    };

    let mut writer = writer
        .lock()
        .map_err(|_| CommandError::new("IoFailed", "터미널 입력 스트림을 열지 못했습니다."))?;
    writer
        .write_all(data.as_bytes())
        .map_err(|err| CommandError::io("터미널 입력 전송에 실패했습니다.", err))?;
    Ok(())
}

#[tauri::command]
fn resize_terminal_pty(
    terminal_id: String,
    cols: u16,
    rows: u16,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    let (writer, session_state) = terminal_session_handles(&state, &terminal_id)?
        .ok_or_else(|| CommandError::validation("터미널 세션을 찾을 수 없습니다."))?;
    resize_pty_writer(&writer, cols.max(20), rows.max(4))?;
    update_terminal_session_size(&session_state, cols.max(20), rows.max(4))?;
    Ok(())
}

#[tauri::command]
fn stop_terminal_pty(terminal_id: String, state: State<'_, AppState>) -> CommandResult<()> {
    stop_terminal_session(&state, &terminal_id);
    Ok(())
}

#[tauri::command]
fn list_terminal_saved_scripts(
    project_id: String,
    state: State<'_, AppState>,
) -> CommandResult<Vec<TerminalSavedScriptSummary>> {
    let context = project_context(&state, &project_id)?;
    let conn = db::open_existing_db(&context.db_path)?;
    db::list_terminal_saved_scripts(&conn, &project_id)
}

#[tauri::command]
fn save_terminal_saved_script(
    project_id: String,
    input: SaveTerminalScriptInput,
    state: State<'_, AppState>,
) -> CommandResult<TerminalSavedScriptSummary> {
    let context = project_context(&state, &project_id)?;
    let mut conn = db::open_existing_db(&context.db_path)?;
    db::save_terminal_saved_script(&mut conn, &project_id, input)
}

#[tauri::command]
fn mark_terminal_saved_script_used(
    project_id: String,
    script_id: String,
    state: State<'_, AppState>,
) -> CommandResult<TerminalSavedScriptSummary> {
    let context = project_context(&state, &project_id)?;
    let mut conn = db::open_existing_db(&context.db_path)?;
    db::mark_terminal_saved_script_used(&mut conn, &project_id, &script_id)
}

#[tauri::command]
fn delete_terminal_saved_script(
    project_id: String,
    script_id: String,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    let context = project_context(&state, &project_id)?;
    let mut conn = db::open_existing_db(&context.db_path)?;
    db::delete_terminal_saved_script(&mut conn, &project_id, &script_id)
}

#[tauri::command]
fn run_stub_role(
    project_id: String,
    task_id: String,
    role_id: String,
    state: State<'_, AppState>,
) -> CommandResult<AgentRunSummary> {
    let context = project_context(&state, &project_id)?;
    let mut conn = db::open_existing_db(&context.db_path)?;
    db::run_stub_role(
        &mut conn,
        &context.root_path,
        &project_id,
        &task_id,
        &role_id,
    )
}

#[tauri::command]
fn prepare_role_context(
    project_id: String,
    task_id: String,
    role_id: String,
    state: State<'_, AppState>,
) -> CommandResult<AgentRunSummary> {
    let context = project_context(&state, &project_id)?;
    let mut conn = db::open_existing_db(&context.db_path)?;
    db::prepare_role_context(
        &mut conn,
        &context.root_path,
        &project_id,
        &task_id,
        &role_id,
    )
}

#[tauri::command]
fn prepare_repair_context(
    project_id: String,
    repair_request_id: String,
    state: State<'_, AppState>,
) -> CommandResult<AgentRunSummary> {
    let context = project_context(&state, &project_id)?;
    let mut conn = db::open_existing_db(&context.db_path)?;
    db::prepare_repair_context(
        &mut conn,
        &context.root_path,
        &project_id,
        &repair_request_id,
    )
}

#[tauri::command]
fn start_next_role_run(
    project_id: String,
    task_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> CommandResult<AgentRunSummary> {
    let context = project_context(&state, &project_id)?;
    let mut conn = db::open_existing_db(&context.db_path)?;
    let run = db::prepare_next_role_context(&mut conn, &context.root_path, &project_id, &task_id)?;
    ensure_project_queue_worker(&app, &state, &project_id)?;
    Ok(run)
}

#[tauri::command]
fn run_host_role(
    project_id: String,
    run_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> CommandResult<AgentRunSummary> {
    let context = project_context(&state, &project_id)?;
    let mut conn = db::open_existing_db(&context.db_path)?;
    let cancellation = Arc::new(AtomicBool::new(false));
    if !register_running_run(&state, &run_id, cancellation.clone())? {
        return Err(CommandError::validation("이미 실행 중인 host run입니다."));
    }
    let mut event_sink = |event: &RunEventSummary| emit_run_event(&app, event);
    let result = db::run_host_role(
        &mut conn,
        &context.root_path,
        &project_id,
        &run_id,
        cancellation,
        Some(&mut event_sink),
    );
    if let Ok(run) = &result {
        queue_next_role_after_success(&app, &mut conn, &context, &project_id, run);
    }
    unregister_running_run(&app, &run_id);
    result
}

#[tauri::command]
fn list_role_lessons(
    project_id: String,
    status: Option<String>,
    state: State<'_, AppState>,
) -> CommandResult<Vec<db::RoleLessonSummary>> {
    let context = project_context(&state, &project_id)?;
    let conn = db::open_existing_db(&context.db_path)?;
    db::list_role_lessons(&conn, &project_id, status.as_deref())
}

fn emit_run_event(app: &AppHandle, event: &RunEventSummary) {
    let _ = app.emit("agent-run://event", event);
    if event.kind == "approval" || event.kind == "status" || event.kind == "result" {
        let _ = app.emit(
            "agent-run://updated",
            json!({
                "projectId": event.project_id,
                "taskId": event.task_id,
                "runId": event.run_id,
                "status": if event.kind == "approval" { "ApprovalPending" } else { event.message.as_str() }
            }),
        );
    }
}

fn register_running_run(
    state: &State<'_, AppState>,
    run_id: &str,
    cancellation: Arc<AtomicBool>,
) -> CommandResult<bool> {
    let mut running_runs = state
        .running_runs
        .lock()
        .map_err(|_| CommandError::new("IoFailed", "실행 상태를 갱신하지 못했습니다."))?;
    if running_runs.contains_key(run_id) {
        return Ok(false);
    }
    running_runs.insert(run_id.to_string(), cancellation);
    Ok(true)
}

fn unregister_running_run(app: &AppHandle, run_id: &str) {
    let state = app.state::<AppState>();
    if let Ok(mut running_runs) = state.running_runs.lock() {
        running_runs.remove(run_id);
    };
}

fn queue_next_role_after_success(
    app: &AppHandle,
    conn: &mut rusqlite::Connection,
    context: &ProjectContext,
    project_id: &str,
    run: &AgentRunSummary,
) {
    if run.status != "Succeeded" {
        return;
    }

    let policy = project_automation_policy(context, project_id);
    if !policy.auto_handoff_enabled {
        return;
    }

    // 작업 완료(plan_verifier 통과) 후에는 PR/리뷰를 자동 진행하지 않는다.
    // ReviewApproval(리뷰 진행 승인)은 apply_successful_role_result에서 생성되고,
    // 사용자가 승인하면 approve_approval에서 PR 생성 + 코드 리뷰어 실행을 시작한다.
    if run.role_id == "plan_verifier" {
        append_and_emit_system_run_event(
            app,
            conn,
            project_id,
            &run.task_id,
            &run.id,
            "Awaiting review approval",
            json!({ "source": "review-gate", "approvalType": "ReviewApproval" }),
        );
        return;
    }

    // code_reviewer 통과 시 그 판정을 PR 코멘트로 남긴다(best-effort).
    if run.role_id == "code_reviewer" {
        post_review_comment_to_pr(app, conn, context, project_id, run);
    }

    if run.role_id == "planner" {
        match auto_approve_plan_approval(conn, project_id, &run.task_id) {
            Ok(Some(approval_id)) => {
                let _ = app.emit(
                    "agent-run://updated",
                    json!({
                        "projectId": project_id,
                        "taskId": run.task_id,
                        "runId": run.id,
                        "status": "PlanApprovalAutoApproved",
                        "approvalId": approval_id,
                        "source": "automation-policy"
                    }),
                );
            }
            Ok(None) => {}
            Err(error) => {
                let _ = app.emit(
                    "agent-run://updated",
                    json!({
                        "projectId": project_id,
                        "taskId": run.task_id,
                        "runId": run.id,
                        "status": "PlanApprovalAutoApproveFailed",
                        "error": command_error_summary(&error)
                    }),
                );
                return;
            }
        }
    }

    match db::prepare_next_role_context(conn, &context.root_path, project_id, &run.task_id) {
        Ok(next_run) => {
            append_and_emit_system_run_event(
                app,
                conn,
                project_id,
                &run.task_id,
                &run.id,
                "Auto handoff queued",
                json!({
                    "source": "auto-continuation",
                    "fromRunId": run.id,
                    "fromRoleId": run.role_id,
                    "nextRunId": next_run.id,
                    "nextRoleId": next_run.role_id
                }),
            );
            let state = app.state::<AppState>();
            let _ = ensure_project_queue_worker(app, &state, project_id);
            let _ = app.emit(
                "agent-run://updated",
                json!({
                    "projectId": project_id,
                    "taskId": next_run.task_id,
                    "runId": next_run.id,
                    "status": "Queued",
                    "source": "auto-continuation"
                }),
            );
        }
        Err(error) => {
            if error.code != "ValidationFailed" {
                let _ = app.emit(
                    "agent-run://updated",
                    json!({
                        "projectId": project_id,
                        "taskId": run.task_id,
                        "runId": run.id,
                        "status": "AutoContinuationFailed",
                        "error": command_error_summary(&error)
                    }),
                );
            }
        }
    }
}

/// On entry to CodeReview, commit+push the task's feature branch and open a PR into main.
/// Best-effort: any failure is logged and swallowed so the role pipeline keeps moving.
/// NEVER pushes to main directly — push targets the feature branch, the PR only *targets* main.
fn ensure_merge_pr_for_code_review(
    app: &AppHandle,
    conn: &rusqlite::Connection,
    project_id: &str,
    task_id: &str,
    log_run_id: &str,
) {
    let log = |message: &str, payload: Value| {
        append_and_emit_system_run_event(
            app, conn, project_id, task_id, log_run_id, message, payload,
        );
    };

    let task = match db::get_task(conn, task_id) {
        Ok(task) if task.status == "CodeReview" => task,
        _ => return, // 아직 CodeReview가 아니면(게이트 보류 등) PR 만들지 않는다.
    };

    match db::find_pr_ref(conn, task_id) {
        Ok(Some(_)) => return, // 이미 PR 있음 — 멱등.
        Ok(None) => {}
        Err(error) => {
            log(
                "PR ref lookup failed",
                json!({ "error": command_error_summary(&error) }),
            );
            return;
        }
    }

    let worktree = match db::get_task_worktree(conn, project_id, task_id) {
        Ok(Some(worktree)) => worktree,
        _ => {
            log(
                "code_review.pr_skipped_no_worktree",
                json!({ "source": "pr-automation" }),
            );
            return;
        }
    };
    let worktree_path = Path::new(&worktree.worktree_path);
    let branch = match git::current_branch(worktree_path) {
        Some(branch) => branch,
        None => {
            log(
                "code_review.pr_skipped_detached_head",
                json!({ "source": "pr-automation" }),
            );
            return;
        }
    };

    match git::changed_files(worktree_path) {
        Ok(files) if files.is_empty() => {
            log(
                "code_review.pr_skipped_no_changes",
                json!({ "branch": branch }),
            );
            return;
        }
        Ok(_) => {}
        Err(error) => {
            log(
                "code_review.pr_create_failed",
                json!({ "stage": "changed_files", "error": command_error_summary(&error) }),
            );
            return;
        }
    }

    let title = format_task_completion_commit_message(&task.title);
    let task_ref = if task.description.trim().is_empty() {
        format!("Helm task `{}`", task.id)
    } else {
        format!("Helm task `{}`\n\n{}", task.id, task.description.trim())
    };
    // 저장소에 PR 템플릿이 있으면 그 구조를 본문으로 쓰고, task 정보는 위에 붙여 추적성을 유지한다.
    let body = match git::find_pr_template(worktree_path) {
        Some(template) => format!("{task_ref}\n\n---\n\n{}", template.trim_end()),
        None => task_ref,
    };

    let result = (|| -> CommandResult<String> {
        git::stage_all(worktree_path)?;
        git::commit_staged(worktree_path, &title)?;
        git::push_branch(worktree_path, &branch)?;
        git::create_pull_request(worktree_path, "main", &branch, &title, &body)
    })();

    match result {
        Ok(url) => {
            let number = parse_pr_number(&url);
            if let Some(number) = number {
                if let Err(error) = db::insert_pr_ref(conn, project_id, task_id, &url, number) {
                    log(
                        "code_review.pr_ref_save_failed",
                        json!({ "url": url, "error": command_error_summary(&error) }),
                    );
                    return;
                }
            }
            log(
                "code_review.pr_created",
                json!({ "url": url, "number": number, "base": "main", "head": branch }),
            );
        }
        Err(error) => {
            log(
                "code_review.pr_create_failed",
                json!({ "stage": "gh", "branch": branch, "error": command_error_summary(&error) }),
            );
        }
    }
}

/// After a reviewer run passes, post its verdict to the task's PR as a comment.
/// Best-effort; the internal gate (db::apply_successful_role_result) remains the source of truth.
fn post_review_comment_to_pr(
    app: &AppHandle,
    conn: &rusqlite::Connection,
    context: &ProjectContext,
    project_id: &str,
    run: &AgentRunSummary,
) {
    let (_url, number) = match db::find_pr_ref(conn, &run.task_id) {
        Ok(Some(pr)) => pr,
        _ => return, // PR이 없으면(변경 없음/생성 실패) 코멘트 대상 없음.
    };
    let root = Path::new(&context.root_path);

    let body = format!(
        "🤖 코드리뷰\n{}",
        db::build_single_run_verdict_markdown(conn, root, &run.id)
    );

    // Post under the GitHub App identity when configured; otherwise fall back to
    // the default `gh` account. Token-mint failures degrade to the fallback so a
    // misconfigured App never silently drops the review comment.
    let app_token = match github_app::installation_token(root, project_id, run.connection_id.as_deref()) {
        Ok(token) => token,
        Err(error) => {
            append_and_emit_system_run_event(
                app,
                conn,
                project_id,
                &run.task_id,
                &run.id,
                "code_review.app_token_failed",
                json!({ "number": number, "roleId": run.role_id, "error": command_error_summary(&error) }),
            );
            None
        }
    };

    if let Err(error) = git::comment_pull_request(root, number, &body, app_token.as_deref()) {
        append_and_emit_system_run_event(
            app,
            conn,
            project_id,
            &run.task_id,
            &run.id,
            "code_review.pr_comment_failed",
            json!({ "number": number, "roleId": run.role_id, "error": command_error_summary(&error) }),
        );
    }
}

/// Extract the trailing PR number from a `gh pr create` URL like `.../pull/123`.
fn parse_pr_number(url: &str) -> Option<i64> {
    url.trim_end_matches('/')
        .rsplit('/')
        .next()
        .and_then(|segment| segment.parse::<i64>().ok())
}

fn auto_approve_plan_approval(
    conn: &mut rusqlite::Connection,
    project_id: &str,
    task_id: &str,
) -> CommandResult<Option<String>> {
    let pending = db::list_approvals(conn, project_id, Some("Pending".to_string()))?
        .into_iter()
        .find(|approval| {
            approval.entity_type == "Task"
                && approval.entity_id == task_id
                && approval.approval_type == "PlanApproval"
        });
    let Some(approval) = pending else {
        return Ok(None);
    };
    db::decide_approval(
        conn,
        project_id,
        &approval.id,
        "Approved",
        "Plan Document 승인 후 테스트 완료까지 자동 진행",
    )?;
    Ok(Some(approval.id))
}

fn spawn_background_host_run(
    app: AppHandle,
    context: ProjectContext,
    project_id: String,
    task_id: String,
    run_id: String,
) {
    let cancellation = Arc::new(AtomicBool::new(false));
    let state = app.state::<AppState>();
    match register_running_run(&state, &run_id, cancellation.clone()) {
        Ok(true) => {}
        Ok(false) => return,
        Err(error) => {
            let _ = app.emit(
                "agent-run://updated",
                json!({
                    "projectId": project_id,
                    "taskId": task_id,
                    "runId": run_id,
                    "status": "AutoStartFailed",
                    "error": command_error_summary(&error)
                }),
            );
            return;
        }
    }

    std::thread::spawn(move || {
        let result = db::open_existing_db(&context.db_path).and_then(|mut conn| {
            if let Ok(run) = db::get_agent_run(&conn, &run_id) {
                if let Ok(Some(worktree)) = db::get_task_worktree(&conn, &project_id, &run.task_id)
                {
                    let state = app.state::<AppState>();
                    if let Ok(session_id) = ensure_role_pty_session(
                        &app,
                        &state,
                        &project_id,
                        &run.task_id,
                        &run.role_id,
                        Path::new(&worktree.worktree_path),
                    ) {
                        write_role_pty_input(
                            &state,
                            &session_id,
                            &format!(
                                "printf '\\n[Helm worker claimed] run={run_id} role={}\\n'\n",
                                run.role_id
                            ),
                        );
                        if let Ok(event) = db::append_system_run_event(
                            &conn,
                            &project_id,
                            &run.task_id,
                            &run_id,
                            "Role PTY session ready",
                            json!({
                                "sessionId": session_id,
                                "roleId": run.role_id,
                                "worktreePath": worktree.worktree_path
                            }),
                        ) {
                            emit_run_event(&app, &event);
                        }
                    }
                }
            }

            let mut event_sink = |event: &RunEventSummary| emit_run_event(&app, event);
            let result = db::run_host_role(
                &mut conn,
                &context.root_path,
                &project_id,
                &run_id,
                cancellation,
                Some(&mut event_sink),
            );
            if let Err(error) = &result {
                if error.code != "RunAlreadyClaimed" {
                    let _ = db::mark_host_run_launch_error(
                        &mut conn,
                        &context.root_path,
                        &project_id,
                        &run_id,
                        &command_error_summary(error),
                    );
                }
            }
            if let Ok(run) = &result {
                queue_next_role_after_success(&app, &mut conn, &context, &project_id, run);
            }
            result
        });

        unregister_running_run(&app, &run_id);

        let payload = match result {
            Ok(run) => json!({
                "projectId": project_id,
                "taskId": run.task_id,
                "runId": run.id,
                "status": run.status
            }),
            Err(error) => json!({
                "projectId": project_id,
                "taskId": task_id,
                "runId": run_id,
                "status": if error.code == "RunAlreadyClaimed" { "AlreadyClaimed" } else { "NeedsInspection" },
                "error": command_error_summary(&error)
            }),
        };
        let _ = app.emit("agent-run://updated", payload);
    });
}

fn ensure_project_queue_worker(
    app: &AppHandle,
    state: &State<'_, AppState>,
    project_id: &str,
) -> CommandResult<()> {
    let context = project_context(state, project_id)?;
    let policy = project_automation_policy(&context, project_id);
    if !policy.background_queue_worker_enabled {
        return Ok(());
    }
    let stop = Arc::new(AtomicBool::new(false));
    {
        let mut workers = state
            .queue_workers
            .lock()
            .map_err(|_| CommandError::new("IoFailed", "worker 상태를 갱신하지 못했습니다."))?;
        if workers.contains_key(project_id) {
            return Ok(());
        }
        workers.insert(project_id.to_string(), stop.clone());
    }

    let app = app.clone();
    let project_id = project_id.to_string();
    std::thread::spawn(move || run_project_queue_worker(app, context, project_id, stop));
    Ok(())
}

#[derive(Clone, Copy)]
struct AutomationPolicy {
    background_queue_worker_enabled: bool,
    supervisor_reconcile_enabled: bool,
    require_explicit_host_run: bool,
    auto_handoff_enabled: bool,
}

fn project_automation_policy(context: &ProjectContext, project_id: &str) -> AutomationPolicy {
    // Planning approval is the user's automation boundary: after a Plan Document
    // is approved, Helm may prepare/run roles until Testing passes and the task
    // reaches MergeWaiting. Merge itself remains a manual decision.
    // 기본값은 db::default_automation_policy와 동일해야 한다. 프로젝트 설정의
    // automationPolicy가 있으면 필드별로 덮어쓰고, 설정/DB 오류 시 기본값으로 fallback한다.
    let defaults = AutomationPolicy {
        background_queue_worker_enabled: true,
        supervisor_reconcile_enabled: true,
        require_explicit_host_run: false,
        auto_handoff_enabled: true,
    };
    // ponytail: 정책 읽기마다 짧은 read 커넥션을 연다. 데스크톱 규모(프로젝트 소수, 800ms 틱)
    // 에선 무시 가능. 핫해지면 AppState에 캐시.
    let Ok(conn) = db::open_existing_db(&context.db_path) else {
        return defaults;
    };
    let Ok(settings) = db::effective_settings(&conn, project_id) else {
        return defaults;
    };
    let policy = &settings.automation_policy;
    let flag = |key: &str, fallback: bool| policy.get(key).and_then(|v| v.as_bool()).unwrap_or(fallback);
    AutomationPolicy {
        background_queue_worker_enabled: flag(
            "backgroundQueueWorkerEnabled",
            defaults.background_queue_worker_enabled,
        ),
        supervisor_reconcile_enabled: flag(
            "supervisorReconcileEnabled",
            defaults.supervisor_reconcile_enabled,
        ),
        require_explicit_host_run: flag("requireExplicitHostRun", defaults.require_explicit_host_run),
        auto_handoff_enabled: flag("autoHandoffEnabled", defaults.auto_handoff_enabled),
    }
}

fn stop_project_queue_worker(state: &State<'_, AppState>, project_id: &str) {
    if let Ok(mut workers) = state.queue_workers.lock() {
        if let Some(stop) = workers.remove(project_id) {
            stop.store(true, Ordering::SeqCst);
        }
    }
}

// ponytail: 프로젝트당 동시 host run 한도. 2면 충분, 더 필요하면 SettingsScreen에 노출.
// 같은 worktree를 공유하는 run(특히 in-place 모드)은 한도와 무관하게 직렬로 묶인다.
const MAX_CONCURRENT_RUNS: i64 = 2;

fn run_project_queue_worker(
    app: AppHandle,
    context: ProjectContext,
    project_id: String,
    stop: Arc<AtomicBool>,
) {
    // ponytail: 외부 머지 감지는 gh 호출이라 매 틱(800ms)은 과하다. 20s마다만 폴링.
    let mut last_merge_poll: Option<Instant> = None;
    while !stop.load(Ordering::SeqCst) {
        if last_merge_poll
            .map(|t| t.elapsed() >= Duration::from_secs(20))
            .unwrap_or(true)
        {
            last_merge_poll = Some(Instant::now());
            if let Err(error) = reconcile_merged_prs(&app, &context, &project_id) {
                let _ = app.emit(
                    "agent-run://updated",
                    json!({
                        "projectId": project_id,
                        "status": "MergedPrReconcileFailed",
                        "error": command_error_summary(&error)
                    }),
                );
            }
        }
        let queued = db::open_existing_db(&context.db_path).and_then(|conn| {
            if db::count_running_agent_runs(&conn, &project_id)? >= MAX_CONCURRENT_RUNS {
                // 큐가 막혀 있으면, 세션 중 죽은 host run thread가 남긴 Running 좀비를 회수한다.
                let reaped = db::reap_stale_running_runs(&conn, &project_id)?;
                for run_id in &reaped {
                    let _ = app.emit(
                        "agent-run://updated",
                        json!({
                            "projectId": project_id,
                            "runId": run_id,
                            "status": "NeedsInspection",
                            "source": "stale-run-reaper"
                        }),
                    );
                }
                // 회수 후에도 한도가 차 있으면 이번 사이클은 양보한다.
                if db::count_running_agent_runs(&conn, &project_id)? >= MAX_CONCURRENT_RUNS {
                    return Ok(None);
                }
            }
            // 다음 대기 run이 이미 Running인 run과 같은 worktree(=같은 체크아웃)를 쓰면
            // 동시 실행 시 서로 덮어쓴다 — 이번 사이클은 양보한다. in-place run은 모두
            // 프로젝트 root를 공유하므로 이 규칙만으로 자동 직렬화된다.
            match db::next_queued_agent_run(&conn, &project_id)? {
                Some(run) => {
                    let candidate = db::get_task_worktree(&conn, &project_id, &run.task_id)?
                        .map(|wt| wt.worktree_path);
                    if let Some(path) = &candidate {
                        if db::running_run_worktree_paths(&conn, &project_id)?
                            .iter()
                            .any(|p| p == path)
                        {
                            return Ok(None);
                        }
                    }
                    Ok(Some(run))
                }
                None => Ok(None),
            }
        });
        match queued {
            Ok(Some(run)) => {
                if !project_automation_policy(&context, &project_id).require_explicit_host_run
                    && conductor_allows_queued_run(&app, &context, &project_id, &run)
                {
                    spawn_background_host_run(
                        app.clone(),
                        context.clone(),
                        project_id.clone(),
                        run.task_id.clone(),
                        run.id.clone(),
                    );
                }
                std::thread::sleep(Duration::from_millis(250));
            }
            Ok(None) => match project_automation_policy(&context, &project_id)
                .supervisor_reconcile_enabled
            {
                true => match reconcile_project_next_role_gap(&app, &context, &project_id) {
                    Ok(Some(_run)) => {
                        std::thread::sleep(Duration::from_millis(250));
                    }
                    Ok(None) => {
                        std::thread::sleep(Duration::from_millis(800));
                    }
                    Err(error) => {
                        let _ = app.emit(
                            "agent-run://updated",
                            json!({
                                "projectId": project_id,
                                "status": "SupervisorReconcileFailed",
                                "error": command_error_summary(&error)
                            }),
                        );
                        std::thread::sleep(Duration::from_secs(2));
                    }
                },
                false => {
                    std::thread::sleep(Duration::from_millis(800));
                }
            },
            Err(error) => {
                let _ = app.emit(
                    "agent-run://updated",
                    json!({
                        "projectId": project_id,
                        "status": "WorkerPollFailed",
                        "error": command_error_summary(&error)
                    }),
                );
                std::thread::sleep(Duration::from_secs(2));
            }
        }
    }
}

/// 외부(GitHub 웹/CLI)에서 머지된 PR을 감지해 MergeWaiting task를 Merged로 넘긴다.
/// in-app 머지 버튼은 task 상태를 갱신하지 않으므로, 이 폴링이 유일한 외부 머지 반영 경로다.
fn reconcile_merged_prs(
    app: &AppHandle,
    context: &ProjectContext,
    project_id: &str,
) -> CommandResult<()> {
    let mut conn = db::open_existing_db(&context.db_path)?;
    let awaiting = db::tasks_awaiting_merge_with_pr(&conn, project_id)?;
    if awaiting.is_empty() {
        return Ok(());
    }
    let merged = git::merged_pr_numbers(Path::new(&context.root_path));
    if merged.is_empty() {
        return Ok(());
    }
    for (task_id, number) in awaiting {
        if !merged.contains(&number) {
            continue;
        }
        db::update_task_status(
            &mut conn,
            project_id,
            &task_id,
            "Merged",
            Some(format!("PR #{number} 외부 머지 감지")),
        )?;
        let _ = app.emit(
            "agent-run://updated",
            json!({
                "projectId": project_id,
                "taskId": task_id,
                "status": "Merged",
                "source": "merged-pr-reconcile",
                "prNumber": number
            }),
        );
    }
    Ok(())
}

fn reconcile_project_next_role_gap(
    app: &AppHandle,
    context: &ProjectContext,
    project_id: &str,
) -> CommandResult<Option<AgentRunSummary>> {
    let mut conn = db::open_existing_db(&context.db_path)?;
    let run = db::reconcile_next_role_gap(&mut conn, &context.root_path, project_id)?;
    if let Some(run) = &run {
        let _ = app.emit(
            "agent-run://updated",
            json!({
                "projectId": project_id,
                "taskId": run.task_id,
                "runId": run.id,
                "status": "Queued",
                "source": "supervisor-reconcile",
                "roleId": run.role_id
            }),
        );
    }
    Ok(run)
}

fn conductor_allows_queued_run(
    app: &AppHandle,
    context: &ProjectContext,
    project_id: &str,
    run: &AgentRunSummary,
) -> bool {
    match conductor_allows_queued_run_result(app, context, project_id, run) {
        Ok(allowed) => allowed,
        Err(error) => {
            let _ = app.emit(
                "agent-run://updated",
                json!({
                    "projectId": project_id,
                    "taskId": run.task_id,
                    "runId": run.id,
                    "status": "ConductorFailedOpen",
                    "error": command_error_summary(&error)
                }),
            );
            true
        }
    }
}

fn conductor_allows_queued_run_result(
    app: &AppHandle,
    context: &ProjectContext,
    project_id: &str,
    run: &AgentRunSummary,
) -> CommandResult<bool> {
    let mut conn = db::open_existing_db(&context.db_path)?;
    let settings = db::effective_settings(&conn, project_id)?;
    let Some(orchestrator) = active_orchestrator_runtime(app, &settings)? else {
        return Ok(true);
    };
    let config = &orchestrator.config;
    let connection = &orchestrator.connection;
    let connection_id = orchestrator.connection_id.as_str();
    let connection_label = connection
        .get("label")
        .and_then(Value::as_str)
        .unwrap_or(connection_id);
    let mode = conductor_mode(config);

    append_and_emit_system_run_event(
        app,
        &conn,
        project_id,
        &run.task_id,
        &run.id,
        "Conductor selected",
        json!({
            "connectionId": connection_id,
            "label": connection_label,
            "mode": mode,
            "source": orchestrator.source,
            "roleId": run.role_id
        }),
    );

    if mode != "gate" {
        return Ok(true);
    }

    let task = db::get_task(&conn, &run.task_id)?;
    let language = load_app_settings(app)?.language;
    match run_conductor_gate(config, connection, context, run, &task, &language) {
        Ok(decision) => {
            let hold = conductor_decision_is_hold(&decision);
            append_and_emit_system_run_event(
                app,
                &conn,
                project_id,
                &run.task_id,
                &run.id,
                "Conductor decision",
                decision.clone(),
            );
            if hold {
                db::mark_host_run_launch_error(
                    &mut conn,
                    &context.root_path,
                    project_id,
                    &run.id,
                    &format!("Conductor held run: {}", conductor_reason(&decision)),
                )?;
                let _ = app.emit(
                    "agent-run://updated",
                    json!({
                        "projectId": project_id,
                        "taskId": run.task_id,
                        "runId": run.id,
                        "status": "ConductorHeld",
                        "decision": decision
                    }),
                );
                return Ok(false);
            }
            Ok(true)
        }
        Err(error) => {
            append_and_emit_system_run_event(
                app,
                &conn,
                project_id,
                &run.task_id,
                &run.id,
                "Conductor decision failed",
                json!({ "error": command_error_summary(&error) }),
            );
            db::mark_host_run_launch_error(
                &mut conn,
                &context.root_path,
                project_id,
                &run.id,
                &format!("Conductor gate failed: {}", command_error_summary(&error)),
            )?;
            let _ = app.emit(
                "agent-run://updated",
                json!({
                    "projectId": project_id,
                    "taskId": run.task_id,
                    "runId": run.id,
                    "status": "ConductorGateFailed",
                    "error": command_error_summary(&error)
                }),
            );
            Ok(false)
        }
    }
}

fn append_and_emit_system_run_event(
    app: &AppHandle,
    conn: &rusqlite::Connection,
    project_id: &str,
    task_id: &str,
    run_id: &str,
    message: &str,
    payload: Value,
) {
    if let Ok(event) =
        db::append_system_run_event(conn, project_id, task_id, run_id, message, payload)
    {
        emit_run_event(app, &event);
    }
}

struct OrchestratorRuntime {
    config: Value,
    connection: Value,
    connection_id: String,
    source: &'static str,
}

fn active_orchestrator_runtime(
    app: &AppHandle,
    project_settings: &EffectiveSettings,
) -> CommandResult<Option<OrchestratorRuntime>> {
    let app_settings = load_app_settings(app)?;
    if let Some(runtime) = global_orchestrator_runtime(&app_settings) {
        return Ok(Some(runtime));
    }
    if app_orchestrator_is_configured(&app_settings) {
        return Ok(None);
    }
    Ok(legacy_project_conductor_runtime(project_settings))
}

fn global_orchestrator_runtime(settings: &AppSettings) -> Option<OrchestratorRuntime> {
    let orchestrator = &settings.orchestrator;
    if !orchestrator.enabled {
        return None;
    }
    let connection = orchestrator.connection.as_ref()?.clone();
    if connection.get("enabled").and_then(Value::as_bool) == Some(false) {
        return None;
    }
    let connection_id = connection
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("global-orchestrator")
        .to_string();
    Some(OrchestratorRuntime {
        config: json!({
            "enabled": true,
            "connectionId": connection_id.clone(),
            "model": orchestrator.model.clone(),
            "mode": conductor_mode_from_raw(&orchestrator.mode)
        }),
        connection,
        connection_id,
        source: "global",
    })
}

fn legacy_project_conductor_runtime(settings: &EffectiveSettings) -> Option<OrchestratorRuntime> {
    let config = active_conductor_config(settings)?.clone();
    let connection_id = conductor_connection_id(&config)?.to_string();
    let connection = find_ai_connection(settings, &connection_id)?.clone();
    Some(OrchestratorRuntime {
        config,
        connection,
        connection_id,
        source: "project-legacy",
    })
}

fn app_orchestrator_is_configured(settings: &AppSettings) -> bool {
    let orchestrator = &settings.orchestrator;
    orchestrator.connection.is_some()
        || orchestrator.enabled
        || orchestrator
            .model
            .as_ref()
            .is_some_and(|value| !value.trim().is_empty())
        || conductor_mode_from_raw(&orchestrator.mode) != "observe"
}

fn active_conductor_config(settings: &EffectiveSettings) -> Option<&Value> {
    let config = settings.conductor_config.as_ref()?;
    if config.get("enabled").and_then(Value::as_bool) == Some(true) {
        Some(config)
    } else {
        None
    }
}

fn conductor_connection_id(config: &Value) -> Option<&str> {
    config
        .get("connectionId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
}

fn conductor_mode(config: &Value) -> &str {
    conductor_mode_from_raw(
        config
            .get("mode")
            .and_then(Value::as_str)
            .unwrap_or("observe"),
    )
}

fn conductor_mode_from_raw(mode: &str) -> &str {
    match mode {
        "gate" => "gate",
        _ => "observe",
    }
}

fn find_ai_connection<'a>(
    settings: &'a EffectiveSettings,
    connection_id: &str,
) -> Option<&'a Value> {
    settings.ai_connections.as_array().and_then(|items| {
        items
            .iter()
            .find(|item| item.get("id").and_then(Value::as_str) == Some(connection_id))
    })
}

fn run_conductor_gate(
    config: &Value,
    connection: &Value,
    context: &ProjectContext,
    run: &AgentRunSummary,
    task: &TaskSummary,
    language: &str,
) -> CommandResult<Value> {
    let provider = connection.get("provider").and_then(Value::as_str);
    let prompt = build_conductor_prompt(context, run, task, language);
    let mut placeholders = HashMap::new();
    placeholders.insert(
        "projectRoot".to_string(),
        context.root_path.to_string_lossy().to_string(),
    );
    placeholders.insert("planPrompt".to_string(), prompt.clone());
    placeholders.insert("message".to_string(), prompt.clone());
    placeholders.insert("goalText".to_string(), task.title.clone());
    placeholders.insert("currentDraftJson".to_string(), "null".to_string());

    let args = planning_command_args(connection, provider, &placeholders)?;
    if args.is_empty() {
        return Err(CommandError::validation(
            "지휘자 AI 연결에 planningCommandArgs가 없습니다.",
        ));
    }
    let model = config
        .get("model")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            connection
                .get("defaultModel")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
        });
    let effort = connection
        .get("defaultEffort")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty());
    let command = normalize_planning_cli_args(
        inject_planning_provider_options(args, provider, model, effort),
        provider,
    );
    let timeout = connection_check_timeout_seconds(connection).min(90);
    let env_overrides = connection_env(connection);
    let output = run_direct_command_with_timeout_env(
        &context.root_path,
        &command,
        Duration::from_secs(timeout),
        &env_overrides,
    )?;
    if output.timed_out || output.exit_code != 0 {
        return Err(CommandError::new(
            "ValidationFailed",
            &format!(
                "지휘자 AI가 exit code {}로 실패했습니다. {}",
                output.exit_code,
                command_output_message(&output)
            ),
        ));
    }
    parse_conductor_decision(&format!("{}\n{}", output.stdout, output.stderr))
}

fn build_conductor_prompt(
    context: &ProjectContext,
    run: &AgentRunSummary,
    task: &TaskSummary,
    language: &str,
) -> String {
    format!(
        r#"너는 Helm의 백그라운드 지휘자 AI다.
아래 queued run을 지금 실행해도 되는지 판단한다.
파일 수정, 명령 실행, git 작업은 하지 말고 JSON만 반환한다.

반환 JSON:
{{"decision":"run"|"hold","reason":"string","nextAction":"string"}}

reason과 nextAction은 항상 {language_name}로 작성한다.

판단 기준:
- 사용자 승인 대기나 계획 수정이 필요하면 hold.
- 실행해도 되면 run.
- 확신이 없으면 run 대신 hold.

Project:
- root: {root}

Task:
- id: {task_id}
- title: {title}
- status: {status}

Queued run:
- id: {run_id}
- role: {role_id}
"#,
        language_name = match language {
            "ko" => "한국어",
            _ => "English",
        },
        root = context.root_path.to_string_lossy(),
        task_id = task.id,
        title = task.title,
        status = task.status,
        run_id = run.id,
        role_id = run.role_id,
    )
}

fn parse_conductor_decision(text: &str) -> CommandResult<Value> {
    let trimmed = text.trim();
    let candidate = if let (Some(start), Some(end)) = (trimmed.find('{'), trimmed.rfind('}')) {
        &trimmed[start..=end]
    } else {
        trimmed
    };
    let value: Value = serde_json::from_str(candidate).map_err(|err| {
        CommandError::with_details(
            "ValidationFailed",
            "지휘자 AI 응답 JSON을 해석하지 못했습니다.",
            err,
        )
    })?;
    let decision = value
        .get("decision")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if matches!(decision, "run" | "hold") {
        Ok(value)
    } else {
        Err(CommandError::validation(
            "지휘자 AI decision은 run 또는 hold여야 합니다.",
        ))
    }
}

fn conductor_decision_is_hold(decision: &Value) -> bool {
    decision.get("decision").and_then(Value::as_str) == Some("hold")
}

fn conductor_reason(decision: &Value) -> String {
    decision
        .get("reason")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("reason 없음")
        .to_string()
}

#[tauri::command]
fn retry_host_role(
    project_id: String,
    run_id: String,
    state: State<'_, AppState>,
) -> CommandResult<AgentRunSummary> {
    let context = project_context(&state, &project_id)?;
    let mut conn = db::open_existing_db(&context.db_path)?;
    db::retry_host_role(&mut conn, &context.root_path, &project_id, &run_id)
}

#[tauri::command]
fn cancel_host_role(
    project_id: String,
    run_id: String,
    state: State<'_, AppState>,
) -> CommandResult<AgentRunSummary> {
    let context = project_context(&state, &project_id)?;
    let cancellation = {
        let running_runs = state
            .running_runs
            .lock()
            .map_err(|_| CommandError::new("IoFailed", "실행 상태를 읽지 못했습니다."))?;
        running_runs.get(&run_id).cloned()
    }
    .ok_or_else(|| CommandError::validation("실행 중인 host run을 찾을 수 없습니다."))?;
    cancellation.store(true, Ordering::SeqCst);
    let conn = db::open_existing_db(&context.db_path)?;
    let run = db::get_agent_run(&conn, &run_id)?;
    if run.project_id != project_id {
        return Err(CommandError::validation(
            "대상 실행 기록을 찾을 수 없습니다.",
        ));
    }
    Ok(run)
}

#[tauri::command]
fn list_agent_runs(
    project_id: String,
    task_id: String,
    state: State<'_, AppState>,
) -> CommandResult<Vec<AgentRunSummary>> {
    let context = project_context(&state, &project_id)?;
    let conn = db::open_existing_db(&context.db_path)?;
    db::list_agent_runs(&conn, &project_id, &task_id)
}

#[tauri::command]
fn list_project_runs(
    project_id: String,
    limit: Option<i64>,
    state: State<'_, AppState>,
) -> CommandResult<Vec<AgentRunSummary>> {
    let context = project_context(&state, &project_id)?;
    let conn = db::open_existing_db(&context.db_path)?;
    db::list_project_runs(&conn, &project_id, limit.unwrap_or(120))
}

#[tauri::command]
fn list_agent_sessions(
    project_id: String,
    limit: Option<i64>,
    state: State<'_, AppState>,
) -> CommandResult<Vec<AgentSessionSummary>> {
    let context = project_context(&state, &project_id)?;
    let conn = db::open_existing_db(&context.db_path)?;
    db::list_agent_sessions(&conn, &project_id, limit.unwrap_or(120))
}

#[tauri::command]
fn list_task_timeline(
    project_id: String,
    task_id: String,
    state: State<'_, AppState>,
) -> CommandResult<Vec<TaskTimelineEntry>> {
    let context = project_context(&state, &project_id)?;
    let conn = db::open_existing_db(&context.db_path)?;
    db::list_task_timeline(&conn, &project_id, &task_id)
}

#[tauri::command]
fn list_run_events(
    project_id: String,
    run_id: String,
    state: State<'_, AppState>,
) -> CommandResult<Vec<RunEventSummary>> {
    let context = project_context(&state, &project_id)?;
    let conn = db::open_existing_db(&context.db_path)?;
    db::list_run_events(&conn, &project_id, &run_id)
}

#[tauri::command]
fn list_conversation_messages(
    project_id: String,
    state: State<'_, AppState>,
) -> CommandResult<Vec<ConversationMessage>> {
    let context = project_context(&state, &project_id)?;
    let conn = db::open_existing_db(&context.db_path)?;
    db::list_conversation_messages(&conn, &project_id)
}

#[tauri::command]
fn clear_conversation_messages(
    project_id: String,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    let context = project_context(&state, &project_id)?;
    let conn = db::open_existing_db(&context.db_path)?;
    db::clear_conversation_messages(&conn, &project_id)
}

#[tauri::command]
fn append_conversation_message(
    project_id: String,
    role: String,
    content: String,
    source_run_id: Option<String>,
    state: State<'_, AppState>,
) -> CommandResult<Option<ConversationMessage>> {
    let context = project_context(&state, &project_id)?;
    let conn = db::open_existing_db(&context.db_path)?;
    db::append_conversation_message(
        &conn,
        &project_id,
        &role,
        &content,
        source_run_id.as_deref(),
    )
}

#[tauri::command]
fn get_agent_run(
    project_id: String,
    run_id: String,
    state: State<'_, AppState>,
) -> CommandResult<AgentRunSummary> {
    let context = project_context(&state, &project_id)?;
    let conn = db::open_existing_db(&context.db_path)?;
    let run = db::get_agent_run(&conn, &run_id)?;
    if run.project_id != project_id {
        return Err(CommandError::validation(
            "대상 실행 기록을 찾을 수 없습니다.",
        ));
    }
    Ok(run)
}

#[tauri::command]
fn read_run_artifact(
    project_id: String,
    run_id: String,
    artifact_name: String,
    state: State<'_, AppState>,
) -> CommandResult<String> {
    let context = project_context(&state, &project_id)?;
    let conn = db::open_existing_db(&context.db_path)?;
    db::read_run_artifact(
        &conn,
        &context.root_path,
        &project_id,
        &run_id,
        &artifact_name,
    )
}

#[tauri::command]
fn list_approvals(
    project_id: String,
    status: Option<String>,
    state: State<'_, AppState>,
) -> CommandResult<Vec<ApprovalSummary>> {
    let context = project_context(&state, &project_id)?;
    let conn = db::open_existing_db(&context.db_path)?;
    db::list_approvals(&conn, &project_id, status)
}

#[tauri::command]
fn approve_approval(
    project_id: String,
    approval_id: String,
    reason: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> CommandResult<ApprovalSummary> {
    let context = project_context(&state, &project_id)?;
    let mut conn = db::open_existing_db(&context.db_path)?;
    let approval = db::decide_approval(&mut conn, &project_id, &approval_id, "Approved", &reason)?;

    // 회고 학습 승인 → 회고 상태는 decide_approval이 이미 active로 전환했고, .lessons.md를 재생성한다(best-effort).
    if approval.approval_type == "RoleLesson" {
        let _ = db::refresh_role_lessons_file(
            &conn,
            &context.root_path,
            &project_id,
            &approval.entity_id,
        );
    }

    // 리뷰 진행 승인 → 이제 메인 대상 PR을 만들고 코드 리뷰어 실행을 시작한다.
    if approval.approval_type == "ReviewApproval" && approval.entity_type == "Task" {
        let log_run_id = db::list_agent_runs(&conn, &project_id, &approval.entity_id)?
            .first()
            .map(|run| run.id.clone())
            .unwrap_or_default();
        ensure_merge_pr_for_code_review(&app, &conn, &project_id, &approval.entity_id, &log_run_id);
        // 코드 리뷰어 run 큐잉(best-effort): 실패해도 reconcile 워커가 다시 시도한다.
        let _ = db::prepare_next_role_context(
            &mut conn,
            &context.root_path,
            &project_id,
            &approval.entity_id,
        );
        let _ = ensure_project_queue_worker(&app, &state, &project_id);
    }

    Ok(approval)
}

#[tauri::command]
fn reject_approval(
    project_id: String,
    approval_id: String,
    reason: String,
    state: State<'_, AppState>,
) -> CommandResult<ApprovalSummary> {
    let context = project_context(&state, &project_id)?;
    let mut conn = db::open_existing_db(&context.db_path)?;
    let approval = db::decide_approval(&mut conn, &project_id, &approval_id, "Rejected", &reason)?;

    // 회고 학습 반려 → decide_approval이 disabled로 전환했고, .lessons.md를 재생성한다(best-effort).
    if approval.approval_type == "RoleLesson" {
        let _ = db::refresh_role_lessons_file(
            &conn,
            &context.root_path,
            &project_id,
            &approval.entity_id,
        );
    }

    Ok(approval)
}

fn open_project_from_path(
    path: &Path,
    state: &State<'_, AppState>,
    app: &AppHandle,
    reconcile_stale_runs: bool,
) -> CommandResult<ProjectSnapshot> {
    let root = git::resolve_git_root(path)?;
    let conn = db::open_project_db(&root)?;
    let project = db::upsert_project(&conn, &root)?;
    let reattach_run_ids = if reconcile_stale_runs {
        db::reconcile_interrupted_runs(&conn, &project.id)?
    } else {
        Vec::new()
    };
    register_project_context(state, &project.id, &root)?;
    // 프로젝트를 열면(개별 열기·전체 보드 모두 이 경로를 거친다) 큐 워커를 띄워,
    // 재시작 후에도 Queued run이 claim 없이 "대기 중"으로 멈춰 있지 않게 한다.
    let _ = ensure_project_queue_worker(app, state, &project.id);
    // 재시작 후에도 살아남은 detached host run을 백그라운드에서 재연결한다.
    for run_id in reattach_run_ids {
        if let Ok(context) = project_context(state, &project.id) {
            spawn_reattach_host_run(app.clone(), context, project.id.clone(), run_id);
        }
    }
    project_snapshot(&conn, &root, project)
}

/// 재시작 시 reconcile가 "아직 살아있다"고 판단한 host run에 백그라운드로 재연결한다.
fn spawn_reattach_host_run(
    app: AppHandle,
    context: ProjectContext,
    project_id: String,
    run_id: String,
) {
    let cancellation = Arc::new(AtomicBool::new(false));
    let state = app.state::<AppState>();
    match register_running_run(&state, &run_id, cancellation.clone()) {
        Ok(true) => {}
        // 이미 추적 중이면 중복 재연결하지 않는다.
        Ok(false) => return,
        Err(_) => return,
    }

    std::thread::spawn(move || {
        let result = db::open_existing_db(&context.db_path).and_then(|mut conn| {
            let mut event_sink = |event: &RunEventSummary| emit_run_event(&app, event);
            let result = db::reattach_host_run(
                &mut conn,
                &context.root_path,
                &project_id,
                &run_id,
                cancellation,
                Some(&mut event_sink),
            );
            if let Ok(run) = &result {
                queue_next_role_after_success(&app, &mut conn, &context, &project_id, run);
            }
            result
        });

        unregister_running_run(&app, &run_id);

        let payload = match result {
            Ok(run) => json!({
                "projectId": project_id,
                "taskId": run.task_id,
                "runId": run.id,
                "status": run.status
            }),
            Err(error) => json!({
                "projectId": project_id,
                "runId": run_id,
                "status": "NeedsInspection",
                "error": command_error_summary(&error)
            }),
        };
        let _ = app.emit("agent-run://updated", payload);
    });
}

fn register_project_context(
    state: &State<'_, AppState>,
    project_id: &str,
    root: &Path,
) -> CommandResult<()> {
    let mut projects = state
        .projects
        .lock()
        .map_err(|_| CommandError::new("IoFailed", "프로젝트 상태를 갱신하지 못했습니다."))?;
    projects.insert(
        project_id.to_string(),
        ProjectContext {
            root_path: root.to_path_buf(),
            db_path: root.join(".helm").join("helm.sqlite"),
        },
    );
    Ok(())
}

fn remember_project(app: &AppHandle, project: &ProjectSummary) -> CommandResult<()> {
    let mut stored = load_stored_launch_state(app)?;
    stored
        .recent_projects
        .retain(|item| item.id != project.id && item.root_path != project.root_path);
    stored.recent_projects.insert(
        0,
        StoredRecentProject {
            id: project.id.clone(),
            name: project.name.clone(),
            root_path: project.root_path.clone(),
            last_opened_at: chrono::Utc::now().timestamp_millis(),
        },
    );
    stored.recent_projects.truncate(MAX_RECENT_PROJECTS);
    stored.active_project_id = Some(project.id.clone());
    stored.active_project_root_path = Some(project.root_path.clone());
    stored.updated_at = Some(db::now());
    save_stored_launch_state(app, &stored)
}

fn load_stored_launch_state(app: &AppHandle) -> CommandResult<StoredLaunchState> {
    let path = launch_state_path(app)?;
    if !path.exists() {
        return Ok(StoredLaunchState::default());
    }
    let raw = fs::read_to_string(&path)
        .map_err(|err| CommandError::io("프로젝트 복원 정보를 읽지 못했습니다.", err))?;
    Ok(serde_json::from_str(&raw).unwrap_or_default())
}

fn save_stored_launch_state(app: &AppHandle, stored: &StoredLaunchState) -> CommandResult<()> {
    let path = launch_state_path(app)?;
    let raw = serde_json::to_string_pretty(stored)
        .map_err(|err| CommandError::io("프로젝트 복원 정보를 만들지 못했습니다.", err))?;
    fs::write(path, format!("{raw}\n"))
        .map_err(|err| CommandError::io("프로젝트 복원 정보를 저장하지 못했습니다.", err))
}

fn launch_state_path(app: &AppHandle) -> CommandResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|err| CommandError::io("Helm 전역 상태 경로를 찾지 못했습니다.", err))?;
    fs::create_dir_all(&dir)
        .map_err(|err| CommandError::io("Helm 전역 상태 폴더를 만들지 못했습니다.", err))?;
    Ok(dir.join("launch-state.json"))
}

fn load_app_settings(app: &AppHandle) -> CommandResult<AppSettings> {
    let path = app_settings_path(app)?;
    if !path.exists() {
        return Ok(default_app_settings());
    }
    let raw = fs::read_to_string(&path)
        .map_err(|err| CommandError::io("Helm 전역 설정을 읽지 못했습니다.", err))?;
    let parsed = serde_json::from_str(&raw).unwrap_or_else(|_| default_app_settings());
    Ok(normalize_app_settings(parsed))
}

fn save_app_settings(app: &AppHandle, settings: &AppSettings) -> CommandResult<()> {
    let path = app_settings_path(app)?;
    let raw = serde_json::to_string_pretty(settings)
        .map_err(|err| CommandError::io("Helm 전역 설정을 만들지 못했습니다.", err))?;
    fs::write(path, format!("{raw}\n"))
        .map_err(|err| CommandError::io("Helm 전역 설정을 저장하지 못했습니다.", err))
}

fn app_settings_path(app: &AppHandle) -> CommandResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|err| CommandError::io("Helm 전역 상태 경로를 찾지 못했습니다.", err))?;
    fs::create_dir_all(&dir)
        .map_err(|err| CommandError::io("Helm 전역 상태 폴더를 만들지 못했습니다.", err))?;
    Ok(dir.join("app-settings.json"))
}

fn app_settings_cwd(app: &AppHandle) -> CommandResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|err| CommandError::io("Helm 전역 상태 경로를 찾지 못했습니다.", err))?;
    fs::create_dir_all(&dir)
        .map_err(|err| CommandError::io("Helm 전역 상태 폴더를 만들지 못했습니다.", err))?;
    Ok(dir)
}

fn default_app_settings() -> AppSettings {
    AppSettings {
        version: 1,
        language: "en".to_string(),
        orchestrator: OrchestratorSettings {
            enabled: false,
            mode: "observe".to_string(),
            connection: None,
            model: None,
        },
        role_presets: default_global_role_presets(),
        ai_connections: json!([]),
        role_assignments: default_global_role_assignments(),
        role_policies: default_global_role_policies(),
        conductor_config: None,
        worktree_root: None,
        worktree_setup: None,
        jira_config: None,
        obsidian_vault_path: default_global_obsidian_vault_path(),
        obsidian_artifact_path: None,
        token_budget: None,
        artifact_retention_days: Some(30),
    }
}

fn normalize_app_settings(mut settings: AppSettings) -> AppSettings {
    settings.version = 1;
    settings.language = match settings.language.as_str() {
        "ko" => "ko".to_string(),
        _ => "en".to_string(),
    };
    settings.orchestrator.mode = match settings.orchestrator.mode.as_str() {
        "gate" => "gate".to_string(),
        _ => "observe".to_string(),
    };
    settings.orchestrator.model = settings
        .orchestrator
        .model
        .and_then(|value| non_empty_string(&value));
    if settings.role_presets.is_null() {
        settings.role_presets = default_global_role_presets();
    }
    if settings.ai_connections.is_null() {
        settings.ai_connections = json!([]);
    }
    if settings.role_assignments.is_null() {
        settings.role_assignments = default_global_role_assignments();
    }
    if settings.role_policies.is_null() {
        settings.role_policies = default_global_role_policies();
    }
    settings.worktree_root = settings
        .worktree_root
        .and_then(|value| non_empty_string(&value));
    settings.obsidian_vault_path = settings
        .obsidian_vault_path
        .and_then(|value| non_empty_string(&value))
        .or_else(default_global_obsidian_vault_path);
    settings.obsidian_artifact_path = settings
        .obsidian_artifact_path
        .and_then(|value| non_empty_string(&value));
    settings.artifact_retention_days = settings.artifact_retention_days.or(Some(30));
    settings
}

fn sync_app_settings_to_recent_projects(
    app: &AppHandle,
    state: &State<'_, AppState>,
    settings: &AppSettings,
) -> CommandResult<()> {
    let stored = load_stored_launch_state(app)?;
    for recent in stored.recent_projects {
        let Ok(snapshot) = open_project_from_path(Path::new(&recent.root_path), state, app, false)
        else {
            continue;
        };
        let Ok(context) = project_context(state, &snapshot.project.id) else {
            continue;
        };
        let Ok(conn) = db::open_existing_db(&context.db_path) else {
            continue;
        };
        let _ = db::update_settings(
            &conn,
            &snapshot.project.id,
            project_settings_patch_from_app_settings(settings),
        );
    }
    Ok(())
}

fn project_settings_patch_from_app_settings(settings: &AppSettings) -> ProjectSettingsPatch {
    ProjectSettingsPatch {
        role_presets: Some(settings.role_presets.clone()),
        ai_connections: Some(settings.ai_connections.clone()),
        role_assignments: Some(settings.role_assignments.clone()),
        role_policies: Some(settings.role_policies.clone()),
        // AppSettings는 automation_policy를 들고 있지 않다 — 미지정으로 두면 프로젝트 설정의
        // default_automation_policy fallback이 적용된다.
        automation_policy: None,
        conductor_config: Some(settings.conductor_config.clone()),
        worktree_root: Some(settings.worktree_root.clone()),
        worktree_setup: Some(settings.worktree_setup.clone()),
        jira_config: Some(settings.jira_config.clone()),
        obsidian_vault_path: Some(settings.obsidian_vault_path.clone()),
        obsidian_artifact_path: Some(settings.obsidian_artifact_path.clone()),
        token_budget: Some(settings.token_budget),
        artifact_retention_days: Some(settings.artifact_retention_days),
    }
}

fn default_global_role_presets() -> Value {
    json!([
        { "roleId": "planner", "label": "설계자", "provider": null },
        { "roleId": "coder", "label": "구현자", "provider": null },
        { "roleId": "plan_verifier", "label": "계획 검토자", "provider": null },
        { "roleId": "code_reviewer", "label": "코드 리뷰어", "provider": null },
        { "roleId": "tester", "label": "테스트 담당자", "provider": null }
    ])
}

fn default_global_role_assignments() -> Value {
    json!([
        {
            "roleId": "planner",
            "selectionMode": "single",
            "connectionIds": [],
            "selections": [],
            "aggregationPolicy": null
        },
        {
            "roleId": "coder",
            "selectionMode": "single",
            "connectionIds": [],
            "selections": [],
            "aggregationPolicy": null
        },
        {
            "roleId": "plan_verifier",
            "selectionMode": "multiple",
            "connectionIds": [],
            "selections": [],
            "aggregationPolicy": "all_pass"
        },
        {
            "roleId": "code_reviewer",
            "selectionMode": "multiple",
            "connectionIds": [],
            "selections": [],
            "aggregationPolicy": "all_pass"
        },
        {
            "roleId": "tester",
            "selectionMode": "multiple",
            "connectionIds": [],
            "selections": [],
            "aggregationPolicy": "all_pass"
        }
    ])
}

fn default_global_role_policies() -> Value {
    json!([
        "planner",
        "coder",
        "plan_verifier",
        "code_reviewer",
        "tester"
    ]
    .into_iter()
    .map(|role_id| json!({
        "roleId": role_id,
        "path": format!(".helm/policies/{role_id}.md"),
        "enabled": false
    }))
    .collect::<Vec<_>>())
}

fn default_global_obsidian_vault_path() -> Option<String> {
    let home = env::var("HOME").ok()?;
    let path = Path::new(&home)
        .join("Documents")
        .join("Obsidian Vault")
        .join("Claude");
    path.is_dir().then(|| path.to_string_lossy().to_string())
}

fn non_empty_string(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

struct RunnerTemplate {
    id: &'static str,
    label: &'static str,
    description: &'static str,
    presets: fn() -> Value,
    connections: fn() -> Value,
    assignments: fn() -> Value,
}

struct PlanningCommandSpec {
    connection_id: String,
    provider: Option<String>,
    command: Vec<String>,
    env: Vec<(String, String)>,
    timeout_seconds: u64,
}

fn runner_templates() -> Vec<RunnerTemplate> {
    vec![
        RunnerTemplate {
            id: "fixture",
            label: "Fixture runner",
            description: "로컬 검증용 runner입니다. 실제 AI 호출 없이 artifact와 diff를 생성합니다.",
            presets: fixture_role_presets,
            connections: fixture_ai_connections,
            assignments: fixture_role_assignments,
        },
        RunnerTemplate {
            id: "codex",
            label: "Codex CLI",
            description: "설치된 codex CLI를 role runner로 사용합니다. command는 환경에 맞게 조정해야 합니다.",
            presets: codex_role_presets,
            connections: codex_ai_connections,
            assignments: codex_role_assignments,
        },
        RunnerTemplate {
            id: "claude",
            label: "Claude CLI",
            description: "설치된 claude CLI를 role runner로 사용합니다. 로컬 인증이 필요합니다.",
            presets: claude_role_presets,
            connections: claude_ai_connections,
            assignments: claude_role_assignments,
        },
        RunnerTemplate {
            id: "gemini",
            label: "Gemini CLI",
            description: "설치된 gemini CLI를 role runner로 사용합니다. 로컬 인증 또는 GEMINI_API_KEY가 필요합니다.",
            presets: gemini_role_presets,
            connections: gemini_ai_connections,
            assignments: gemini_role_assignments,
        },
    ]
}

fn fixture_runner_path() -> String {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|path| path.join("scripts").join("fixture-runner.mjs"))
        .unwrap_or_else(|| PathBuf::from("scripts/fixture-runner.mjs"))
        .to_string_lossy()
        .to_string()
}

fn fixture_role_presets() -> Value {
    let script = fixture_runner_path();
    json!(role_ids()
        .into_iter()
        .map(|(role_id, label)| json!({
            "roleId": role_id,
            "label": label,
            "provider": "fixture",
            "commandArgs": ["node", script, "--mode", "pass"],
            "timeoutSeconds": 60
        }))
        .collect::<Vec<_>>())
}

fn fixture_ai_connections() -> Value {
    let script = fixture_runner_path();
    json!([
        {
            "id": "fixture-pass",
            "label": "Fixture pass",
            "provider": "fixture",
            "commandArgs": ["node", script, "--mode", "pass"],
            "planningCommandArgs": ["node", script, "--planning"],
            "planningMode": "fixture",
            "healthCheckArgs": ["node", script],
            "timeoutSeconds": 60,
            "planningTimeoutSeconds": 60,
            "enabled": true,
            "defaultModel": null,
            "availableModels": []
        }
    ])
}

fn fixture_role_assignments() -> Value {
    assignments_for_connection("fixture-pass")
}

fn codex_role_presets() -> Value {
    json!(role_ids()
        .into_iter()
        .map(|(role_id, label)| json!({
            "roleId": role_id,
            "label": label,
            "provider": "codex",
            "commandArgs": [
                "codex",
                "exec",
                "--dangerously-bypass-approvals-and-sandbox",
                "--cd",
                "{worktreePath}",
                "--",
                "Read {contextPackPath}, follow the role contract and any Role Policy section for {roleId}, then write {summaryPath} and {resultPath} following {schemaPath}."
            ],
            "timeoutSeconds": 1800
        }))
        .collect::<Vec<_>>())
}

fn codex_ai_connections() -> Value {
    json!([
        {
            "id": "codex-local",
            "label": "Codex CLI",
            "provider": "codex",
            "commandArgs": [
                "codex",
                "exec",
                "--dangerously-bypass-approvals-and-sandbox",
                "--cd",
                "{worktreePath}",
                "--",
                "Read {contextPackPath}, follow the role contract and any Role Policy section for {roleId}, then write {summaryPath} and {resultPath} following {schemaPath}."
            ],
            "planningCommandArgs": [
                "codex",
                "exec",
                "--sandbox",
                "read-only",
                "--cd",
                "{projectRoot}",
                "--",
                "{planPrompt}"
            ],
            "planningMode": "prompt_guarded",
            "healthCheckArgs": ["codex", "--version"],
            "timeoutSeconds": 1800,
            "planningTimeoutSeconds": 600,
            "planningModel": null,
            "enabled": true,
            "defaultModel": "gpt-5.5",
            "availableModels": ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"],
            "runnerAdapter": "codex_app_server",
            "approvalPolicy": "on-request",
            "sandbox": "workspace-write"
        }
    ])
}

fn codex_role_assignments() -> Value {
    assignments_for_connection("codex-local")
}

fn claude_role_presets() -> Value {
    json!(role_ids()
        .into_iter()
        .map(|(role_id, label)| json!({
            "roleId": role_id,
            "label": label,
            "provider": "claude",
            "commandArgs": [
                "claude",
                "--permission-mode",
                "bypassPermissions",
                "-p",
                "Read {contextPackPath}, follow the role contract and any Role Policy section for {roleId}, then write {summaryPath} and {resultPath} following {schemaPath}."
            ],
            "timeoutSeconds": 1800
        }))
        .collect::<Vec<_>>())
}

fn claude_ai_connections() -> Value {
    json!([
        {
            "id": "claude-local",
            "label": "Claude CLI",
            "provider": "claude",
            "commandArgs": [
                "claude",
                "--permission-mode",
                "bypassPermissions",
                "-p",
                "Read {contextPackPath}, follow the role contract and any Role Policy section for {roleId}, then write {summaryPath} and {resultPath} following {schemaPath}."
            ],
            "planningCommandArgs": [
                "claude",
                "--permission-mode",
                "plan",
                "-p",
                "{planPrompt}"
            ],
            "planningMode": "native_plan",
            "healthCheckArgs": ["claude", "--version"],
            "timeoutSeconds": 1800,
            "planningTimeoutSeconds": 600,
            "planningModel": null,
            "enabled": true,
            "defaultModel": "sonnet",
            "availableModels": ["sonnet", "opus", "claude-sonnet-4-6", "claude-opus-4-8", "claude-haiku-4-5-20251001"],
            "defaultEffort": null
        }
    ])
}

fn claude_role_assignments() -> Value {
    assignments_for_connection("claude-local")
}

fn gemini_role_presets() -> Value {
    json!(role_ids()
        .into_iter()
        .map(|(role_id, label)| json!({
            "roleId": role_id,
            "label": label,
            "provider": "gemini",
            "commandArgs": [
                "antigravity",
                "chat",
                "--mode",
                "agent",
                "Read {contextPackPath}, follow the role contract and any Role Policy section for {roleId}, then write {summaryPath} and {resultPath} following {schemaPath}."
            ],
            "timeoutSeconds": 1800
        }))
        .collect::<Vec<_>>())
}

fn gemini_ai_connections() -> Value {
    json!([
        {
            "id": "gemini-local",
            "label": "Gemini (Antigravity CLI)",
            "provider": "gemini",
            "commandArgs": [
                "antigravity",
                "chat",
                "--mode",
                "agent",
                "Read {contextPackPath}, follow the role contract and any Role Policy section for {roleId}, then write {summaryPath} and {resultPath} following {schemaPath}."
            ],
            "planningCommandArgs": [
                "antigravity",
                "chat",
                "--mode",
                "ask",
                "{planPrompt}"
            ],
            "planningMode": "native_plan",
            "healthCheckArgs": ["antigravity", "--version"],
            "timeoutSeconds": 1800,
            "planningTimeoutSeconds": 600,
            "planningModel": null,
            "enabled": true,
            "defaultModel": null,
            "availableModels": [],
            "defaultEffort": null
        }
    ])
}

fn gemini_role_assignments() -> Value {
    assignments_for_connection("gemini-local")
}

fn assignments_for_connection(connection_id: &str) -> Value {
    json!(role_ids()
        .into_iter()
        .map(|(role_id, _)| {
            let multiple = matches!(role_id, "plan_verifier" | "code_reviewer" | "tester");
            json!({
                "roleId": role_id,
                "selectionMode": if multiple { "multiple" } else { "single" },
                "connectionIds": [connection_id],
                "selections": [{ "connectionId": connection_id, "model": null, "effort": null }],
                "aggregationPolicy": if multiple { Value::String("all_pass".to_string()) } else { Value::Null }
            })
        })
        .collect::<Vec<_>>())
}

fn role_ids() -> Vec<(&'static str, &'static str)> {
    vec![
        ("planner", "설계자"),
        ("coder", "구현자"),
        ("plan_verifier", "계획 검토자"),
        ("code_reviewer", "코드 리뷰어"),
        ("tester", "테스트 담당자"),
    ]
}

fn resolve_planning_commands(
    settings: &EffectiveSettings,
    project_root: &Path,
    input: &PlannerConversationInput,
    role_id: &str,
    prompt: &str,
) -> CommandResult<Vec<PlanningCommandSpec>> {
    let find_assignment = |id: &str| {
        settings.role_assignments.as_array().and_then(|items| {
            items
                .iter()
                .find(|item| item.get("roleId").and_then(Value::as_str) == Some(id))
        })
    };
    // The orchestrator borrows the planner's connection when it has no assignment of its own.
    let planner_assignment = find_assignment(role_id)
        .or_else(|| find_assignment("planner"))
        .ok_or_else(|| CommandError::validation("planner 역할 배정을 찾을 수 없습니다."))?;

    let mut commands = Vec::new();
    let mut seen = HashSet::new();
    let mut failures = Vec::new();

    for selection in assignment_selections(planner_assignment) {
        push_planning_command_candidate(
            settings,
            project_root,
            input,
            prompt,
            &selection,
            &mut seen,
            &mut commands,
            &mut failures,
        );
    }

    for connection in settings.ai_connections.as_array().into_iter().flatten() {
        if connection.get("enabled").and_then(Value::as_bool) == Some(false) {
            continue;
        }
        let Some(connection_id) = connection.get("id").and_then(Value::as_str) else {
            continue;
        };
        let selection = json!({ "connectionId": connection_id });
        push_planning_command_candidate(
            settings,
            project_root,
            input,
            prompt,
            &selection,
            &mut seen,
            &mut commands,
            &mut failures,
        );
    }

    if commands.is_empty() {
        let details = failures.join("\n");
        if details.is_empty() {
            return Err(CommandError::validation(
                "planner에 실행 가능한 AI CLI 연결이 없습니다.",
            ));
        }
        return Err(CommandError::with_details(
            "ValidationFailed",
            "planner에 실행 가능한 AI CLI 연결이 없습니다.",
            details,
        ));
    }

    Ok(commands)
}

fn push_planning_command_candidate(
    settings: &EffectiveSettings,
    project_root: &Path,
    input: &PlannerConversationInput,
    prompt: &str,
    selection: &Value,
    seen: &mut HashSet<String>,
    commands: &mut Vec<PlanningCommandSpec>,
    failures: &mut Vec<String>,
) {
    let connection_id = selection
        .get("connectionId")
        .and_then(Value::as_str)
        .unwrap_or("");
    if connection_id.is_empty() || !seen.insert(connection_id.to_string()) {
        return;
    }

    let Some(connection) = settings.ai_connections.as_array().and_then(|items| {
        items
            .iter()
            .find(|item| item.get("id").and_then(Value::as_str) == Some(connection_id))
    }) else {
        failures.push(format!(
            "{connection_id}: planner에 배정된 AI CLI 연결을 찾을 수 없습니다."
        ));
        return;
    };

    match resolve_planning_command_for_connection(project_root, input, prompt, selection, connection) {
        Ok(command) => commands.push(command),
        Err(error) => failures.push(format!(
            "{connection_id}: {}",
            command_error_summary(&error)
        )),
    }
}

fn resolve_planning_command_for_connection(
    project_root: &Path,
    input: &PlannerConversationInput,
    prompt: &str,
    selection: &Value,
    connection: &Value,
) -> CommandResult<PlanningCommandSpec> {
    let connection_id = selection
        .get("connectionId")
        .and_then(Value::as_str)
        .ok_or_else(|| CommandError::validation("planner 연결 id를 찾을 수 없습니다."))?;
    if connection.get("enabled").and_then(Value::as_bool) == Some(false) {
        return Err(CommandError::validation(
            "planner에 배정된 AI CLI 연결이 비활성화되어 있습니다.",
        ));
    }

    let provider = connection
        .get("provider")
        .and_then(Value::as_str)
        .map(str::to_string);
    let explicit_role_model = selection
        .get("model")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty());
    let planning_model = connection
        .get("planningModel")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty());
    let model = explicit_role_model.or(planning_model).or_else(|| {
        connection
            .get("defaultModel")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
    });
    let effort = selection
        .get("effort")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            connection
                .get("defaultEffort")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
        });
    let current_draft_json = input
        .current_draft_json
        .as_ref()
        .map(|value| serde_json::to_string_pretty(value).unwrap_or_else(|_| "null".to_string()))
        .unwrap_or_else(|| "null".to_string());
    let mut placeholders = HashMap::new();
    placeholders.insert(
        "projectRoot".to_string(),
        project_root.to_string_lossy().to_string(),
    );
    placeholders.insert("planPrompt".to_string(), prompt.to_string());
    placeholders.insert("message".to_string(), input.message.clone());
    placeholders.insert("goalText".to_string(), input.goal_text.clone());
    placeholders.insert("currentDraftJson".to_string(), current_draft_json);

    let args = planning_command_args(connection, provider.as_deref(), &placeholders)?;
    if args.is_empty() {
        return Err(CommandError::validation(
            "planner AI CLI 연결에 planning command가 없습니다.",
        ));
    }

    let timeout_seconds = connection
        .get("planningTimeoutSeconds")
        .and_then(Value::as_u64)
        .unwrap_or(600)
        .clamp(1, 600);

    let command_args = inject_planning_provider_options(args, provider.as_deref(), model, effort);
    let command = normalize_planning_cli_args(command_args, provider.as_deref());

    Ok(PlanningCommandSpec {
        connection_id: connection_id.to_string(),
        provider,
        command,
        env: connection_env(connection),
        timeout_seconds,
    })
}

fn assignment_selections(assignment: &Value) -> Vec<Value> {
    if let Some(selections) = assignment
        .get("selections")
        .and_then(Value::as_array)
        .filter(|items| !items.is_empty())
    {
        return selections.clone();
    }

    assignment
        .get("connectionIds")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(|connection_id| json!({ "connectionId": connection_id }))
                .collect()
        })
        .unwrap_or_default()
}

fn planner_result_from_output(
    command: PlanningCommandSpec,
    output: ShellOutput,
) -> PlannerConversationResult {
    PlannerConversationResult {
        connection_id: command.connection_id,
        provider: command.provider,
        command: command.command,
        response_text: output.stdout,
        stderr: output.stderr,
        exit_code: output.exit_code,
        timed_out: output.timed_out,
        elapsed_ms: output.elapsed_ms,
    }
}

fn format_planning_attempt_failure(command: &PlanningCommandSpec, output: &ShellOutput) -> String {
    let reason = if output.timed_out {
        "timeout".to_string()
    } else {
        format!("exit code {}", output.exit_code)
    };
    let stderr = output.stderr.trim();
    let stdout = output.stdout.trim();
    let detail = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        "출력 없음"
    };
    format!(
        "{} planning command 실패 ({reason}): {detail}",
        planning_command_label(command)
    )
}

fn planning_command_label(command: &PlanningCommandSpec) -> String {
    match command.provider.as_deref() {
        Some(provider) => format!("{} ({provider})", command.connection_id),
        None => command.connection_id.clone(),
    }
}

fn append_planning_failure_details(stderr: String, failures: &[String]) -> String {
    if failures.is_empty() {
        return stderr;
    }

    let details = failures.join("\n");
    if stderr.trim().is_empty() {
        return details;
    }
    format!("{}\n\nfallback attempts:\n{}", stderr.trim_end(), details)
}

fn command_error_summary(error: &CommandError) -> String {
    match &error.details {
        Some(details) if !details.trim().is_empty() => {
            format!("{}: {}", error.message, details)
        }
        _ => error.message.clone(),
    }
}

fn planning_command_args(
    connection: &Value,
    provider: Option<&str>,
    placeholders: &HashMap<String, String>,
) -> CommandResult<Vec<String>> {
    if let Some(args) = connection
        .get("planningCommandArgs")
        .and_then(Value::as_array)
    {
        return args
            .iter()
            .map(|arg| {
                arg.as_str()
                    .map(|raw| apply_planning_placeholders(raw, placeholders))
                    .ok_or_else(|| {
                        CommandError::validation("planningCommandArgs는 문자열 배열이어야 합니다.")
                    })
            })
            .collect();
    }

    if provider == Some("fixture") {
        if let Some(args) = connection.get("commandArgs").and_then(Value::as_array) {
            let parsed = string_array(args, "commandArgs는 문자열 배열이어야 합니다.")?;
            if parsed.len() >= 2 && parsed[1].contains("fixture-runner.mjs") {
                return Ok(vec![
                    parsed[0].clone(),
                    parsed[1].clone(),
                    "--planning".to_string(),
                ]);
            }
        }
    }

    match provider {
        Some("codex") => Ok(vec![
            "codex".to_string(),
            "exec".to_string(),
            "--sandbox".to_string(),
            "read-only".to_string(),
            "--cd".to_string(),
            "{projectRoot}".to_string(),
            "--".to_string(),
            "{planPrompt}".to_string(),
        ]
        .into_iter()
        .map(|arg| apply_planning_placeholders(&arg, placeholders))
        .collect()),
        Some("claude") => Ok(vec![
            "claude".to_string(),
            "--permission-mode".to_string(),
            "plan".to_string(),
            "-p".to_string(),
            "{planPrompt}".to_string(),
        ]
        .into_iter()
        .map(|arg| apply_planning_placeholders(&arg, placeholders))
        .collect()),
        Some("gemini") => Ok(vec![
            "gemini".to_string(),
            "--skip-trust".to_string(),
            "--approval-mode".to_string(),
            "plan".to_string(),
            "--prompt".to_string(),
            "{planPrompt}".to_string(),
        ]
        .into_iter()
        .map(|arg| apply_planning_placeholders(&arg, placeholders))
        .collect()),
        _ => Ok(Vec::new()),
    }
}

fn build_orchestrator_prompt(project_root: &Path, input: &OrchestratorConversationInput) -> String {
    let branch = git::current_branch(project_root).unwrap_or_else(|| "detached".to_string());
    let head = git::head_hash(project_root).unwrap_or_else(|| "unknown".to_string());
    let transcript = if input.history.is_empty() {
        "(아직 대화 없음)".to_string()
    } else {
        input
            .history
            .iter()
            .map(|turn| {
                let who = if turn.role == "assistant" {
                    "오케스트레이터"
                } else {
                    "사용자"
                };
                format!("{who}: {}", turn.content.trim())
            })
            .collect::<Vec<_>>()
            .join("\n")
    };

    format!(
        r#"너는 Helm의 orchestrator role이다. 계획자(planner)에게 작업을 넘기기 전에 사용자와 대화하며 요구사항을 확정하는 역할이다.

규칙:
- 한글로 답한다.
- 너는 계획을 세우거나 task를 만들지 않는다. 파일 수정, 명령 실행, Git 작업도 하지 않는다. 오직 요구사항을 명확히 정리한다.
- 대화 내역을 읽고, 계획자가 바로 일할 수 있을 만큼 요구사항이 충분한지 판단한다.
- 질문은 정말 중요한 것만 한다. 답에 따라 계획자가 전혀 다른 방향으로 가게 되는 갭(목표 자체가 갈리거나, 잘못 추측하면 작업을 되돌려야 하는 것)만 묻는다.
- 합리적으로 추측할 수 있거나 작업 중 자연스럽게 정해질 사소한 갭은 절대 질문하지 말고, 네가 기본값을 정해 assumptions에 적는다. 사용자는 틀린 가정만 고치면 된다.
- 그래서 막는 질문이 없으면 ready=true로 두고 questions는 빈 배열로 둔다. 애매하면 묻지 말고 ready=true + 가정으로 진행한다.
- 막는 갭이 있을 때만 ready=false로 두고, 가장 중요한 1~3개만 questions에 담는다. 사용자가 한 번에 답할 수 있도록 구체적으로 묻는다.
- requirement에는 지금까지 확정된 내용을 항상 정리해 담는다(목표 / 범위(포함) / 제외(범위 밖) / 제약 / 완료 조건). 아직 모르는 칸은 합리적 기본값으로 채우고 assumptions에 남긴다.
- Markdown fence, 머리말, 설명 문장 없이 JSON만 반환한다.

JSON schema:
{{
  "ready": false,
  "requirement": "string (markdown)",
  "questions": ["string"],
  "assumptions": ["string"]
}}

Project:
- root: {root}
- branch: {branch}
- head: {head}

대화 내역:
{transcript}
"#,
        root = project_root.to_string_lossy(),
        branch = branch,
        head = head,
        transcript = transcript,
    )
}

fn build_planner_prompt(project_root: &Path, input: &PlannerConversationInput) -> String {
    let current_draft = input
        .current_draft_json
        .as_ref()
        .map(|value| serde_json::to_string_pretty(value).unwrap_or_else(|_| "null".to_string()))
        .unwrap_or_else(|| "null".to_string());
    let branch = git::current_branch(project_root).unwrap_or_else(|| "detached".to_string());
    let head = git::head_hash(project_root).unwrap_or_else(|| "unknown".to_string());

    format!(
        r#"너는 Helm Planning 탭의 planner role이다.

규칙:
- 한글로 답한다.
- 지금은 계획 모드다. 파일 수정, 명령 실행, Git 작업, Task 생성은 하지 않는다.
- 사용자의 목표를 대화로 더 명확하게 만들고, 승인 가능한 Plan Document draft를 갱신한다.
- 정보가 부족해도 질문만 따로 쓰지 말고 아래 JSON 형태만 반환한다.
- 질문은 openQuestions 배열에 넣고, tasks에는 현재 확정 가능한 최소 실행 후보를 넣는다.
- tasks 배열은 절대 비우지 않는다. 범위가 모호하면 "범위 확정" 같은 작은 확인 Task를 1개 이상 넣는다.
- executablePlan은 반드시 채운다. taskGraph, taskCards, ownershipMap, barriers, verificationGates는 Helm이 실제 실행 가능한 계획으로 검증한다.
- 병렬 가능한 작업은 taskGraph.dependsOn을 비워 같은 batch에 놓고, 직렬 작업은 dependsOn으로 선행 Task id를 명시한다.
- 각 taskCard에는 ownedFiles, sharedFiles, generatedFiles, generatedFilePolicy, reportContract를 채운다.
- 병렬 가능한 taskCard끼리는 ownedFiles가 겹치면 안 되고, 한 task의 sharedFiles는 병렬 task의 ownedFiles에 들어가면 안 된다.
- generatedFiles가 있으면 generatedFilePolicy에 직접 수정 금지 또는 generation command 정책을 명시한다.
- reportContract는 작업자가 완료 보고에 포함해야 하는 필드를 slash로 나열한다. 기본값은 "taskId/status/changedFiles/verification/blockers"다.
- barriers에는 blocker/approval/manual decision을, verificationGates에는 실행할 명령 또는 수동 검증 기준과 필요한 evidence를 넣는다.
- UI 문구/카피 수정 목표라면 각 관련 task에 copyChanges를 넣어 사용자가 승인 전 "현재 문구 -> 제안 문구 -> 이유"를 볼 수 있게 한다.
- 문구만 수정하라는 목표는 구현 범위를 파일/화면/문구로 좁히고, 레이아웃/로직 변경을 acceptanceCriteria와 risks에서 명시적으로 제외한다.
- Markdown fence, 설명 문장, 머리말 없이 JSON만 반환한다.

JSON schema:
{{
  "title": "string",
  "summary": "string",
  "scope": ["string"],
  "tasks": [
    {{
      "title": "string",
      "description": "string",
      "subtasks": ["string"],
      "copyChanges": [
        {{
          "location": "string",
          "currentText": "string or null",
          "proposedText": "string",
          "reason": "string"
        }}
      ],
      "acceptanceCriteria": ["string"],
      "risks": ["string"],
      "testPlan": ["string"]
    }}
  ],
  "openQuestions": ["string"],
  "risks": ["string"],
  "executablePlan": {{
    "taskGraph": [
      {{
        "id": "task-1",
        "title": "string",
        "dependsOn": ["task-id"],
        "parallelizable": true,
        "batch": "string"
      }}
    ],
    "taskCards": [
      {{
        "id": "task-1",
        "title": "string",
        "ownerRole": "planner|coder|plan_verifier|code_reviewer|tester|human",
        "goal": "string",
        "inputs": ["string"],
        "outputs": ["string"],
        "ownedFiles": ["repo-relative path"],
        "sharedFiles": ["repo-relative read-only/shared path"],
        "generatedFiles": ["repo-relative generated path"],
        "generatedFilePolicy": "string",
        "reportContract": "taskId/status/changedFiles/verification/blockers",
        "acceptanceCriteria": ["string"],
        "verificationGates": ["gate-id"]
      }}
    ],
    "ownershipMap": [
      {{
        "ownerRole": "string",
        "responsibilities": ["string"],
        "artifacts": ["string"],
        "approver": "string"
      }}
    ],
    "barriers": [
      {{
        "id": "barrier-1",
        "title": "string",
        "blocks": ["task-id"],
        "condition": "string",
        "ownerRole": "string"
      }}
    ],
    "verificationGates": [
      {{
        "id": "gate-1",
        "title": "string",
        "type": "command|manual|browser|review",
        "command": "string or null",
        "requiredEvidence": ["string"]
      }}
    ]
  }}
}}

Project:
- root: {root}
- branch: {branch}
- head: {head}

Goal:
{goal}

Current Plan Draft JSON:
{current_draft}

User message:
{message}
"#,
        root = project_root.to_string_lossy(),
        branch = branch,
        head = head,
        goal = input.goal_text,
        current_draft = current_draft,
        message = input.message,
    )
}

fn apply_planning_placeholders(value: &str, placeholders: &HashMap<String, String>) -> String {
    let mut rendered = value.to_string();
    for (key, replacement) in placeholders {
        rendered = rendered.replace(&format!("{{{key}}}"), replacement);
    }
    rendered
}

fn inject_planning_provider_options(
    args: Vec<String>,
    provider: Option<&str>,
    model: Option<&str>,
    effort: Option<&str>,
) -> Vec<String> {
    let with_model = match (provider, model) {
        (Some("codex"), Some(model)) if !has_command_arg(&args, &["-m", "--model"]) => {
            insert_after_command_arg(args, "exec", ["-m".to_string(), model.to_string()])
        }
        (Some("claude"), Some(model)) if !has_command_arg(&args, &["--model"]) => {
            insert_after_arg_index(args, 0, ["--model".to_string(), model.to_string()])
        }
        (Some("gemini"), Some(model)) if !has_command_arg(&args, &["-m", "--model"]) => {
            insert_after_arg_index(args, 0, ["--model".to_string(), model.to_string()])
        }
        _ => args,
    };

    match (provider, effort) {
        (Some("claude"), Some(effort)) if !has_command_arg(&with_model, &["--effort"]) => {
            insert_after_arg_index(with_model, 0, ["--effort".to_string(), effort.to_string()])
        }
        _ => with_model,
    }
}

fn normalize_planning_cli_args(args: Vec<String>, provider: Option<&str>) -> Vec<String> {
    if provider != Some("codex") {
        return args;
    }

    let mut normalized = Vec::with_capacity(args.len());
    let mut index = 0;
    while index < args.len() {
        if args[index] == "--ask-for-approval" {
            index += 1;
            if args.get(index).is_some_and(|value| {
                matches!(
                    value.as_str(),
                    "never" | "on-request" | "on-failure" | "untrusted"
                )
            }) {
                index += 1;
            }
            continue;
        }
        normalized.push(args[index].clone());
        index += 1;
    }
    normalized
}

fn has_command_arg(args: &[String], names: &[&str]) -> bool {
    args.iter().any(|arg| names.iter().any(|name| arg == name))
}

fn insert_after_command_arg<const N: usize>(
    args: Vec<String>,
    command: &str,
    insert: [String; N],
) -> Vec<String> {
    let index = args.iter().position(|arg| arg == command).unwrap_or(0);
    insert_after_arg_index(args, index, insert)
}

fn insert_after_arg_index<const N: usize>(
    mut args: Vec<String>,
    index: usize,
    insert: [String; N],
) -> Vec<String> {
    let insert_at = (index + 1).min(args.len());
    for (offset, value) in insert.into_iter().enumerate() {
        args.insert(insert_at + offset, value);
    }
    args
}

fn role_command_for_check(role_presets: &Value, role_id: &str) -> CommandResult<Vec<String>> {
    let preset = role_presets
        .as_array()
        .and_then(|items| {
            items
                .iter()
                .find(|item| item.get("roleId").and_then(Value::as_str) == Some(role_id))
        })
        .ok_or_else(|| CommandError::validation("role preset을 찾을 수 없습니다."))?;

    if let Some(args) = preset.get("commandArgs").and_then(Value::as_array) {
        let mut parsed = Vec::new();
        for arg in args {
            parsed.push(
                arg.as_str()
                    .ok_or_else(|| {
                        CommandError::validation("commandArgs는 문자열 배열이어야 합니다.")
                    })?
                    .to_string(),
            );
        }
        return Ok(parsed);
    }

    if let Some(template) = preset.get("commandTemplate").and_then(Value::as_str) {
        return Ok(template.split_whitespace().map(str::to_string).collect());
    }

    Ok(Vec::new())
}

fn connection_command_for_check(
    connection: &Value,
    project_root: &Path,
) -> CommandResult<Vec<String>> {
    let provider = connection.get("provider").and_then(Value::as_str);
    let prompt = r#"Helm AI CLI smoke check.
Reply with exactly: HELM_CLI_OK
Do not modify files, run shell commands, create tasks, or use git."#;
    let mut placeholders = HashMap::new();
    placeholders.insert(
        "projectRoot".to_string(),
        project_root.to_string_lossy().to_string(),
    );
    placeholders.insert("planPrompt".to_string(), prompt.to_string());
    placeholders.insert("message".to_string(), prompt.to_string());
    placeholders.insert(
        "goalText".to_string(),
        "Helm AI CLI smoke check".to_string(),
    );
    placeholders.insert("currentDraftJson".to_string(), "null".to_string());

    let args = planning_command_args(connection, provider, &placeholders)?;
    if args.is_empty() {
        return Ok(Vec::new());
    }

    let model = connection
        .get("planningModel")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            connection
                .get("defaultModel")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
        });
    let effort = connection
        .get("defaultEffort")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty());
    let command_args = inject_planning_provider_options(args, provider, model, effort);

    Ok(normalize_planning_cli_args(command_args, provider))
}

fn connection_check_timeout_seconds(connection: &Value) -> u64 {
    connection
        .get("planningTimeoutSeconds")
        .and_then(Value::as_u64)
        .or_else(|| connection.get("timeoutSeconds").and_then(Value::as_u64))
        .unwrap_or(60)
        .clamp(1, 120)
}

fn command_output_message(output: &ShellOutput) -> String {
    let stderr = output.stderr.trim();
    if !stderr.is_empty() {
        return compact_ai_cli_error(stderr).unwrap_or_else(|| stderr.to_string());
    }
    let stdout = output.stdout.trim();
    compact_ai_cli_error(stdout).unwrap_or_else(|| stdout.to_string())
}

fn smoke_output_contains_sentinel(output: &ShellOutput) -> bool {
    output.stdout.contains(AI_CLI_SMOKE_SENTINEL) || output.stderr.contains(AI_CLI_SMOKE_SENTINEL)
}

fn is_antigravity_chat_command(command: &[String]) -> bool {
    let Some(program) = command.first() else {
        return false;
    };
    let program_name = Path::new(program)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(program);
    matches!(program_name, "antigravity" | "agy" | "antigravity-ide")
        && command.iter().any(|arg| arg == "chat")
}

fn ai_cli_failure_hint(provider: Option<&str>, raw_message: &str) -> String {
    if let Some(message) = compact_ai_cli_error(raw_message) {
        return message;
    }

    let trimmed = raw_message.trim();
    let normalized = trimmed.to_lowercase();

    if provider == Some("claude") && normalized.contains("not logged in") {
        return "Claude CLI는 설치되어 있지만 로그인 상태가 아닙니다. 터미널에서 claude를 열고 /login을 실행한 뒤 다시 확인하세요.".to_string();
    }

    if provider == Some("claude")
        && (normalized.contains("401") || normalized.contains("invalid authentication credentials"))
    {
        return "Claude CLI 인증 토큰이 유효하지 않습니다. 터미널에서 `claude auth logout` 후 `claude auth login`으로 다시 로그인하거나, 연결 환경 변수에 ANTHROPIC_API_KEY를 등록한 뒤 다시 확인하세요.".to_string();
    }

    if provider == Some("claude") && normalized.contains("organization does not have access") {
        return "Claude CLI는 설치되어 있지만 현재 로그인된 조직에 Claude Code 접근 권한이 없습니다. 올바른 조직으로 다시 로그인하거나 관리자에게 권한을 요청해야 합니다.".to_string();
    }

    if provider == Some("gemini")
        && (normalized.contains("unsupported_client")
            || normalized.contains("ineligibletiererror")
            || normalized.contains("no longer supported for gemini code assist"))
    {
        return "현재 Gemini CLI 로그인 티어는 이 클라이언트를 지원하지 않습니다. 연결 환경 변수에 GEMINI_API_KEY를 등록하거나 지원되는 Google 계정/프로젝트로 다시 인증해야 합니다.".to_string();
    }

    if provider == Some("gemini")
        && (normalized.contains("not authenticated")
            || normalized.contains("authentication")
            || normalized.contains("api key")
            || normalized.contains("login"))
    {
        return "Gemini CLI는 설치되어 있지만 인증 정보를 찾지 못했습니다. 터미널에서 gemini 로그인을 확인하거나 GEMINI_API_KEY를 환경 변수에 등록한 뒤 다시 확인하세요.".to_string();
    }

    if trimmed.is_empty() {
        "응답 출력이 없습니다.".to_string()
    } else {
        trimmed.to_string()
    }
}

fn compact_ai_cli_error(raw_message: &str) -> Option<String> {
    let text = strip_terminal_controls(raw_message);
    let normalized = text.to_lowercase();
    if normalized.contains("you've hit your usage limit")
        || normalized.contains("you have hit your usage limit")
    {
        return Some(compact_usage_limit_error(&text));
    }

    let mut error_lines = Vec::new();
    for line in text.lines() {
        let Some(error_index) = line.find("ERROR:") else {
            continue;
        };
        let error = line[error_index..].trim();
        if error.is_empty() || error_lines.iter().any(|item| item == error) {
            continue;
        }
        error_lines.push(error.to_string());
        if error_lines.len() >= 3 {
            break;
        }
    }

    if error_lines.is_empty() {
        None
    } else {
        Some(error_lines.join("\n"))
    }
}

fn compact_usage_limit_error(text: &str) -> String {
    let retry = retry_after_fragment(text)
        .map(|value| format!("try again at {value}."))
        .unwrap_or_else(|| "try again later".to_string());
    format!("ERROR: You've hit your usage limit.\n{retry}")
}

fn retry_after_fragment(text: &str) -> Option<String> {
    let normalized = text.to_lowercase();
    let marker = "try again at ";
    let start = normalized.find(marker)? + marker.len();
    let rest = text.get(start..)?.trim_start();
    let end = rest
        .find(|ch| matches!(ch, '.' | '\n' | '\r'))
        .unwrap_or(rest.len());
    let value = rest[..end].trim();
    (!value.is_empty()).then(|| value.to_string())
}

struct ModelRefreshResult {
    models: Option<Vec<String>>,
    message: Option<String>,
}

fn refresh_available_models(connection: &Value, cwd: &Path) -> ModelRefreshResult {
    let Some(provider) = connection.get("provider").and_then(Value::as_str) else {
        return ModelRefreshResult {
            models: None,
            message: Some("provider가 없어 모델 목록을 갱신하지 않았습니다.".to_string()),
        };
    };

    let env_overrides = connection_env(connection);
    let api_refresh = match provider {
        "codex" => refresh_openai_models(&env_overrides),
        "claude" => refresh_anthropic_models(&env_overrides),
        "gemini" => ModelRefreshResult {
            models: Some(gemini_cli_model_aliases()),
            message: Some("Gemini CLI 기본 모델 alias를 사용합니다.".to_string()),
        },
        _ => ModelRefreshResult {
            models: None,
            message: Some("지원하지 않는 provider라 모델 목록을 갱신하지 않았습니다.".to_string()),
        },
    };

    if provider == "claude" {
        if let Some(models) = api_refresh.models.as_ref() {
            return ModelRefreshResult {
                message: api_refresh.message,
                models: Some(models.clone()),
            };
        }
    }

    if api_refresh
        .models
        .as_ref()
        .is_some_and(|models| !models.is_empty())
    {
        return api_refresh;
    }

    let cli_refresh = refresh_cli_models(connection, provider, cwd);
    match cli_refresh.models {
        Some(models) if !models.is_empty() => ModelRefreshResult {
            message: Some(format!(
                "{} {}",
                api_refresh
                    .message
                    .unwrap_or_else(|| "API 모델 목록을 사용할 수 없습니다.".to_string()),
                cli_refresh.message.unwrap_or_else(|| format!(
                    "CLI fallback으로 모델 {}개를 갱신했습니다.",
                    models.len()
                ))
            )),
            models: Some(models),
        },
        _ => ModelRefreshResult {
            models: None,
            message: Some(format!(
                "{} {}",
                api_refresh
                    .message
                    .unwrap_or_else(|| "API 모델 목록을 사용할 수 없습니다.".to_string()),
                cli_refresh
                    .message
                    .unwrap_or_else(|| "모델 후보를 찾지 못했습니다.".to_string())
            )),
        },
    }
}

fn refresh_openai_models(env_overrides: &[(String, String)]) -> ModelRefreshResult {
    let Some(api_key) = connection_env_value(env_overrides, "OPENAI_API_KEY")
        .or_else(|| env::var("OPENAI_API_KEY").ok())
        .filter(|value| !value.trim().is_empty())
    else {
        return ModelRefreshResult {
            models: None,
            message: Some(
                "OPENAI_API_KEY가 없어 OpenAI API 모델 조회는 건너뛰었습니다.".to_string(),
            ),
        };
    };

    match fetch_json_with_curl(
        "https://api.openai.com/v1/models",
        vec![format!("Authorization: Bearer {api_key}")],
    ) {
        Ok(value) => {
            let models = sorted_model_ids(&value, is_openai_agent_model);
            if models.is_empty() {
                ModelRefreshResult {
                    models: None,
                    message: Some(
                        "OpenAI 모델 목록 응답에서 사용할 모델을 찾지 못했습니다.".to_string(),
                    ),
                }
            } else {
                ModelRefreshResult {
                    message: Some(format!("OpenAI 모델 {}개를 갱신했습니다.", models.len())),
                    models: Some(models),
                }
            }
        }
        Err(message) => ModelRefreshResult {
            models: None,
            message: Some(format!("OpenAI 모델 목록 갱신 실패: {message}")),
        },
    }
}

fn refresh_anthropic_models(env_overrides: &[(String, String)]) -> ModelRefreshResult {
    let Some(api_key) = connection_env_value(env_overrides, "ANTHROPIC_API_KEY")
        .or_else(|| env::var("ANTHROPIC_API_KEY").ok())
        .filter(|value| !value.trim().is_empty())
    else {
        return ModelRefreshResult {
            models: None,
            message: Some(
                "ANTHROPIC_API_KEY가 없어 Anthropic API 모델 조회는 건너뛰었습니다.".to_string(),
            ),
        };
    };

    match fetch_json_with_curl(
        "https://api.anthropic.com/v1/models",
        vec![
            format!("x-api-key: {api_key}"),
            "anthropic-version: 2023-06-01".to_string(),
        ],
    ) {
        Ok(value) => {
            let models = sorted_model_ids(&value, is_anthropic_agent_model);
            if models.is_empty() {
                ModelRefreshResult {
                    models: None,
                    message: Some(
                        "Anthropic 모델 목록 응답에서 사용할 모델을 찾지 못했습니다.".to_string(),
                    ),
                }
            } else {
                ModelRefreshResult {
                    message: Some(format!("Anthropic 모델 {}개를 갱신했습니다.", models.len())),
                    models: Some(models),
                }
            }
        }
        Err(message) => ModelRefreshResult {
            models: None,
            message: Some(format!("Anthropic 모델 목록 갱신 실패: {message}")),
        },
    }
}

fn fetch_json_with_curl(url: &str, headers: Vec<String>) -> Result<Value, String> {
    let mut command = Command::new("curl");
    command.args(["-fsS", "--max-time", "10", url]);
    for header in headers {
        command.args(["-H", &header]);
    }

    let output = command
        .output()
        .map_err(|err| format!("curl 실행 실패: {err}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("curl 종료 코드 {:?}", output.status.code())
        } else {
            stderr
        });
    }

    serde_json::from_slice(&output.stdout).map_err(|err| format!("응답 JSON 파싱 실패: {err}"))
}

fn refresh_cli_models(connection: &Value, provider: &str, cwd: &Path) -> ModelRefreshResult {
    let env_overrides = connection_env(connection);
    if provider == "codex" {
        let debug_refresh = refresh_codex_debug_models(connection, cwd, &env_overrides);
        return debug_refresh;
    }

    let Some(command) = cli_model_command(connection, provider, cwd) else {
        return ModelRefreshResult {
            models: None,
            message: Some("CLI /model fallback을 지원하지 않는 provider입니다.".to_string()),
        };
    };

    match run_pty_command_with_input(
        cwd,
        &command,
        "/model\n",
        Duration::from_secs(4),
        &env_overrides,
    ) {
        Ok(output) => {
            let text = strip_terminal_controls(&format!("{}\n{}", output.stdout, output.stderr));
            let models = extract_cli_model_ids(provider, &text);
            if models.is_empty() {
                if provider == "claude" {
                    return refresh_claude_embedded_models(connection);
                }
                ModelRefreshResult {
                    models: None,
                    message: Some(format!(
                        "CLI /model 출력에서 모델 후보를 찾지 못했습니다. {}",
                        compact_output_excerpt(&text)
                    )),
                }
            } else {
                ModelRefreshResult {
                    message: Some(format!(
                        "CLI /model 출력에서 모델 {}개를 찾았습니다.",
                        models.len()
                    )),
                    models: Some(models),
                }
            }
        }
        Err(err) if provider == "claude" => ModelRefreshResult {
            models: Some(claude_recommended_models()),
            message: Some(format!(
                "Claude CLI /model 실행은 실패했지만 권장 모델 기본값을 사용합니다. {}",
                err.message
            )),
        },
        Err(err) => ModelRefreshResult {
            models: None,
            message: Some(format!("CLI /model 실행 실패: {}", err.message)),
        },
    }
}

fn refresh_claude_embedded_models(connection: &Value) -> ModelRefreshResult {
    let binary = connection_cli_binary(connection).unwrap_or("claude");
    let Some(path) = resolve_cli_binary_path(binary) else {
        return ModelRefreshResult {
            models: None,
            message: Some(format!("Claude CLI binary를 찾지 못했습니다: {binary}")),
        };
    };

    match fs::read(&path) {
        Ok(bytes) => {
            let mut models = extract_model_ids_from_bytes("claude", &bytes);
            models.sort();
            models.dedup();
            if models.is_empty() {
                ModelRefreshResult {
                    models: None,
                    message: Some(format!(
                        "Claude CLI binary에서 모델 후보를 찾지 못했습니다: {}",
                        path.display()
                    )),
                }
            } else {
                ModelRefreshResult {
                    message: Some(format!(
                        "Claude CLI binary에서 모델 {}개를 갱신했습니다.",
                        models.len()
                    )),
                    models: Some(models),
                }
            }
        }
        Err(err) => ModelRefreshResult {
            models: None,
            message: Some(format!(
                "Claude CLI binary를 읽지 못했습니다: {} ({err})",
                path.display()
            )),
        },
    }
}

fn refresh_codex_debug_models(
    connection: &Value,
    cwd: &Path,
    env_overrides: &[(String, String)],
) -> ModelRefreshResult {
    let binary = connection_cli_binary(connection).unwrap_or("codex");
    let command = vec![
        binary.to_string(),
        "debug".to_string(),
        "models".to_string(),
    ];
    match run_direct_command_with_timeout_env(cwd, &command, Duration::from_secs(10), env_overrides)
    {
        Ok(output) => codex_debug_models_from_output(&output),
        Err(err) => ModelRefreshResult {
            models: None,
            message: Some(format!("Codex debug models 실행 실패: {}", err.message)),
        },
    }
}

fn codex_debug_models_from_output(output: &ShellOutput) -> ModelRefreshResult {
    let raw_output = format!("{}\n{}", output.stdout, output.stderr);
    if !output.timed_out {
        match parse_json_value_from_output(&raw_output) {
            Ok(value) => {
                let mut models = codex_debug_model_ids(&value);
                if models.is_empty() {
                    models = codex_debug_model_ids_from_text(&raw_output);
                }
                if !models.is_empty() {
                    return codex_debug_models_success(models);
                }
                if output.exit_code == 0 {
                    return ModelRefreshResult {
                        models: None,
                        message: Some(
                            "Codex debug models에서 list 모델을 찾지 못했습니다.".to_string(),
                        ),
                    };
                }
            }
            Err(err) => {
                let models = codex_debug_model_ids_from_text(&raw_output);
                if !models.is_empty() {
                    return codex_debug_models_success(models);
                }
                if output.exit_code == 0 {
                    return ModelRefreshResult {
                        models: None,
                        message: Some(format!(
                            "Codex debug models JSON 파싱 실패: {err}. {}",
                            codex_debug_failure_excerpt(&raw_output)
                        )),
                    };
                }
            }
        }
    }

    ModelRefreshResult {
        models: None,
        message: Some(format!(
            "Codex debug models 실행 실패: {}",
            codex_debug_failure_excerpt(&raw_output)
        )),
    }
}

fn codex_debug_models_success(models: Vec<String>) -> ModelRefreshResult {
    ModelRefreshResult {
        message: Some(format!(
            "Codex debug models에서 모델 {}개를 갱신했습니다.",
            models.len()
        )),
        models: Some(models),
    }
}

fn codex_debug_model_ids(value: &Value) -> Vec<String> {
    let mut models = value
        .get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| item.get("visibility").and_then(Value::as_str) == Some("list"))
        .filter_map(|item| item.get("slug").and_then(Value::as_str))
        .filter(|id| is_openai_agent_model(id))
        .map(str::to_string)
        .collect::<Vec<_>>();
    models.sort();
    models.dedup();
    models
}

fn codex_debug_model_ids_from_text(output: &str) -> Vec<String> {
    let text = strip_terminal_controls(output);
    let mut models = Vec::new();
    let mut search_start = 0;
    let slug_key = "\"slug\"";

    while let Some(relative_start) = text[search_start..].find(slug_key) {
        let start = search_start + relative_start;
        let after_slug_key = start + slug_key.len();
        let next_start = text[after_slug_key..]
            .find(slug_key)
            .map(|relative| after_slug_key + relative)
            .unwrap_or(text.len());
        let segment = &text[start..next_start];

        if json_string_property(segment, "visibility").as_deref() == Some("list") {
            if let Some(slug) = json_string_property(segment, "slug") {
                if is_openai_agent_model(&slug) {
                    models.push(slug);
                }
            }
        }

        if next_start == text.len() {
            break;
        }
        search_start = next_start;
    }

    models.sort();
    models.dedup();
    models
}

fn json_string_property(segment: &str, property: &str) -> Option<String> {
    let key = format!("\"{property}\"");
    let key_start = segment.find(&key)?;
    let after_key = &segment[key_start + key.len()..];
    let colon = after_key.find(':')?;
    let value = after_key[colon + 1..].trim_start();
    if !value.starts_with('"') {
        return None;
    }

    let mut escaped = false;
    for (offset, ch) in value[1..].char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == '"' {
            return serde_json::from_str(&value[..offset + 2]).ok();
        }
    }

    None
}

fn codex_debug_failure_excerpt(raw_output: &str) -> String {
    let text = strip_terminal_controls(raw_output);
    if text.contains("\"models\"") {
        if text.contains("[output truncated]") {
            return "출력이 너무 커 일부가 잘렸고 모델 후보를 찾지 못했습니다.".to_string();
        }
        return "모델 JSON 출력에서 모델 후보를 찾지 못했습니다.".to_string();
    }
    compact_output_excerpt(&text)
}

fn parse_json_value_from_output(output: &str) -> Result<Value, String> {
    let text = strip_terminal_controls(output);
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("출력이 비어 있습니다.".to_string());
    }

    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        return Ok(value);
    }

    for (start, open, close) in [(trimmed.find('{'), '{', '}'), (trimmed.find('['), '[', ']')] {
        let Some(start) = start else {
            continue;
        };
        for (end, _) in trimmed.rmatch_indices(close) {
            if end <= start {
                continue;
            }
            let candidate = &trimmed[start..=end];
            if let Ok(value) = serde_json::from_str::<Value>(candidate) {
                return Ok(value);
            }
        }
        return Err(format!("JSON {open}{close} 구간을 파싱하지 못했습니다."));
    }

    Err("출력에서 JSON 시작점을 찾지 못했습니다.".to_string())
}

fn cli_model_command(connection: &Value, provider: &str, cwd: &Path) -> Option<Vec<String>> {
    let binary = connection_cli_binary(connection).unwrap_or(provider);
    match provider {
        "codex" => Some(vec![
            binary.to_string(),
            "--no-alt-screen".to_string(),
            "--cd".to_string(),
            cwd.to_string_lossy().to_string(),
        ]),
        "claude" => Some(vec![
            binary.to_string(),
            "--permission-mode".to_string(),
            "plan".to_string(),
        ]),
        "gemini" => Some(vec![
            binary.to_string(),
            "--skip-trust".to_string(),
            "--approval-mode".to_string(),
            "plan".to_string(),
        ]),
        _ => None,
    }
}

fn connection_cli_binary(connection: &Value) -> Option<&str> {
    for key in ["healthCheckArgs", "planningCommandArgs", "commandArgs"] {
        let Some(first) = connection
            .get(key)
            .and_then(Value::as_array)
            .and_then(|items| items.first())
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
        else {
            continue;
        };
        return Some(first);
    }
    None
}

fn resolve_cli_binary_path(binary: &str) -> Option<PathBuf> {
    let binary_path = Path::new(binary);
    if binary_path.is_absolute() || binary.contains('/') {
        return binary_path.is_file().then(|| binary_path.to_path_buf());
    }

    command_search_dirs()
        .map(|dir| dir.join(binary))
        .find(|candidate| candidate.is_file())
        .or_else(|| resolve_cli_binary_from_login_shell(binary))
}

fn resolve_command_args(cwd: &Path, command: &[String]) -> Vec<String> {
    let Some(program) = command.first() else {
        return Vec::new();
    };
    let mut resolved = command.to_vec();
    if let Some(path) = resolve_command_program(cwd, program) {
        resolved[0] = path.to_string_lossy().to_string();
    }
    resolved
}

fn resolve_command_program(cwd: &Path, program: &str) -> Option<PathBuf> {
    let program_path = Path::new(program);
    if program_path.is_absolute() {
        return program_path.is_file().then(|| program_path.to_path_buf());
    }
    if program.contains('/') {
        let candidate = cwd.join(program_path);
        return candidate.is_file().then(|| candidate);
    }
    resolve_cli_binary_path(program)
}

fn command_search_dirs() -> impl Iterator<Item = PathBuf> {
    let mut dirs = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
        .unwrap_or_default();
    dirs.extend([
        PathBuf::from("/Applications/Codex.app/Contents/Resources"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/bin"),
        PathBuf::from("/usr/sbin"),
        PathBuf::from("/sbin"),
    ]);
    dirs.into_iter()
}

fn resolve_cli_binary_from_login_shell(binary: &str) -> Option<PathBuf> {
    let output = Command::new("/bin/zsh")
        .args(["-lc", "command -v -- \"$HELM_CLI_BINARY\""])
        .env("HELM_CLI_BINARY", binary)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_file())
}

fn sorted_model_ids(value: &Value, keep: fn(&str) -> bool) -> Vec<String> {
    let mut models = value
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("id").and_then(Value::as_str))
        .filter(|id| keep(id))
        .map(str::to_string)
        .collect::<Vec<_>>();
    models.sort();
    models.dedup();
    models
}

fn extract_cli_model_ids(provider: &str, text: &str) -> Vec<String> {
    let keep = match provider {
        "codex" => is_openai_agent_model,
        "claude" => is_anthropic_cli_model,
        "gemini" => is_gemini_cli_model,
        _ => return Vec::new(),
    };
    let mut models = Vec::new();
    let mut token = String::new();

    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
            token.push(ch.to_ascii_lowercase());
            continue;
        }

        push_model_candidate(&mut models, &token, keep);
        token.clear();
    }
    push_model_candidate(&mut models, &token, keep);

    models.sort();
    models.dedup();
    models
}

fn extract_model_ids_from_bytes(provider: &str, bytes: &[u8]) -> Vec<String> {
    let keep = match provider {
        "codex" => is_openai_agent_model,
        "claude" => is_anthropic_cli_model,
        "gemini" => is_gemini_cli_model,
        _ => return Vec::new(),
    };
    let mut models = Vec::new();
    let mut token = String::new();

    for byte in bytes {
        let ch = *byte as char;
        if byte.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
            token.push(ch.to_ascii_lowercase());
            continue;
        }

        push_model_candidate(&mut models, &token, keep);
        token.clear();
    }
    push_model_candidate(&mut models, &token, keep);

    models.sort();
    models.dedup();
    models
}

fn push_model_candidate(models: &mut Vec<String>, token: &str, keep: fn(&str) -> bool) {
    let token = token
        .trim_matches(|ch: char| matches!(ch, '-' | '_' | '.'))
        .to_string();
    if token.is_empty() || token.len() > 80 {
        return;
    }
    if keep(&token) {
        models.push(token);
    }
}

fn strip_terminal_controls(input: &str) -> String {
    let mut output = String::new();
    let mut chars = input.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch == '\x1b' {
            while let Some(next) = chars.next() {
                if ('@'..='~').contains(&next) {
                    break;
                }
            }
            continue;
        }
        if ch == '\x08' {
            output.pop();
            continue;
        }
        if ch == '\r' {
            output.push('\n');
            continue;
        }
        if ch.is_control() && ch != '\n' && ch != '\t' {
            continue;
        }
        output.push(ch);
    }

    output
}

fn compact_output_excerpt(text: &str) -> String {
    let excerpt = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .take(4)
        .collect::<Vec<_>>()
        .join(" ");
    if excerpt.is_empty() {
        "출력이 비어 있습니다.".to_string()
    } else {
        excerpt.chars().take(240).collect()
    }
}

fn is_openai_agent_model(id: &str) -> bool {
    let excluded = [
        "audio",
        "dall-e",
        "embedding",
        "image",
        "moderation",
        "realtime",
        "sora",
        "tts",
        "transcribe",
        "whisper",
    ];
    if excluded.iter().any(|needle| id.contains(needle)) {
        return false;
    }
    id.starts_with("gpt-") || id.starts_with("o1") || id.starts_with("o3") || id.starts_with("o4")
}

fn is_anthropic_agent_model(id: &str) -> bool {
    id.starts_with("claude-")
}

fn is_anthropic_cli_model(id: &str) -> bool {
    id.starts_with("claude-")
        && id
            .split(['-', '.', '_'])
            .any(|part| matches!(part, "sonnet" | "opus" | "haiku"))
}

fn is_gemini_cli_model(id: &str) -> bool {
    id.starts_with("gemini-") || id.starts_with("gemma-")
}

fn claude_recommended_models() -> Vec<String> {
    vec![
        "claude-sonnet-4-6".to_string(),
        "claude-opus-4-8".to_string(),
        "claude-haiku-4-5-20251001".to_string(),
    ]
}

fn gemini_cli_model_aliases() -> Vec<String> {
    vec![
        "gemini-2.5-flash".to_string(),
        "gemini-2.5-flash-lite".to_string(),
        "gemini-2.5-pro".to_string(),
    ]
}

fn string_array(args: &[Value], message: &str) -> CommandResult<Vec<String>> {
    let mut parsed = Vec::new();
    for arg in args {
        parsed.push(
            arg.as_str()
                .ok_or_else(|| CommandError::validation(message))?
                .to_string(),
        );
    }
    Ok(parsed)
}

fn project_context(state: &State<'_, AppState>, project_id: &str) -> CommandResult<ProjectContext> {
    state
        .projects
        .lock()
        .map_err(|_| CommandError::new("IoFailed", "프로젝트 상태를 읽지 못했습니다."))?
        .get(project_id)
        .cloned()
        .ok_or_else(|| {
            CommandError::new(
                "ProjectNotOpen",
                "프로젝트가 열려 있지 않습니다. 다시 프로젝트를 열어주세요.",
            )
        })
}

fn project_snapshot(
    conn: &rusqlite::Connection,
    root: &std::path::Path,
    project: ProjectSummary,
) -> CommandResult<ProjectSnapshot> {
    let settings = db::effective_settings(conn, &project.id)?;
    let repository = git::repository_state(root)?;
    let epics = db::list_epics(conn, &project.id)?;
    let tasks = db::list_tasks(conn, &project.id)?;
    let approvals = db::list_approvals(conn, &project.id, Some("Pending".to_string()))?;
    let task_counts = db::task_counts(&tasks);
    let audit_tail = db::audit_tail(conn, &project.id, 20)?;
    Ok(ProjectSnapshot {
        project,
        settings,
        repository,
        epics,
        tasks,
        approvals,
        task_counts,
        audit_tail,
    })
}

struct ShellOutput {
    stdout: String,
    stderr: String,
    exit_code: i32,
    timed_out: bool,
    elapsed_ms: u64,
}

fn elapsed_millis(started_at: Instant) -> u64 {
    started_at.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
}

fn open_file_path(path: &Path) -> CommandResult<()> {
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(path);
        command
    };

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("cmd");
        command.args(["/C", "start", ""]).arg(path);
        command
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(path);
        command
    };

    command
        .spawn()
        .map_err(|err| CommandError::io("파일을 열지 못했습니다.", err))?;
    Ok(())
}

fn run_pty_command_with_input(
    cwd: &Path,
    command: &[String],
    input: &str,
    timeout: Duration,
    env_overrides: &[(String, String)],
) -> CommandResult<ShellOutput> {
    if command.is_empty() {
        return Err(CommandError::validation("실행할 CLI command가 없습니다."));
    }
    let command = resolve_command_args(cwd, command);
    let started_at = Instant::now();

    let mut master_fd: libc::c_int = -1;
    let mut winsize = libc::winsize {
        ws_row: 40,
        ws_col: 120,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    let child_pid = unsafe {
        libc::forkpty(
            &mut master_fd,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut winsize,
        )
    };

    if child_pid == -1 {
        return Err(CommandError::io(
            "PTY command를 시작하지 못했습니다.",
            std::io::Error::last_os_error(),
        ));
    }

    if child_pid == 0 {
        let cwd = CString::new(cwd.to_string_lossy().as_bytes()).ok();
        if let Some(cwd) = cwd.as_ref() {
            unsafe {
                libc::chdir(cwd.as_ptr());
            }
        }
        set_child_env("TERM", "xterm-256color");
        set_child_env("COLORTERM", "truecolor");
        set_child_env_overrides(env_overrides);

        let cstrings = command
            .iter()
            .filter_map(|arg| CString::new(arg.as_str()).ok())
            .collect::<Vec<_>>();
        if cstrings.len() != command.len() || cstrings.is_empty() {
            unsafe {
                libc::_exit(127);
            }
        }
        let mut argv = cstrings.iter().map(|arg| arg.as_ptr()).collect::<Vec<_>>();
        argv.push(std::ptr::null());
        unsafe {
            libc::execvp(cstrings[0].as_ptr(), argv.as_ptr());
            libc::_exit(127);
        }
    }

    let reader = unsafe { fs::File::from_raw_fd(master_fd) };
    let mut writer = reader
        .try_clone()
        .map_err(|err| CommandError::io("PTY 입력 스트림을 열지 못했습니다.", err))?;
    let (sender, receiver) = mpsc::channel();
    let read_thread = std::thread::spawn(move || {
        let mut reader = reader;
        let mut output = Vec::new();
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(size) => output.extend_from_slice(&buffer[..size]),
                Err(_) => break,
            }
        }
        let _ = sender.send(String::from_utf8_lossy(&output).to_string());
    });

    std::thread::sleep(Duration::from_millis(700));
    let _ = writer.write_all(input.as_bytes());
    let _ = writer.flush();

    let deadline = Instant::now() + timeout;
    let mut status = 0;
    let mut exit_code = -1;
    let mut timed_out = false;
    loop {
        let wait = unsafe { libc::waitpid(child_pid, &mut status, libc::WNOHANG) };
        if wait == child_pid {
            exit_code = wait_status_code(status);
            break;
        }
        if wait == -1 {
            break;
        }
        if Instant::now() >= deadline {
            timed_out = true;
            unsafe {
                libc::kill(child_pid, libc::SIGHUP);
            }
            let wait = unsafe { libc::waitpid(child_pid, &mut status, 0) };
            if wait == child_pid {
                exit_code = wait_status_code(status);
            }
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    drop(writer);
    let _ = read_thread.join();
    let output = receiver.try_recv().unwrap_or_else(|_| String::new());

    Ok(ShellOutput {
        stdout: truncate_output(output),
        stderr: String::new(),
        exit_code,
        timed_out,
        elapsed_ms: elapsed_millis(started_at),
    })
}

fn wait_status_code(status: libc::c_int) -> i32 {
    if libc::WIFEXITED(status) {
        libc::WEXITSTATUS(status)
    } else if libc::WIFSIGNALED(status) {
        128 + libc::WTERMSIG(status)
    } else {
        -1
    }
}

fn discover_node_runtimes() -> Vec<NodeRuntimeSummary> {
    let mut runtimes = Vec::new();
    let mut seen = HashSet::new();

    if let Some(system_node) = shell_output_line("command -v node") {
        push_node_runtime(
            &mut runtimes,
            &mut seen,
            PathBuf::from(system_node),
            "system",
        );
    }

    for nvm_dir in candidate_nvm_dirs() {
        let versions_dir = nvm_dir.join("versions").join("node");
        let Ok(entries) = fs::read_dir(versions_dir) else {
            continue;
        };
        for entry in entries.filter_map(Result::ok) {
            let node_path = entry.path().join("bin").join("node");
            if node_path.is_file() {
                push_node_runtime(&mut runtimes, &mut seen, node_path, "nvm");
            }
        }
    }

    runtimes.sort_by(|left, right| {
        runtime_source_rank(&left.source)
            .cmp(&runtime_source_rank(&right.source))
            .then_with(|| compare_node_versions(&right.version, &left.version))
            .then_with(|| left.label.cmp(&right.label))
    });
    runtimes
}

fn push_node_runtime(
    runtimes: &mut Vec<NodeRuntimeSummary>,
    seen: &mut HashSet<PathBuf>,
    node_path: PathBuf,
    source: &str,
) {
    let Ok(node_path) = node_path.canonicalize() else {
        return;
    };
    if !seen.insert(node_path.clone()) {
        return;
    }
    let Some(version) = node_version(&node_path) else {
        return;
    };
    let Some(bin_path) = node_path.parent().map(Path::to_path_buf) else {
        return;
    };
    let label = if source == "nvm" {
        format!("{version} · nvm")
    } else {
        format!("{version} · shell")
    };

    runtimes.push(NodeRuntimeSummary {
        id: format!("{source}:{version}:{}", node_path.to_string_lossy()),
        label,
        version,
        node_path: node_path.to_string_lossy().to_string(),
        bin_path: bin_path.to_string_lossy().to_string(),
        source: source.to_string(),
    });
}

fn candidate_nvm_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(value) = env::var_os("NVM_DIR").filter(|value| !value.is_empty()) {
        dirs.push(PathBuf::from(value));
    }
    if let Ok(home) = home_dir() {
        dirs.push(home.join(".nvm"));
    }
    dirs.sort();
    dirs.dedup();
    dirs
}

fn shell_output_line(command: &str) -> Option<String> {
    Command::new("/bin/zsh")
        .args(["-lc", command])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| {
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .next()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
}

fn node_version(node_path: &Path) -> Option<String> {
    Command::new(node_path)
        .arg("--version")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| {
            String::from_utf8_lossy(&output.stdout)
                .trim()
                .split_whitespace()
                .next()
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
}

fn runtime_source_rank(source: &str) -> u8 {
    match source {
        "nvm" => 0,
        "system" => 1,
        _ => 2,
    }
}

fn compare_node_versions(left: &str, right: &str) -> std::cmp::Ordering {
    let left_parts = parse_node_version(left);
    let right_parts = parse_node_version(right);
    left_parts.cmp(&right_parts)
}

fn parse_node_version(version: &str) -> Vec<u64> {
    version
        .trim_start_matches('v')
        .split('.')
        .map(|part| part.parse::<u64>().unwrap_or(0))
        .collect()
}

fn resolve_node_bin_path(node_bin_path: Option<String>) -> CommandResult<Option<PathBuf>> {
    let Some(node_bin_path) = node_bin_path.filter(|value| !value.trim().is_empty()) else {
        return Ok(None);
    };
    let path = PathBuf::from(node_bin_path.trim())
        .canonicalize()
        .map_err(|err| CommandError::io("Node bin 경로를 확인하지 못했습니다.", err))?;
    if !path.is_dir() {
        return Err(CommandError::validation(
            "Node bin 디렉토리를 선택해주세요.",
        ));
    }
    Ok(Some(path))
}

fn nvm_dir_for_node_bin(node_bin_path: &Path) -> Option<PathBuf> {
    let node_version_dir = node_bin_path.parent()?;
    let node_versions_dir = node_version_dir.parent()?;
    if node_versions_dir.file_name()? != "node" {
        return None;
    }
    let versions_dir = node_versions_dir.parent()?;
    if versions_dir.file_name()? != "versions" {
        return None;
    }
    versions_dir.parent().map(Path::to_path_buf)
}

fn set_child_env(key: &str, value: &str) {
    let Ok(key) = CString::new(key) else {
        return;
    };
    let Ok(value) = CString::new(value) else {
        return;
    };
    unsafe {
        libc::setenv(key.as_ptr(), value.as_ptr(), 1);
    }
}

fn set_child_env_overrides(env_overrides: &[(String, String)]) {
    for (key, value) in env_overrides {
        set_child_env(key, value);
    }
}

fn apply_command_env(command: &mut Command, env_overrides: &[(String, String)]) {
    for (key, value) in env_overrides {
        command.env(key, value);
    }
}

fn connection_env(connection: &Value) -> Vec<(String, String)> {
    let mut entries = connection
        .get("env")
        .and_then(Value::as_object)
        .map(|env| {
            env.iter()
                .filter_map(|(key, value)| {
                    let key = key.trim();
                    let value = value.as_str()?;
                    if key.is_empty()
                        || key.contains('=')
                        || key.contains('\0')
                        || value.contains('\0')
                    {
                        return None;
                    }
                    Some((key.to_string(), value.to_string()))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    add_provider_env_defaults(
        connection.get("provider").and_then(Value::as_str),
        &mut entries,
    );
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    entries
}

fn add_provider_env_defaults(provider: Option<&str>, entries: &mut Vec<(String, String)>) {
    for key in provider_env_keys(provider) {
        if entries.iter().any(|(entry_key, _)| entry_key == key) {
            continue;
        }
        if let Some(value) = env::var(key)
            .ok()
            .filter(|value| !value.trim().is_empty())
            .or_else(|| login_shell_env_value(key))
        {
            entries.push((key.to_string(), value));
        }
    }
}

fn provider_env_keys(provider: Option<&str>) -> &'static [&'static str] {
    match provider {
        Some("claude") => &["ANTHROPIC_API_KEY"],
        Some("gemini") => &[
            "GEMINI_API_KEY",
            "GOOGLE_API_KEY",
            "GOOGLE_GENAI_USE_VERTEXAI",
            "GOOGLE_CLOUD_PROJECT",
            "GOOGLE_CLOUD_LOCATION",
        ],
        _ => &[],
    }
}

fn login_shell_env_value(key: &str) -> Option<String> {
    if !key
        .chars()
        .all(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit() || ch == '_')
    {
        return None;
    }
    let output = Command::new("/bin/zsh")
        .args(["-lc", "printenv \"$HELM_ENV_KEY\""])
        .env("HELM_ENV_KEY", key)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn connection_env_value(env_overrides: &[(String, String)], key: &str) -> Option<String> {
    env_overrides
        .iter()
        .find_map(|(entry_key, value)| (entry_key == key).then(|| value.clone()))
}

fn create_terminal_startup_dir(
    terminal_id: &str,
    node_bin_path: Option<&Path>,
) -> CommandResult<Option<PathBuf>> {
    let Some(node_bin_path) = node_bin_path else {
        return Ok(None);
    };

    let safe_id = terminal_id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>();
    let startup_dir =
        env::temp_dir().join(format!("helm-zdotdir-{}-{safe_id}", std::process::id()));
    if startup_dir.exists() {
        fs::remove_dir_all(&startup_dir).map_err(|err| {
            CommandError::io("터미널 startup 디렉토리를 초기화하지 못했습니다.", err)
        })?;
    }
    fs::create_dir_all(&startup_dir)
        .map_err(|err| CommandError::io("터미널 startup 디렉토리를 만들지 못했습니다.", err))?;

    let source_dir = env::var_os("ZDOTDIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or(home_dir()?);

    write_zsh_startup_wrapper(
        &startup_dir,
        &source_dir,
        ".zshenv",
        &format!("export ZDOTDIR={}\n", shell_quote_path(&startup_dir)),
    )?;
    write_zsh_startup_wrapper(&startup_dir, &source_dir, ".zprofile", "")?;
    write_zsh_startup_wrapper(
        &startup_dir,
        &source_dir,
        ".zshrc",
        &node_runtime_shell_exports(node_bin_path),
    )?;
    write_zsh_startup_wrapper(&startup_dir, &source_dir, ".zlogin", "")?;
    write_zsh_startup_wrapper(&startup_dir, &source_dir, ".zlogout", "")?;

    Ok(Some(startup_dir))
}

fn write_zsh_startup_wrapper(
    startup_dir: &Path,
    source_dir: &Path,
    filename: &str,
    tail: &str,
) -> CommandResult<()> {
    let source_file = source_dir.join(filename);
    let mut script = String::from("# Generated by Helm for this terminal session.\n");
    script.push_str(&format!(
        "if [ -r {} ]; then . {}; fi\n",
        shell_quote_path(&source_file),
        shell_quote_path(&source_file)
    ));
    if !tail.is_empty() {
        script.push_str(tail);
    }
    fs::write(startup_dir.join(filename), script)
        .map_err(|err| CommandError::io("터미널 startup 파일을 쓰지 못했습니다.", err))
}

fn node_runtime_shell_exports(node_bin_path: &Path) -> String {
    let node_bin = shell_quote_path(node_bin_path);
    let mut script = String::new();
    if let Some(nvm_dir) = nvm_dir_for_node_bin(node_bin_path) {
        script.push_str(&format!("export NVM_DIR={}\n", shell_quote_path(&nvm_dir)));
    }
    script.push_str(&format!("export NVM_BIN={node_bin}\n"));
    if let Some(version_dir) = node_bin_path.parent() {
        script.push_str(&format!(
            "export NVM_INC={}\n",
            shell_quote_path(&version_dir.join("include").join("node"))
        ));
    }
    script.push_str(&format!("export PATH={node_bin}:$PATH\n"));
    script.push_str("hash -r 2>/dev/null || true\n");
    script
}

fn shell_quote_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn start_handoff_watcher(state: &AppState) {
    let helm_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .map(Path::to_path_buf);
    let Some(helm_root) = helm_root else {
        eprintln!("Helm handoff watcher를 시작하지 못했습니다: Helm root를 찾지 못했습니다.");
        return;
    };
    let script_path = helm_root.join("scripts").join("claude-desktop-handoff.mjs");
    if !script_path.is_file() {
        eprintln!(
            "Helm handoff watcher를 시작하지 못했습니다: {} 파일이 없습니다.",
            script_path.display()
        );
        return;
    }

    let mut watcher = match state.handoff_watcher.lock() {
        Ok(watcher) => watcher,
        Err(_) => {
            eprintln!("Helm handoff watcher 상태를 확인하지 못했습니다.");
            return;
        }
    };
    if watcher
        .as_mut()
        .and_then(|child| child.try_wait().ok())
        .flatten()
        .is_none()
        && watcher.is_some()
    {
        return;
    }

    let node_path = discover_node_runtimes()
        .into_iter()
        .next()
        .map(|runtime| PathBuf::from(runtime.node_path))
        .unwrap_or_else(|| PathBuf::from("node"));
    let log_dir = helm_root.join(".helm").join("outbox").join("logs");
    if let Err(error) = fs::create_dir_all(&log_dir) {
        eprintln!("Helm handoff watcher log 폴더를 만들지 못했습니다: {error}");
        return;
    }
    let stdout = match fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join("handoff-watcher.stdout.log"))
    {
        Ok(file) => file,
        Err(error) => {
            eprintln!("Helm handoff watcher stdout log를 열지 못했습니다: {error}");
            return;
        }
    };
    let stderr = match fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join("handoff-watcher.stderr.log"))
    {
        Ok(file) => file,
        Err(error) => {
            eprintln!("Helm handoff watcher stderr log를 열지 못했습니다: {error}");
            return;
        }
    };

    match Command::new(node_path)
        .arg(script_path)
        .current_dir(&helm_root)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr))
        .spawn()
    {
        Ok(child) => {
            *watcher = Some(child);
        }
        Err(error) => {
            eprintln!("Helm handoff watcher를 시작하지 못했습니다: {error}");
        }
    }
}

fn stop_handoff_watcher(state: &AppState) {
    let Ok(mut watcher) = state.handoff_watcher.lock() else {
        return;
    };
    let Some(mut child) = watcher.take() else {
        return;
    };
    if child.try_wait().ok().flatten().is_none() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn spawn_pty_shell(
    project_id: &str,
    terminal_id: &str,
    cwd: &Path,
    cols: u16,
    rows: u16,
    node_bin_path: Option<&Path>,
    app: AppHandle,
) -> CommandResult<PtySession> {
    let startup_dir = create_terminal_startup_dir(terminal_id, node_bin_path)?;
    let mut master_fd: libc::c_int = -1;
    let mut winsize = libc::winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };

    let child_pid = unsafe {
        libc::forkpty(
            &mut master_fd,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut winsize,
        )
    };

    if child_pid == -1 {
        if let Some(startup_dir) = startup_dir {
            let _ = fs::remove_dir_all(startup_dir);
        }
        return Err(CommandError::io(
            "PTY 터미널을 시작하지 못했습니다.",
            std::io::Error::last_os_error(),
        ));
    }

    if child_pid == 0 {
        let cwd = CString::new(cwd.to_string_lossy().as_bytes()).ok();
        if let Some(cwd) = cwd.as_ref() {
            unsafe {
                libc::chdir(cwd.as_ptr());
            }
        }

        set_child_env("TERM", "xterm-256color");
        set_child_env("COLORTERM", "truecolor");
        if let Some(startup_dir) = startup_dir.as_ref() {
            set_child_env("ZDOTDIR", &startup_dir.to_string_lossy());
        }
        if let Some(node_bin_path) = node_bin_path {
            let node_bin = node_bin_path.to_string_lossy().to_string();
            let previous_path = env::var("PATH").unwrap_or_default();
            let next_path = if previous_path.is_empty() {
                node_bin.clone()
            } else {
                format!("{node_bin}:{previous_path}")
            };
            set_child_env("PATH", &next_path);
            set_child_env("NVM_BIN", &node_bin);
            if let Some(nvm_dir) = nvm_dir_for_node_bin(node_bin_path) {
                set_child_env("NVM_DIR", &nvm_dir.to_string_lossy());
            }
        }

        let shell = CString::new("/bin/zsh").unwrap();
        let login_arg = CString::new("-l").unwrap();
        let args = [shell.as_ptr(), login_arg.as_ptr(), std::ptr::null()];
        unsafe {
            libc::execv(shell.as_ptr(), args.as_ptr());
            libc::_exit(127);
        }
    }

    let reader = unsafe { fs::File::from_raw_fd(master_fd) };
    let writer =
        Arc::new(Mutex::new(reader.try_clone().map_err(|err| {
            CommandError::io("PTY 입력 스트림을 열지 못했습니다.", err)
        })?));
    let terminal_id_for_thread = terminal_id.to_string();
    let timestamp = db::now();
    let session_state = Arc::new(Mutex::new(TerminalSessionState {
        terminal_id: terminal_id.to_string(),
        project_id: project_id.to_string(),
        cwd: cwd.to_string_lossy().to_string(),
        node_bin_path: node_bin_path.map(|path| path.to_string_lossy().to_string()),
        cols,
        rows,
        running: true,
        exit_code: None,
        seq: 0,
        history: String::new(),
        created_at: timestamp.clone(),
        updated_at: timestamp,
    }));
    let session_state_for_thread = session_state.clone();
    let startup_dir_for_thread = startup_dir.clone();

    std::thread::spawn(move || {
        read_pty_output(
            reader,
            child_pid,
            terminal_id_for_thread,
            session_state_for_thread,
            app,
        );
        if let Some(startup_dir) = startup_dir_for_thread {
            let _ = fs::remove_dir_all(startup_dir);
        }
    });

    Ok(PtySession {
        child_pid,
        writer,
        state: session_state,
        startup_dir,
    })
}

fn read_pty_output(
    mut reader: fs::File,
    child_pid: libc::pid_t,
    terminal_id: String,
    session_state: Arc<Mutex<TerminalSessionState>>,
    app: AppHandle,
) {
    let mut buffer = [0_u8; 8192];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(size) => {
                let data = String::from_utf8_lossy(&buffer[..size]).to_string();
                let seq = session_state
                    .lock()
                    .map(|mut state| state.append_output(&data))
                    .unwrap_or(0);
                let _ = app.emit(
                    "terminal://output",
                    TerminalPtyOutput {
                        terminal_id: terminal_id.clone(),
                        data,
                        seq,
                    },
                );
            }
            Err(_) => break,
        }
    }

    let mut status = 0;
    unsafe {
        libc::waitpid(child_pid, &mut status, 0);
    }
    let exit_code = if libc::WIFEXITED(status) {
        libc::WEXITSTATUS(status)
    } else if libc::WIFSIGNALED(status) {
        128 + libc::WTERMSIG(status)
    } else {
        -1
    };
    if let Ok(mut state) = session_state.lock() {
        state.mark_exit(exit_code);
    }
    let _ = app.emit(
        "terminal://exit",
        TerminalPtyExit {
            terminal_id,
            exit_code,
        },
    );
}

fn stop_terminal_session(state: &State<'_, AppState>, terminal_id: &str) {
    let session = state
        .terminal_sessions
        .lock()
        .ok()
        .and_then(|mut sessions| sessions.remove(terminal_id));

    if let Some(session) = session {
        unsafe {
            libc::kill(session.child_pid, libc::SIGHUP);
        }
        if let Some(startup_dir) = session.startup_dir {
            let _ = fs::remove_dir_all(startup_dir);
        }
    }
}

fn terminal_session_handles(
    state: &State<'_, AppState>,
    terminal_id: &str,
) -> CommandResult<Option<(Arc<Mutex<fs::File>>, Arc<Mutex<TerminalSessionState>>)>> {
    let sessions = state
        .terminal_sessions
        .lock()
        .map_err(|_| CommandError::new("IoFailed", "터미널 세션 상태를 읽지 못했습니다."))?;
    Ok(sessions
        .get(terminal_id)
        .map(|session| (session.writer.clone(), session.state.clone())))
}

fn resize_pty_writer(writer: &Arc<Mutex<fs::File>>, cols: u16, rows: u16) -> CommandResult<()> {
    let file = writer
        .lock()
        .map_err(|_| CommandError::new("IoFailed", "터미널 크기 변경에 실패했습니다."))?;
    let winsize = libc::winsize {
        ws_row: rows.max(4),
        ws_col: cols.max(20),
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    let result = unsafe { libc::ioctl(file.as_raw_fd(), libc::TIOCSWINSZ, &winsize) };
    if result == -1 {
        return Err(CommandError::io(
            "터미널 크기 변경에 실패했습니다.",
            std::io::Error::last_os_error(),
        ));
    }
    Ok(())
}

fn update_terminal_session_size(
    session_state: &Arc<Mutex<TerminalSessionState>>,
    cols: u16,
    rows: u16,
) -> CommandResult<()> {
    let mut session_state = session_state
        .lock()
        .map_err(|_| CommandError::new("IoFailed", "터미널 세션 상태를 저장하지 못했습니다."))?;
    session_state.cols = cols.max(20);
    session_state.rows = rows.max(4);
    session_state.updated_at = db::now();
    Ok(())
}

impl TerminalSessionState {
    fn summary(&self) -> TerminalPtySummary {
        TerminalPtySummary {
            terminal_id: self.terminal_id.clone(),
            project_id: self.project_id.clone(),
            cwd: self.cwd.clone(),
            node_bin_path: self.node_bin_path.clone(),
            cols: self.cols,
            rows: self.rows,
            running: self.running,
            exit_code: self.exit_code,
            seq: self.seq,
            created_at: self.created_at.clone(),
            updated_at: self.updated_at.clone(),
        }
    }

    fn snapshot(&self) -> TerminalPtySnapshot {
        TerminalPtySnapshot {
            terminal_id: self.terminal_id.clone(),
            project_id: self.project_id.clone(),
            cwd: self.cwd.clone(),
            node_bin_path: self.node_bin_path.clone(),
            cols: self.cols,
            rows: self.rows,
            running: self.running,
            exit_code: self.exit_code,
            seq: self.seq,
            history: self.history.clone(),
            created_at: self.created_at.clone(),
            updated_at: self.updated_at.clone(),
        }
    }

    fn append_output(&mut self, data: &str) -> u64 {
        if data.is_empty() {
            return self.seq;
        }
        self.history.push_str(data);
        trim_terminal_history(&mut self.history);
        self.seq = self.seq.saturating_add(1);
        self.updated_at = db::now();
        self.seq
    }

    fn mark_exit(&mut self, exit_code: i32) {
        self.running = false;
        self.exit_code = Some(exit_code);
        self.seq = self.seq.saturating_add(1);
        self.updated_at = db::now();
    }
}

fn trim_terminal_history(history: &mut String) {
    if history.len() <= MAX_TERMINAL_HISTORY_CHARS {
        return;
    }
    let excess = history.len() - MAX_TERMINAL_HISTORY_CHARS;
    let drain_to = history
        .char_indices()
        .find_map(|(index, _)| (index >= excess).then_some(index))
        .unwrap_or(history.len());
    history.drain(..drain_to);
}

fn role_pty_session_id(project_id: &str, task_id: &str, role_id: &str) -> String {
    format!("{project_id}:{task_id}:{role_id}")
}

fn ensure_role_pty_session(
    app: &AppHandle,
    state: &State<'_, AppState>,
    project_id: &str,
    task_id: &str,
    role_id: &str,
    cwd: &Path,
) -> CommandResult<String> {
    let session_id = role_pty_session_id(project_id, task_id, role_id);
    {
        let sessions = state
            .role_pty_sessions
            .lock()
            .map_err(|_| CommandError::new("IoFailed", "role PTY 상태를 읽지 못했습니다."))?;
        if sessions.contains_key(&session_id) {
            return Ok(session_id);
        }
    }

    let session =
        spawn_role_pty_shell(&session_id, project_id, task_id, role_id, cwd, app.clone())?;
    write_role_pty_line(
        &session,
        &format!("printf '\\n[Helm role session ready] {role_id}\\n'\n"),
    );

    {
        let mut sessions = state
            .role_pty_sessions
            .lock()
            .map_err(|_| CommandError::new("IoFailed", "role PTY 상태를 갱신하지 못했습니다."))?;
        if sessions.contains_key(&session_id) {
            stop_role_pty_session(session);
            return Ok(session_id);
        }
        sessions.insert(session_id.clone(), session);
    }

    let _ = app.emit(
        "agent-role-pty://ready",
        RolePtyReady {
            session_id: session_id.clone(),
            project_id: project_id.to_string(),
            task_id: task_id.to_string(),
            role_id: role_id.to_string(),
        },
    );
    Ok(session_id)
}

fn write_role_pty_input(state: &State<'_, AppState>, session_id: &str, input: &str) {
    if let Ok(sessions) = state.role_pty_sessions.lock() {
        if let Some(session) = sessions.get(session_id) {
            write_role_pty_line(session, input);
        }
    }
}

fn write_role_pty_line(session: &RolePtySession, input: &str) {
    if let Ok(mut writer) = session.writer.lock() {
        let _ = writer.write_all(input.as_bytes());
        let _ = writer.flush();
    }
}

fn stop_project_role_pty_sessions(state: &State<'_, AppState>, project_id: &str) {
    let prefix = format!("{project_id}:");
    let sessions = state
        .role_pty_sessions
        .lock()
        .ok()
        .map(|mut sessions| {
            let keys = sessions
                .keys()
                .filter(|key| key.starts_with(&prefix))
                .cloned()
                .collect::<Vec<_>>();
            keys.into_iter()
                .filter_map(|key| sessions.remove(&key))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    for session in sessions {
        stop_role_pty_session(session);
    }
}

fn stop_role_pty_session(session: RolePtySession) {
    unsafe {
        libc::kill(session.child_pid, libc::SIGHUP);
    }
}

fn spawn_role_pty_shell(
    session_id: &str,
    project_id: &str,
    task_id: &str,
    role_id: &str,
    cwd: &Path,
    app: AppHandle,
) -> CommandResult<RolePtySession> {
    let mut master_fd: libc::c_int = -1;
    let mut winsize = libc::winsize {
        ws_row: 30,
        ws_col: 120,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };

    let child_pid = unsafe {
        libc::forkpty(
            &mut master_fd,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut winsize,
        )
    };

    if child_pid == -1 {
        return Err(CommandError::io(
            "role PTY 세션을 시작하지 못했습니다.",
            std::io::Error::last_os_error(),
        ));
    }

    if child_pid == 0 {
        let cwd = CString::new(cwd.to_string_lossy().as_bytes()).ok();
        if let Some(cwd) = cwd.as_ref() {
            unsafe {
                libc::chdir(cwd.as_ptr());
            }
        }

        set_child_env("TERM", "xterm-256color");
        set_child_env("COLORTERM", "truecolor");
        set_child_env("HELM_ROLE_ID", role_id);
        set_child_env("HELM_TASK_ID", task_id);
        set_child_env("HELM_PROJECT_ID", project_id);

        let shell = CString::new("/bin/zsh").unwrap();
        let login_arg = CString::new("-l").unwrap();
        let args = [shell.as_ptr(), login_arg.as_ptr(), std::ptr::null()];
        unsafe {
            libc::execv(shell.as_ptr(), args.as_ptr());
            libc::_exit(127);
        }
    }

    let reader = unsafe { fs::File::from_raw_fd(master_fd) };
    let writer = Arc::new(Mutex::new(reader.try_clone().map_err(|err| {
        CommandError::io("role PTY 입력 스트림을 열지 못했습니다.", err)
    })?));
    let session_id_for_thread = session_id.to_string();
    let project_id_for_thread = project_id.to_string();
    let task_id_for_thread = task_id.to_string();
    let role_id_for_thread = role_id.to_string();

    std::thread::spawn(move || {
        read_role_pty_output(
            reader,
            child_pid,
            session_id_for_thread,
            project_id_for_thread,
            task_id_for_thread,
            role_id_for_thread,
            app,
        );
    });

    Ok(RolePtySession { child_pid, writer })
}

fn read_role_pty_output(
    mut reader: fs::File,
    child_pid: libc::pid_t,
    session_id: String,
    project_id: String,
    task_id: String,
    role_id: String,
    app: AppHandle,
) {
    let mut buffer = [0_u8; 8192];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(size) => {
                let data = String::from_utf8_lossy(&buffer[..size]).to_string();
                let _ = app.emit(
                    "agent-role-pty://output",
                    RolePtyOutput {
                        session_id: session_id.clone(),
                        project_id: project_id.clone(),
                        task_id: task_id.clone(),
                        role_id: role_id.clone(),
                        data,
                    },
                );
            }
            Err(_) => break,
        }
    }

    let mut status = 0;
    unsafe {
        libc::waitpid(child_pid, &mut status, 0);
    }
    let exit_code = if libc::WIFEXITED(status) {
        libc::WEXITSTATUS(status)
    } else if libc::WIFSIGNALED(status) {
        128 + libc::WTERMSIG(status)
    } else {
        -1
    };
    let _ = app.emit(
        "agent-role-pty://exit",
        RolePtyExit {
            session_id,
            project_id,
            task_id,
            role_id,
            exit_code,
        },
    );
}

fn run_direct_command_with_timeout_env(
    cwd: &std::path::Path,
    command: &[String],
    timeout: Duration,
    env_overrides: &[(String, String)],
) -> CommandResult<ShellOutput> {
    if command.is_empty() {
        return Err(CommandError::validation(
            "실행할 planning command가 없습니다.",
        ));
    }
    let command = resolve_command_args(cwd, command);
    let started_at = Instant::now();
    let mut process = Command::new(&command[0]);
    process
        .args(&command[1..])
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_command_env(&mut process, env_overrides);
    let mut child = process
        .spawn()
        .map_err(|err| CommandError::io("planner command를 실행하지 못했습니다.", err))?;
    let stdout_reader = child
        .stdout
        .take()
        .map(spawn_output_reader)
        .ok_or_else(|| CommandError::validation("planner command stdout을 열지 못했습니다."))?;
    let stderr_reader = child
        .stderr
        .take()
        .map(spawn_output_reader)
        .ok_or_else(|| CommandError::validation("planner command stderr를 열지 못했습니다."))?;
    let deadline = Instant::now() + timeout;

    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|err| CommandError::io("planner command 상태를 확인하지 못했습니다.", err))?
        {
            return Ok(shell_output_from_readers(
                stdout_reader,
                stderr_reader,
                status.code().unwrap_or(-1),
                false,
                started_at,
            ));
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(shell_output_from_readers(
                stdout_reader,
                stderr_reader,
                -1,
                true,
                started_at,
            ));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn run_shell_command(
    cwd: &std::path::Path,
    command: &str,
    timeout: Duration,
) -> CommandResult<ShellOutput> {
    let started_at = Instant::now();
    let mut child = Command::new("/bin/zsh")
        .args(["-lc", command])
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| CommandError::io("터미널 명령을 실행하지 못했습니다.", err))?;
    let stdout_reader = child
        .stdout
        .take()
        .map(spawn_output_reader)
        .ok_or_else(|| CommandError::validation("터미널 명령 stdout을 열지 못했습니다."))?;
    let stderr_reader = child
        .stderr
        .take()
        .map(spawn_output_reader)
        .ok_or_else(|| CommandError::validation("터미널 명령 stderr를 열지 못했습니다."))?;
    let deadline = Instant::now() + timeout;

    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|err| CommandError::io("터미널 명령 상태를 확인하지 못했습니다.", err))?
        {
            return Ok(shell_output_from_readers(
                stdout_reader,
                stderr_reader,
                status.code().unwrap_or(-1),
                false,
                started_at,
            ));
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(shell_output_from_readers(
                stdout_reader,
                stderr_reader,
                -1,
                true,
                started_at,
            ));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn spawn_output_reader<R>(mut reader: R) -> std::thread::JoinHandle<Vec<u8>>
where
    R: Read + Send + 'static,
{
    std::thread::spawn(move || {
        let mut output = Vec::new();
        let _ = reader.read_to_end(&mut output);
        output
    })
}

fn shell_output_from_readers(
    stdout_reader: std::thread::JoinHandle<Vec<u8>>,
    stderr_reader: std::thread::JoinHandle<Vec<u8>>,
    exit_code: i32,
    timed_out: bool,
    started_at: Instant,
) -> ShellOutput {
    let stdout = stdout_reader.join().unwrap_or_default();
    let stderr = stderr_reader.join().unwrap_or_default();
    ShellOutput {
        stdout: truncate_output(String::from_utf8_lossy(&stdout).to_string()),
        stderr: truncate_output(String::from_utf8_lossy(&stderr).to_string()),
        exit_code,
        timed_out,
        elapsed_ms: elapsed_millis(started_at),
    }
}

fn resolve_terminal_path(project_root: &Path, cwd: &str, path: &str) -> CommandResult<PathBuf> {
    let base = if cwd.trim().is_empty() {
        project_root.to_path_buf()
    } else {
        PathBuf::from(cwd)
    };
    let target = path.trim();
    let candidate = if target.is_empty() {
        project_root.to_path_buf()
    } else if target == "~" {
        home_dir()?
    } else if let Some(rest) = target.strip_prefix("~/") {
        home_dir()?.join(rest)
    } else {
        let target_path = PathBuf::from(target);
        if target_path.is_absolute() {
            target_path
        } else {
            base.join(target_path)
        }
    };
    candidate
        .canonicalize()
        .map_err(|err| CommandError::io("터미널 경로를 확인하지 못했습니다.", err))
}

fn home_dir() -> CommandResult<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| CommandError::validation("HOME 경로를 찾을 수 없습니다."))
}

fn truncate_output(value: String) -> String {
    const MAX_OUTPUT_BYTES: usize = 64 * 1024;
    if value.len() <= MAX_OUTPUT_BYTES {
        return value;
    }
    let mut truncated = value;
    truncated.truncate(MAX_OUTPUT_BYTES);
    truncated.push_str("\n\n[output truncated]");
    truncated
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_pr_number_handles_gh_create_url() {
        assert_eq!(
            parse_pr_number("https://github.com/owner/repo/pull/123"),
            Some(123)
        );
        // gh sometimes prints a trailing newline/slash; trimming happens upstream + here.
        assert_eq!(
            parse_pr_number("https://github.com/owner/repo/pull/7/"),
            Some(7)
        );
        assert_eq!(parse_pr_number("not-a-url"), None);
        assert_eq!(parse_pr_number(""), None);
    }

    fn shell_output(stdout: &str, stderr: &str, exit_code: i32) -> ShellOutput {
        ShellOutput {
            stdout: stdout.to_string(),
            stderr: stderr.to_string(),
            exit_code,
            timed_out: false,
            elapsed_ms: 12,
        }
    }

    #[test]
    fn codex_debug_models_reads_models_from_nonzero_output() {
        let output = shell_output(
            r#"{"models":[{"slug":"gpt-5.5","visibility":"list"},{"slug":"gpt-hidden","visibility":"hidden"},{"slug":"sora-1","visibility":"list"}]}"#,
            "",
            1,
        );

        let result = codex_debug_models_from_output(&output);

        assert_eq!(result.models, Some(vec!["gpt-5.5".to_string()]));
        assert_eq!(
            result.message.as_deref(),
            Some("Codex debug models에서 모델 1개를 갱신했습니다.")
        );
    }

    #[test]
    fn codex_debug_models_reads_models_with_cli_warning() {
        let output = shell_output(
            r#"{"models":[{"slug":"gpt-5.4","visibility":"list"},{"slug":"o4-mini","visibility":"list"}]}"#,
            "WARNING: proceeding, even though we could not update PATH",
            1,
        );

        let result = codex_debug_models_from_output(&output);

        assert_eq!(
            result.models,
            Some(vec!["gpt-5.4".to_string(), "o4-mini".to_string()])
        );
    }

    #[test]
    fn codex_debug_models_reads_models_from_truncated_json_text() {
        let output = shell_output(
            r#"{"models":[{"slug":"gpt-hidden","visibility":"hidden"},{"slug":"gpt-5.5","display_name":"GPT-5.5","visibility":"list","base_instructions":"very long text"#,
            "\n[output truncated]",
            1,
        );

        let result = codex_debug_models_from_output(&output);

        assert_eq!(result.models, Some(vec!["gpt-5.5".to_string()]));
    }

    #[test]
    fn connection_env_value_reads_connection_override() {
        let env_overrides = vec![
            ("ANTHROPIC_API_KEY".to_string(), "sk-ant-test".to_string()),
            ("OPENAI_API_KEY".to_string(), "sk-openai-test".to_string()),
        ];

        assert_eq!(
            connection_env_value(&env_overrides, "ANTHROPIC_API_KEY").as_deref(),
            Some("sk-ant-test")
        );
        assert_eq!(connection_env_value(&env_overrides, "MISSING_KEY"), None);
    }

    #[test]
    fn anthropic_cli_model_filter_excludes_short_aliases() {
        assert!(is_anthropic_cli_model("claude-sonnet-4-6"));
        assert!(is_anthropic_cli_model("claude-opus-4-8"));
        assert!(!is_anthropic_cli_model("sonnet"));
        assert!(!is_anthropic_cli_model("opus"));
    }

    #[test]
    fn ai_cli_error_compacts_usage_limit_output() {
        let output = shell_output(
            "",
            r#"Reading additional input from stdin...
2026-05-29T01:42:24.063087Z WARN codex_core_skills::loader: ignoring interface.icon_large
ERROR: You've hit your usage limit. To get more access now, send a request to your admin or try again at Jun 1st, 2026 9:00 AM.
ERROR: You've hit your usage limit. To get more access now, send a request to your admin or try again at Jun 1st, 2026 9:00 AM."#,
            1,
        );

        assert_eq!(
            command_output_message(&output),
            "ERROR: You've hit your usage limit.\ntry again at Jun 1st, 2026 9:00 AM."
        );
    }

    #[test]
    fn terminal_session_state_tracks_history_seq_and_exit() {
        let timestamp = db::now();
        let mut state = TerminalSessionState {
            terminal_id: "term-1".to_string(),
            project_id: "project-1".to_string(),
            cwd: "/tmp".to_string(),
            node_bin_path: None,
            cols: 120,
            rows: 32,
            running: true,
            exit_code: None,
            seq: 0,
            history: String::new(),
            created_at: timestamp.clone(),
            updated_at: timestamp,
        };

        assert_eq!(state.append_output("hello"), 1);
        assert_eq!(state.append_output(" world"), 2);
        state.mark_exit(0);

        assert_eq!(state.history, "hello world");
        assert_eq!(state.seq, 3);
        assert!(!state.running);
        assert_eq!(state.exit_code, Some(0));
    }

    #[test]
    fn terminal_history_trim_preserves_recent_utf8_output() {
        let mut history = "가".repeat(MAX_TERMINAL_HISTORY_CHARS / "가".len() + 32);
        history.push_str("tail");

        trim_terminal_history(&mut history);

        assert!(history.len() <= MAX_TERMINAL_HISTORY_CHARS);
        assert!(history.ends_with("tail"));
    }
}

/// GUI(Finder/Dock)로 실행하면 PATH가 /usr/bin:/bin:/usr/sbin:/sbin로 제한돼,
/// Homebrew에 설치된 `gh`(예: /opt/homebrew/bin/gh) 같은 bare 셸아웃이 조용히 실패한다.
/// (`git`은 /usr/bin/git이라 동작 → "git 화면은 되는데 PR만 빈 목록"이 된다.)
/// 흔한 사용자 bin 디렉터리를 PATH 앞에 보강해 gh/git/node 셸아웃이 모두 해석되게 한다.
// ponytail: 정적 후보 목록. nvm 등 버전별 경로가 더 필요해지면 로그인 셸 PATH를 읽어 합친다.
fn augment_path_for_gui_launch() {
    let home = std::env::var("HOME").unwrap_or_default();
    let candidates = [
        "/opt/homebrew/bin".to_string(),
        "/opt/homebrew/sbin".to_string(),
        "/usr/local/bin".to_string(),
        format!("{home}/.local/bin"),
    ];
    let current = std::env::var("PATH").unwrap_or_default();
    let prefix: Vec<String> = candidates
        .into_iter()
        .filter(|cand| {
            std::path::Path::new(cand).is_dir() && !current.split(':').any(|p| p == cand.as_str())
        })
        .collect();
    if prefix.is_empty() {
        return;
    }
    let new_path = if current.is_empty() {
        prefix.join(":")
    } else {
        format!("{}:{}", prefix.join(":"), current)
    };
    std::env::set_var("PATH", new_path);
}

fn main() {
    augment_path_for_gui_launch();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState::default())
        .setup(|app| {
            ensure_main_window_visible(app);
            focus_main_window(&app.handle());
            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(500));
                focus_main_window(&app_handle);
            });
            let state = app.state::<AppState>();
            start_handoff_watcher(&state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_launch_state,
            open_project,
            open_project_by_id,
            forget_project,
            get_app_settings,
            update_app_settings,
            get_project_snapshot,
            list_control_tower_projects,
            get_effective_settings,
            update_project_settings,
            run_planner_conversation,
            run_planner_consultation,
            run_orchestrator_conversation,
            list_planning_sessions,
            create_planning_session,
            get_planning_session,
            save_plan_draft_revision,
            approve_plan_draft,
            reject_plan_draft,
            materialize_plan_draft,
            list_runner_templates,
            apply_runner_template,
            check_role_runner,
            check_ai_connection,
            check_orchestrator_connection,
            refresh_ai_connection_models,
            refresh_orchestrator_connection_models,
            list_epics,
            create_epic,
            list_tasks,
            create_task,
            append_task_instruction,
            update_task_status,
            approve_task_completion_with_git,
            delete_task,
            get_task_worktree,
            ensure_task_worktree,
            export_task_graph,
            export_coordination_snapshot,
            read_task_graph,
            check_task_graph_conflict,
            open_task_graph,
            list_audit_logs,
            get_repository_state,
            get_local_branches,
            list_pull_requests,
            list_all_pull_requests,
            pull_request_detail,
            pull_request_diff,
            approve_pull_request,
            merge_pull_request,
            list_jira_issues,
            list_jira_transitions,
            set_jira_status,
            set_jira_token,
            jira_token_status,
            set_github_app_credentials,
            github_app_credentials_status,
            open_external,
            get_recent_commits,
            get_changed_files,
            get_ignored_files,
            get_file_diff,
            get_commit_changed_files,
            get_commit_file_diff,
            get_task_worktree_changed_files,
            switch_git_branch,
            delete_local_branch,
            list_node_runtimes,
            list_terminal_directories,
            list_editor_entries,
            read_editor_file,
            write_editor_file,
            run_terminal_command,
            resolve_terminal_cwd,
            start_terminal_pty,
            list_terminal_ptys,
            get_terminal_pty_snapshot,
            write_terminal_pty,
            resize_terminal_pty,
            stop_terminal_pty,
            list_terminal_saved_scripts,
            save_terminal_saved_script,
            mark_terminal_saved_script_used,
            delete_terminal_saved_script,
            run_stub_role,
            prepare_role_context,
            prepare_repair_context,
            start_next_role_run,
            run_host_role,
            list_role_lessons,
            retry_host_role,
            cancel_host_role,
            list_agent_runs,
            list_project_runs,
            list_agent_sessions,
            list_task_timeline,
            list_run_events,
            list_conversation_messages,
            clear_conversation_messages,
            append_conversation_message,
            get_agent_run,
            read_run_artifact,
            list_approvals,
            approve_approval,
            reject_approval
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Helm desktop")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Reopen { .. }) {
                focus_main_window(app);
            }
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                let state = app.state::<AppState>();
                stop_handoff_watcher(&state);
            }
        });
}

fn focus_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.show();
    let _ = window.unminimize();
    center_window_on_primary_monitor(&window);
    let _ = window.set_focus();
}

fn center_window_on_primary_monitor(window: &tauri::WebviewWindow) {
    let monitor = window
        .available_monitors()
        .ok()
        .and_then(|monitors| {
            monitors
                .iter()
                .find(|monitor| {
                    let position = monitor.position();
                    position.x >= 0 && position.y >= 0
                })
                .cloned()
                .or_else(|| monitors.first().cloned())
        })
        .or_else(|| {
            window
                .primary_monitor()
                .ok()
                .flatten()
                .or_else(|| window.current_monitor().ok().flatten())
        });
    let Some(monitor) = monitor else {
        let _ = window.center();
        return;
    };
    let Ok(window_size) = window.outer_size() else {
        let _ = window.center();
        return;
    };

    let monitor_position = monitor.position();
    let monitor_size = monitor.size();
    let x = i64::from(monitor_position.x)
        + ((i64::from(monitor_size.width) - i64::from(window_size.width)) / 2).max(0);
    let y = i64::from(monitor_position.y)
        + ((i64::from(monitor_size.height) - i64::from(window_size.height)) / 2).max(0);

    let _ = window.set_position(PhysicalPosition::new(x as i32, y as i32));
}

fn ensure_main_window_visible(app: &tauri::App) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Ok(position) = window.outer_position() else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    let Ok(monitors) = window.available_monitors() else {
        return;
    };

    let window_left = i64::from(position.x);
    let window_top = i64::from(position.y);
    let window_right = window_left + i64::from(size.width);
    let window_bottom = window_top + i64::from(size.height);

    let is_visible = monitors.iter().any(|monitor| {
        let monitor_position = monitor.position();
        let monitor_size = monitor.size();
        let monitor_left = i64::from(monitor_position.x);
        let monitor_top = i64::from(monitor_position.y);
        let monitor_right = monitor_left + i64::from(monitor_size.width);
        let monitor_bottom = monitor_top + i64::from(monitor_size.height);

        let overlap_width =
            (window_right.min(monitor_right) - window_left.max(monitor_left)).max(0);
        let overlap_height =
            (window_bottom.min(monitor_bottom) - window_top.max(monitor_top)).max(0);

        overlap_width >= 120 && overlap_height >= 80
    });

    if !is_visible {
        center_window_on_primary_monitor(&window);
    }
}
