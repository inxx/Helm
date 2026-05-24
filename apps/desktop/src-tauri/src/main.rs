mod db;
mod git;
mod models;

use crate::models::{
    AgentRunSummary, AiConnectionCheckResult, AiModelRefreshResult, AppSettings, ApprovalSummary,
    CommandError, CommandResult, CreateEpicInput, CreateTaskInput, EffectiveSettings, EpicSummary,
    GitBranchSummary, GitCommitSummary, GitFileStatus, GitRepositoryState, NodeRuntimeSummary,
    OrchestratorSettings, PlannerConversationInput, PlannerConversationResult, ProjectContext,
    ProjectSettingsPatch, ProjectSnapshot, ProjectSummary, RunEventSummary, RunnerCheckResult,
    RunnerTemplateSummary, TaskSummary, TaskTimelineEntry, TaskWorktreeSummary,
    TerminalCommandResult, TerminalDirectoryEntry,
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
use std::process::{Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc, Mutex,
};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

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

#[derive(Default)]
struct AppState {
    projects: Mutex<HashMap<String, ProjectContext>>,
    running_runs: Mutex<HashMap<String, Arc<AtomicBool>>>,
    queue_workers: Mutex<HashMap<String, Arc<AtomicBool>>>,
    terminal_sessions: Mutex<HashMap<String, PtySession>>,
    role_pty_sessions: Mutex<HashMap<String, RolePtySession>>,
}

struct PtySession {
    child_pid: libc::pid_t,
    writer: Arc<Mutex<fs::File>>,
    state: Arc<Mutex<TerminalSessionState>>,
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
        match open_project_from_path(Path::new(&root_path), &state, true) {
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
fn update_app_settings(settings: AppSettings, app: AppHandle) -> CommandResult<AppSettings> {
    let settings = normalize_app_settings(settings);
    save_app_settings(&app, &settings)?;
    Ok(settings)
}

#[tauri::command]
fn get_project_snapshot(
    project_id: String,
    state: State<'_, AppState>,
) -> CommandResult<ProjectSnapshot> {
    let context = project_context(&state, &project_id)?;
    let conn = db::open_existing_db(&context.db_path)?;
    let project = db::get_project(&conn, &project_id)?;
    project_snapshot(&conn, &context.root_path, project)
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
    let commands = resolve_planning_commands(&settings, &context.root_path, &input)?;
    let mut failures = Vec::new();
    let mut last_output = None;

    for command in commands {
        match run_direct_command_with_timeout(
            &context.root_path,
            &command.command,
            Duration::from_secs(command.timeout_seconds),
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
            conductor_config: None,
            worktree_root: None,
            worktree_setup: None,
            jira_config: None,
            obsidian_vault_path: None,
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
    let check = run_direct_command_with_timeout(cwd, &command, Duration::from_secs(timeout));

    match check {
        Ok(output) if output.exit_code == 0 && !output.timed_out => {
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
    project_id: String,
    state: State<'_, AppState>,
) -> CommandResult<Vec<TerminalPtySummary>> {
    let _ = project_context(&state, &project_id)?;
    let sessions = state
        .terminal_sessions
        .lock()
        .map_err(|_| CommandError::new("IoFailed", "터미널 세션 상태를 읽지 못했습니다."))?;
    let mut summaries = sessions
        .values()
        .filter_map(|session| {
            let state = session.state.lock().ok()?;
            if state.project_id == project_id {
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

    match db::prepare_next_role_context(conn, &context.root_path, project_id, &run.task_id) {
        Ok(next_run) => {
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

fn project_automation_policy(_context: &ProjectContext, _project_id: &str) -> AutomationPolicy {
    // P0 keeps observation, approval, context preparation, and host execution as
    // separate user actions. A later setting can opt projects into supervisor
    // handoff once the UI explains that operating mode.
    AutomationPolicy {
        background_queue_worker_enabled: false,
        supervisor_reconcile_enabled: false,
        require_explicit_host_run: true,
        auto_handoff_enabled: false,
    }
}

fn stop_project_queue_worker(state: &State<'_, AppState>, project_id: &str) {
    if let Ok(mut workers) = state.queue_workers.lock() {
        if let Some(stop) = workers.remove(project_id) {
            stop.store(true, Ordering::SeqCst);
        }
    }
}

fn run_project_queue_worker(
    app: AppHandle,
    context: ProjectContext,
    project_id: String,
    stop: Arc<AtomicBool>,
) {
    while !stop.load(Ordering::SeqCst) {
        let queued = db::open_existing_db(&context.db_path).and_then(|conn| {
            if db::has_running_agent_run(&conn, &project_id)? {
                return Ok(None);
            }
            db::next_queued_agent_run(&conn, &project_id)
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
    match run_conductor_gate(config, connection, context, run, &task) {
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
) -> CommandResult<Value> {
    let provider = connection.get("provider").and_then(Value::as_str);
    let prompt = build_conductor_prompt(context, run, task);
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
    let output = run_direct_command_with_timeout(
        &context.root_path,
        &command,
        Duration::from_secs(timeout),
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
) -> String {
    format!(
        r#"너는 Helm의 백그라운드 지휘자 AI다.
아래 queued run을 지금 실행해도 되는지 판단한다.
파일 수정, 명령 실행, git 작업은 하지 말고 JSON만 반환한다.

반환 JSON:
{{"decision":"run"|"hold","reason":"string","nextAction":"string"}}

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
) -> CommandResult<ApprovalSummary> {
    let context = project_context(&state, &project_id)?;
    let mut conn = db::open_existing_db(&context.db_path)?;
    db::decide_approval(&mut conn, &project_id, &approval_id, "Approved", &reason)
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
    db::decide_approval(&mut conn, &project_id, &approval_id, "Rejected", &reason)
}

fn open_project_from_path(
    path: &Path,
    state: &State<'_, AppState>,
    reconcile_stale_runs: bool,
) -> CommandResult<ProjectSnapshot> {
    let root = git::resolve_git_root(path)?;
    let conn = db::open_project_db(&root)?;
    let project = db::upsert_project(&conn, &root)?;
    if reconcile_stale_runs {
        db::reconcile_interrupted_runs(&conn, &project.id)?;
    }
    register_project_context(state, &project.id, &root)?;
    project_snapshot(&conn, &root, project)
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
        orchestrator: OrchestratorSettings {
            enabled: false,
            mode: "observe".to_string(),
            connection: None,
            model: None,
        },
    }
}

fn normalize_app_settings(mut settings: AppSettings) -> AppSettings {
    settings.version = 1;
    settings.orchestrator.mode = match settings.orchestrator.mode.as_str() {
        "gate" => "gate".to_string(),
        _ => "observe".to_string(),
    };
    settings.orchestrator.model = settings
        .orchestrator
        .model
        .and_then(|value| non_empty_string(&value));
    settings
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
                "Read {contextPackPath}, perform the {roleId} role, then write {summaryPath} and {resultPath} following {schemaPath}."
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
                "Read {contextPackPath}, perform the {roleId} role, then write {summaryPath} and {resultPath} following {schemaPath}."
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
            "defaultModel": "gpt-5.2",
            "availableModels": ["gpt-5.2", "gpt-5.4", "gpt-5.4-mini"],
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
                "-p",
                "Read {contextPackPath}, perform the {roleId} role, then write {summaryPath} and {resultPath} following {schemaPath}."
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
                "-p",
                "Read {contextPackPath}, perform the {roleId} role, then write {summaryPath} and {resultPath} following {schemaPath}."
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
            "availableModels": ["sonnet", "opus"],
            "defaultEffort": null
        }
    ])
}

fn claude_role_assignments() -> Value {
    assignments_for_connection("claude-local")
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
) -> CommandResult<Vec<PlanningCommandSpec>> {
    let planner_assignment = settings
        .role_assignments
        .as_array()
        .and_then(|items| {
            items
                .iter()
                .find(|item| item.get("roleId").and_then(Value::as_str) == Some("planner"))
        })
        .ok_or_else(|| CommandError::validation("planner 역할 배정을 찾을 수 없습니다."))?;

    let mut commands = Vec::new();
    let mut seen = HashSet::new();
    let mut failures = Vec::new();

    for selection in assignment_selections(planner_assignment) {
        push_planning_command_candidate(
            settings,
            project_root,
            input,
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

    match resolve_planning_command_for_connection(project_root, input, selection, connection) {
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
    let prompt = build_planner_prompt(project_root, input);
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
    placeholders.insert("planPrompt".to_string(), prompt);
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
        _ => Ok(Vec::new()),
    }
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
  "risks": ["string"]
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
        return stderr.to_string();
    }
    output.stdout.trim().to_string()
}

fn smoke_output_contains_sentinel(output: &ShellOutput) -> bool {
    output.stdout.contains(AI_CLI_SMOKE_SENTINEL) || output.stderr.contains(AI_CLI_SMOKE_SENTINEL)
}

fn ai_cli_failure_hint(provider: Option<&str>, raw_message: &str) -> String {
    let trimmed = raw_message.trim();
    let normalized = trimmed.to_lowercase();

    if provider == Some("claude") && normalized.contains("not logged in") {
        return "Claude CLI는 설치되어 있지만 로그인 상태가 아닙니다. 터미널에서 claude를 열고 /login을 실행한 뒤 다시 확인하세요.".to_string();
    }

    if provider == Some("claude") && normalized.contains("organization does not have access") {
        return "Claude CLI는 설치되어 있지만 현재 로그인된 조직에 Claude Code 접근 권한이 없습니다. 올바른 조직으로 다시 로그인하거나 관리자에게 권한을 요청해야 합니다.".to_string();
    }

    if trimmed.is_empty() {
        "응답 출력이 없습니다.".to_string()
    } else {
        trimmed.to_string()
    }
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

    let api_refresh = match provider {
        "codex" => refresh_openai_models(),
        "claude" => refresh_anthropic_models(),
        _ => ModelRefreshResult {
            models: None,
            message: Some("지원하지 않는 provider라 모델 목록을 갱신하지 않았습니다.".to_string()),
        },
    };

    if provider == "claude" {
        if let Some(models) = api_refresh.models.as_ref() {
            let mut models = models.clone();
            models.extend(claude_cli_model_aliases());
            models.sort();
            models.dedup();
            return ModelRefreshResult {
                message: api_refresh.message,
                models: Some(models),
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

fn refresh_openai_models() -> ModelRefreshResult {
    let Some(api_key) = env::var("OPENAI_API_KEY")
        .ok()
        .filter(|value| !value.is_empty())
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

fn refresh_anthropic_models() -> ModelRefreshResult {
    let Some(api_key) = env::var("ANTHROPIC_API_KEY")
        .ok()
        .filter(|value| !value.is_empty())
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
    if provider == "codex" {
        let debug_refresh = refresh_codex_debug_models(connection, cwd);
        return debug_refresh;
    }

    if provider == "claude" {
        let embedded_refresh = refresh_claude_embedded_models(connection);
        if embedded_refresh
            .models
            .as_ref()
            .is_some_and(|models| !models.is_empty())
        {
            return embedded_refresh;
        }
    }

    let Some(command) = cli_model_command(connection, provider, cwd) else {
        return ModelRefreshResult {
            models: None,
            message: Some("CLI /model fallback을 지원하지 않는 provider입니다.".to_string()),
        };
    };

    match run_pty_command_with_input(cwd, &command, "/model\n", Duration::from_secs(4)) {
        Ok(output) => {
            let text = strip_terminal_controls(&format!("{}\n{}", output.stdout, output.stderr));
            let mut models = extract_cli_model_ids(provider, &text);
            if provider == "claude" {
                models.extend(claude_cli_model_aliases());
                models.sort();
                models.dedup();
            }
            if models.is_empty() {
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
            models: Some(claude_cli_model_aliases()),
            message: Some(format!(
                "Claude CLI /model 실행은 실패했지만 기본 alias를 사용합니다. {}",
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
            models.extend(claude_cli_model_aliases());
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

fn refresh_codex_debug_models(connection: &Value, cwd: &Path) -> ModelRefreshResult {
    let binary = connection_cli_binary(connection).unwrap_or("codex");
    let command = vec![
        binary.to_string(),
        "debug".to_string(),
        "models".to_string(),
    ];
    match run_direct_command_with_timeout(cwd, &command, Duration::from_secs(10)) {
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
    matches!(id, "sonnet" | "opus")
        || (id.starts_with("claude-")
            && id
                .split(['-', '.', '_'])
                .any(|part| matches!(part, "sonnet" | "opus" | "haiku")))
}

fn claude_cli_model_aliases() -> Vec<String> {
    vec!["sonnet".to_string(), "opus".to_string()]
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

fn run_pty_command_with_input(
    cwd: &Path,
    command: &[String],
    input: &str,
    timeout: Duration,
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

fn spawn_pty_shell(
    project_id: &str,
    terminal_id: &str,
    cwd: &Path,
    cols: u16,
    rows: u16,
    node_bin_path: Option<&Path>,
    app: AppHandle,
) -> CommandResult<PtySession> {
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

    std::thread::spawn(move || {
        read_pty_output(
            reader,
            child_pid,
            terminal_id_for_thread,
            session_state_for_thread,
            app,
        );
    });

    Ok(PtySession {
        child_pid,
        writer,
        state: session_state,
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

fn resize_pty_writer(
    writer: &Arc<Mutex<fs::File>>,
    cols: u16,
    rows: u16,
) -> CommandResult<()> {
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

fn run_direct_command_with_timeout(
    cwd: &std::path::Path,
    command: &[String],
    timeout: Duration,
) -> CommandResult<ShellOutput> {
    if command.is_empty() {
        return Err(CommandError::validation(
            "실행할 planning command가 없습니다.",
        ));
    }
    let command = resolve_command_args(cwd, command);
    let started_at = Instant::now();
    let mut child = Command::new(&command[0])
        .args(&command[1..])
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            get_launch_state,
            open_project,
            open_project_by_id,
            forget_project,
            get_app_settings,
            update_app_settings,
            get_project_snapshot,
            get_effective_settings,
            update_project_settings,
            run_planner_conversation,
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
            update_task_status,
            get_task_worktree,
            ensure_task_worktree,
            list_audit_logs,
            get_repository_state,
            get_local_branches,
            get_recent_commits,
            get_changed_files,
            get_task_worktree_changed_files,
            switch_git_branch,
            list_node_runtimes,
            list_terminal_directories,
            run_terminal_command,
            resolve_terminal_cwd,
            start_terminal_pty,
            list_terminal_ptys,
            get_terminal_pty_snapshot,
            write_terminal_pty,
            resize_terminal_pty,
            stop_terminal_pty,
            run_stub_role,
            prepare_role_context,
            start_next_role_run,
            run_host_role,
            retry_host_role,
            cancel_host_role,
            list_agent_runs,
            list_task_timeline,
            list_run_events,
            get_agent_run,
            read_run_artifact,
            list_approvals,
            approve_approval,
            reject_approval
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Helm desktop");
}
