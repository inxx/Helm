mod db;
mod git;
mod models;

use crate::models::{
    AgentRunSummary, AiConnectionCheckResult, ApprovalSummary, CommandError, CommandResult,
    CreateEpicInput, CreateTaskInput, EffectiveSettings, EpicSummary, GitBranchSummary,
    GitCommitSummary, GitFileStatus, GitRepositoryState, ProjectContext, ProjectSettingsPatch,
    ProjectSnapshot, ProjectSummary, RunnerCheckResult, RunnerTemplateSummary, TaskSummary,
    TaskWorktreeSummary, TerminalCommandResult,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State};

const MAX_RECENT_PROJECTS: usize = 12;

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
            worktree_root: None,
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

    let check = if command
        .iter()
        .any(|part| part.contains("fixture-runner.mjs"))
    {
        Command::new(&command[0])
            .args(&command[1..])
            .arg("--health")
            .output()
    } else {
        Command::new(&command[0]).arg("--version").output()
    };

    match check {
        Ok(output) if output.status.success() => Ok(RunnerCheckResult {
            role_id,
            available: true,
            command,
            message: "runner command를 실행할 수 있습니다.".to_string(),
        }),
        Ok(output) => Ok(RunnerCheckResult {
            role_id,
            available: false,
            command,
            message: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        }),
        Err(err) => Ok(RunnerCheckResult {
            role_id,
            available: false,
            command,
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
    let _ = project_context(&state, &project_id)?;
    let connection_id = connection
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    let command = connection_command_for_check(&connection)?;
    if command.is_empty() {
        return Ok(AiConnectionCheckResult {
            connection_id,
            available: false,
            command,
            message: "AI 연결에 command가 없습니다.".to_string(),
        });
    }

    let check = if command
        .iter()
        .any(|part| part.contains("fixture-runner.mjs"))
    {
        Command::new(&command[0])
            .args(&command[1..])
            .arg("--health")
            .output()
    } else {
        Command::new(&command[0]).args(&command[1..]).output()
    };

    match check {
        Ok(output) if output.status.success() => Ok(AiConnectionCheckResult {
            connection_id,
            available: true,
            command,
            message: "AI 연결 command를 실행할 수 있습니다.".to_string(),
        }),
        Ok(output) => {
            let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
            Ok(AiConnectionCheckResult {
                connection_id,
                available: false,
                command,
                message: if message.is_empty() {
                    String::from_utf8_lossy(&output.stdout).trim().to_string()
                } else {
                    message
                },
            })
        }
        Err(err) => Ok(AiConnectionCheckResult {
            connection_id,
            available: false,
            command,
            message: err.to_string(),
        }),
    }
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
fn run_host_role(
    project_id: String,
    run_id: String,
    state: State<'_, AppState>,
) -> CommandResult<AgentRunSummary> {
    let context = project_context(&state, &project_id)?;
    let mut conn = db::open_existing_db(&context.db_path)?;
    let cancellation = Arc::new(AtomicBool::new(false));
    {
        let mut running_runs = state
            .running_runs
            .lock()
            .map_err(|_| CommandError::new("IoFailed", "실행 상태를 갱신하지 못했습니다."))?;
        if running_runs.contains_key(&run_id) {
            return Err(CommandError::validation("이미 실행 중인 host run입니다."));
        }
        running_runs.insert(run_id.clone(), cancellation.clone());
    }
    let result = db::run_host_role(
        &mut conn,
        &context.root_path,
        &project_id,
        &run_id,
        cancellation,
    );
    if let Ok(mut running_runs) = state.running_runs.lock() {
        running_runs.remove(&run_id);
    }
    result
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

struct RunnerTemplate {
    id: &'static str,
    label: &'static str,
    description: &'static str,
    presets: fn() -> Value,
    connections: fn() -> Value,
    assignments: fn() -> Value,
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
            "healthCheckArgs": ["node", script],
            "timeoutSeconds": 60,
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
            "healthCheckArgs": ["codex", "--version"],
            "timeoutSeconds": 1800,
            "enabled": true,
            "defaultModel": "gpt-5.2",
            "availableModels": ["gpt-5.2", "gpt-5.4", "gpt-5.4-mini"]
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
            "healthCheckArgs": ["claude", "--version"],
            "timeoutSeconds": 1800,
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

fn connection_command_for_check(connection: &Value) -> CommandResult<Vec<String>> {
    if let Some(args) = connection.get("healthCheckArgs").and_then(Value::as_array) {
        return string_array(args, "healthCheckArgs는 문자열 배열이어야 합니다.");
    }
    if let Some(args) = connection.get("commandArgs").and_then(Value::as_array) {
        return string_array(args, "commandArgs는 문자열 배열이어야 합니다.");
    }
    Ok(Vec::new())
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
}

fn run_shell_command(
    cwd: &std::path::Path,
    command: &str,
    timeout: Duration,
) -> CommandResult<ShellOutput> {
    let mut child = Command::new("/bin/zsh")
        .args(["-lc", command])
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| CommandError::io("터미널 명령을 실행하지 못했습니다.", err))?;
    let deadline = Instant::now() + timeout;

    loop {
        if child
            .try_wait()
            .map_err(|err| CommandError::io("터미널 명령 상태를 확인하지 못했습니다.", err))?
            .is_some()
        {
            let output = child
                .wait_with_output()
                .map_err(|err| CommandError::io("터미널 출력을 읽지 못했습니다.", err))?;
            return Ok(ShellOutput {
                stdout: truncate_output(String::from_utf8_lossy(&output.stdout).to_string()),
                stderr: truncate_output(String::from_utf8_lossy(&output.stderr).to_string()),
                exit_code: output.status.code().unwrap_or(-1),
                timed_out: false,
            });
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let output = child.wait_with_output().map_err(|err| {
                CommandError::io("timeout 된 터미널 출력을 읽지 못했습니다.", err)
            })?;
            return Ok(ShellOutput {
                stdout: truncate_output(String::from_utf8_lossy(&output.stdout).to_string()),
                stderr: truncate_output(String::from_utf8_lossy(&output.stderr).to_string()),
                exit_code: -1,
                timed_out: true,
            });
        }
        std::thread::sleep(Duration::from_millis(100));
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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            get_launch_state,
            open_project,
            get_project_snapshot,
            get_effective_settings,
            update_project_settings,
            list_runner_templates,
            apply_runner_template,
            check_role_runner,
            check_ai_connection,
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
            run_terminal_command,
            resolve_terminal_cwd,
            run_stub_role,
            prepare_role_context,
            run_host_role,
            retry_host_role,
            cancel_host_role,
            list_agent_runs,
            get_agent_run,
            read_run_artifact,
            list_approvals,
            approve_approval,
            reject_approval
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Helm desktop");
}
