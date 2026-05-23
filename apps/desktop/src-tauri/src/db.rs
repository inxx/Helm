use crate::git;
use crate::models::{
    AgentRunSummary, ApprovalSummary, AuditLogEntry, CommandError, CommandResult, CreateEpicInput,
    CreateTaskInput, EffectiveSettings, EpicSummary, GitFileStatus, ProjectSettingsPatch,
    ProjectSummary, TaskCounts, TaskExternalRefInput, TaskExternalRefSummary, TaskSummary,
    TaskTimelineEntry, TaskWorktreeSummary,
};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};
use uuid::Uuid;

const SUPPORTED_SCHEMA_VERSION: i64 = 4;
const PHASE1_MIGRATION: &str = include_str!("../migrations/0001_phase1.sql");
const PHASE2_MIGRATION: &str = include_str!("../migrations/0002_phase2_runs_approvals.sql");
const PHASE3A_MIGRATION: &str = include_str!("../migrations/0003_phase3a_worktrees.sql");
const PHASE4_MIGRATION: &str = include_str!("../migrations/0004_evidence_gate_timeline.sql");

pub fn now() -> String {
    Utc::now().to_rfc3339()
}

pub fn new_id() -> String {
    Uuid::now_v7().to_string()
}

pub fn open_project_db(root: &Path) -> CommandResult<Connection> {
    let helm_dir = root.join(".helm");
    fs::create_dir_all(&helm_dir).map_err(|err| {
        CommandError::io(
            "프로젝트에 Helm 데이터를 만들 수 없습니다. 폴더 권한을 확인해주세요.",
            err,
        )
    })?;
    let db_path = helm_dir.join("helm.sqlite");
    let mut conn = Connection::open(&db_path)
        .map_err(|err| CommandError::database("Helm 데이터베이스를 열 수 없습니다.", err))?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(|err| CommandError::database("Helm 데이터베이스 설정에 실패했습니다.", err))?;
    run_migrations(&mut conn)?;
    Ok(conn)
}

pub fn open_existing_db(db_path: &Path) -> CommandResult<Connection> {
    let conn = Connection::open(db_path)
        .map_err(|err| CommandError::database("Helm 데이터베이스를 열 수 없습니다.", err))?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(|err| CommandError::database("Helm 데이터베이스 설정에 실패했습니다.", err))?;
    Ok(conn)
}

pub fn run_migrations(conn: &mut Connection) -> CommandResult<()> {
    let current_version = schema_version(conn)?;
    if current_version > SUPPORTED_SCHEMA_VERSION {
        return Err(CommandError::new(
            "SchemaTooNew",
            "더 최신 버전의 Helm에서 만든 데이터입니다. 앱을 업데이트해주세요.",
        ));
    }
    if current_version < 1 {
        apply_migration(conn, 1, "phase1", PHASE1_MIGRATION)?;
    }
    if current_version < 2 {
        apply_migration(conn, 2, "phase2_runs_approvals", PHASE2_MIGRATION)?;
    }
    if current_version < 3 {
        apply_migration(conn, 3, "phase3a_worktrees", PHASE3A_MIGRATION)?;
    }
    if current_version < 4 {
        apply_migration(conn, 4, "evidence_gate_timeline", PHASE4_MIGRATION)?;
    }
    Ok(())
}

fn apply_migration(
    conn: &mut Connection,
    version: i64,
    name: &str,
    sql: &str,
) -> CommandResult<()> {
    let tx = conn
        .transaction()
        .map_err(|err| CommandError::database("Helm 데이터베이스 업데이트에 실패했습니다.", err))?;
    tx.execute_batch(sql)
        .map_err(|err| CommandError::database("Helm 데이터베이스 업데이트에 실패했습니다.", err))?;
    tx.execute(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?1, ?2, ?3)",
        params![version, name, now()],
    )
    .map_err(|err| CommandError::database("Helm 데이터베이스 업데이트에 실패했습니다.", err))?;
    tx.commit()
        .map_err(|err| CommandError::database("Helm 데이터베이스 업데이트에 실패했습니다.", err))?;
    Ok(())
}

fn schema_version(conn: &Connection) -> CommandResult<i64> {
    let table_exists: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| CommandError::database("Helm 데이터베이스를 확인하지 못했습니다.", err))?;
    if table_exists.is_none() {
        return Ok(0);
    }

    conn.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
        [],
        |row| row.get(0),
    )
    .map_err(|err| CommandError::database("Helm 데이터베이스를 확인하지 못했습니다.", err))
}

pub fn upsert_project(conn: &Connection, root: &Path) -> CommandResult<ProjectSummary> {
    let root_path = root.to_string_lossy().to_string();
    let name = root
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| root_path.clone());
    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM projects WHERE root_path = ?1",
            params![root_path],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| CommandError::database("프로젝트 정보를 읽지 못했습니다.", err))?;
    let timestamp = now();
    let id = existing.unwrap_or_else(new_id);
    let base_branch = git::repository_state(root)
        .ok()
        .and_then(|state| state.current_branch);

    conn.execute(
        "INSERT INTO projects (id, root_path, name, base_branch, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)
         ON CONFLICT(root_path) DO UPDATE SET
           name = excluded.name,
           base_branch = excluded.base_branch,
           updated_at = excluded.updated_at",
        params![id, root_path, name, base_branch, timestamp],
    )
    .map_err(|err| CommandError::database("프로젝트 정보를 저장하지 못했습니다.", err))?;

    get_project(conn, &id)
}

pub fn get_project(conn: &Connection, project_id: &str) -> CommandResult<ProjectSummary> {
    conn.query_row(
        "SELECT id, root_path, name, base_branch, created_at, updated_at FROM projects WHERE id = ?1",
        params![project_id],
        |row| {
            Ok(ProjectSummary {
                id: row.get(0)?,
                root_path: row.get(1)?,
                name: row.get(2)?,
                base_branch: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        },
    )
    .map_err(|err| CommandError::with_details("ProjectNotOpen", "프로젝트가 열려 있지 않습니다.", err))
}

pub fn effective_settings(conn: &Connection, project_id: &str) -> CommandResult<EffectiveSettings> {
    let mut settings = HashMap::new();
    let mut stmt = conn
        .prepare("SELECT key, value_json FROM project_settings WHERE project_id = ?1")
        .map_err(|err| CommandError::database("설정을 읽지 못했습니다.", err))?;
    let rows = stmt
        .query_map(params![project_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|err| CommandError::database("설정을 읽지 못했습니다.", err))?;
    for row in rows {
        let (key, raw) =
            row.map_err(|err| CommandError::database("설정을 읽지 못했습니다.", err))?;
        let value: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
        settings.insert(key, value);
    }

    Ok(EffectiveSettings {
        role_presets: settings
            .remove("rolePresets")
            .unwrap_or_else(default_role_presets),
        ai_connections: settings
            .remove("aiConnections")
            .unwrap_or_else(default_ai_connections),
        role_assignments: settings
            .remove("roleAssignments")
            .unwrap_or_else(default_role_assignments),
        worktree_root: settings
            .remove("worktreeRoot")
            .and_then(|value| value.as_str().map(str::to_string)),
        jira_config: settings.remove("jiraConfig"),
        obsidian_vault_path: settings
            .remove("obsidianVaultPath")
            .and_then(|value| value.as_str().map(str::to_string)),
        token_budget: settings
            .remove("tokenBudget")
            .and_then(|value| value.as_i64()),
        artifact_retention_days: settings
            .remove("artifactRetentionDays")
            .and_then(|value| value.as_i64())
            .or(Some(30)),
    })
}

pub fn update_settings(
    conn: &Connection,
    project_id: &str,
    patch: ProjectSettingsPatch,
) -> CommandResult<EffectiveSettings> {
    get_project(conn, project_id)?;
    let timestamp = now();
    let mut values = Vec::new();
    if let Some(value) = patch.role_presets {
        values.push(("rolePresets", value));
    }
    if let Some(value) = patch.ai_connections {
        values.push(("aiConnections", value));
    }
    if let Some(value) = patch.role_assignments {
        values.push(("roleAssignments", value));
    }
    if let Some(value) = patch.worktree_root {
        values.push(("worktreeRoot", option_string(value)));
    }
    if let Some(value) = patch.jira_config {
        values.push(("jiraConfig", value.unwrap_or(Value::Null)));
    }
    if let Some(value) = patch.obsidian_vault_path {
        values.push(("obsidianVaultPath", option_string(value)));
    }
    if let Some(value) = patch.token_budget {
        values.push(("tokenBudget", option_i64(value)));
    }
    if let Some(value) = patch.artifact_retention_days {
        values.push(("artifactRetentionDays", option_i64(value)));
    }

    for (key, value) in values {
        conn.execute(
            "INSERT INTO project_settings (project_id, key, value_json, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(project_id, key) DO UPDATE SET
               value_json = excluded.value_json,
               updated_at = excluded.updated_at",
            params![project_id, key, value.to_string(), timestamp],
        )
        .map_err(|err| CommandError::database("설정을 저장하지 못했습니다.", err))?;
    }
    effective_settings(conn, project_id)
}

pub fn create_epic(
    conn: &mut Connection,
    project_id: &str,
    input: CreateEpicInput,
) -> CommandResult<EpicSummary> {
    get_project(conn, project_id)?;
    let title = required_text(&input.title, "에픽 제목을 입력해주세요.")?;
    let id = new_id();
    let timestamp = now();
    let tx = conn
        .transaction()
        .map_err(|err| CommandError::database("에픽을 저장하지 못했습니다.", err))?;
    tx.execute(
        "INSERT INTO epics (id, project_id, title, status, plan_path, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'Drafting', ?4, ?5, ?5)",
        params![id, project_id, title, input.plan_path, timestamp],
    )
    .map_err(|err| CommandError::database("에픽을 저장하지 못했습니다.", err))?;
    insert_audit(
        &tx,
        project_id,
        "Epic",
        Some(&id),
        "epic.created",
        json!({ "epicId": id, "title": title }),
    )?;
    tx.commit()
        .map_err(|err| CommandError::database("에픽을 저장하지 못했습니다.", err))?;
    get_epic(conn, &id)
}

pub fn list_epics(conn: &Connection, project_id: &str) -> CommandResult<Vec<EpicSummary>> {
    let mut stmt = conn
        .prepare(
            "SELECT id, project_id, title, status, plan_path, created_at, updated_at
             FROM epics WHERE project_id = ?1 ORDER BY created_at ASC",
        )
        .map_err(|err| CommandError::database("에픽 목록을 읽지 못했습니다.", err))?;
    let rows = stmt
        .query_map(params![project_id], map_epic)
        .map_err(|err| CommandError::database("에픽 목록을 읽지 못했습니다.", err))?;
    collect_rows(rows, "에픽 목록을 읽지 못했습니다.")
}

pub fn create_task(
    conn: &mut Connection,
    project_id: &str,
    input: CreateTaskInput,
) -> CommandResult<TaskSummary> {
    get_project(conn, project_id)?;
    let title = required_text(&input.title, "태스크 제목을 입력해주세요.")?;
    let description = input.description.unwrap_or_default();
    if let Some(epic_id) = input.epic_id.as_deref() {
        ensure_epic_exists(conn, project_id, epic_id)?;
    }
    let external_refs = input.external_refs.unwrap_or_default();
    for external_ref in &external_refs {
        validate_external_ref(external_ref)?;
    }

    let id = new_id();
    let timestamp = now();
    let sort_order = next_task_sort_order(conn, project_id)?;
    let tx = conn
        .transaction()
        .map_err(|err| CommandError::database("태스크를 저장하지 못했습니다.", err))?;
    tx.execute(
        "INSERT INTO tasks (
           id, project_id, epic_id, title, description, status, sort_order,
           created_at, updated_at, last_transition_at
         )
         VALUES (?1, ?2, ?3, ?4, ?5, 'Planned', ?6, ?7, ?7, ?7)",
        params![
            id,
            project_id,
            input.epic_id,
            title,
            description,
            sort_order,
            timestamp
        ],
    )
    .map_err(|err| CommandError::database("태스크를 저장하지 못했습니다.", err))?;

    for external_ref in external_refs {
        tx.execute(
            "INSERT INTO task_external_refs (id, project_id, task_id, ref_type, ref_value, ref_title, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                new_id(),
                project_id,
                id,
                external_ref.ref_type,
                external_ref.ref_value.trim(),
                external_ref.ref_title,
                timestamp
            ],
        )
        .map_err(|err| CommandError::database("외부 참조를 저장하지 못했습니다.", err))?;
    }

    insert_audit(
        &tx,
        project_id,
        "Task",
        Some(&id),
        "task.created",
        json!({ "taskId": id, "title": title, "status": "Planned" }),
    )?;
    tx.commit()
        .map_err(|err| CommandError::database("태스크를 저장하지 못했습니다.", err))?;
    get_task(conn, &id)
}

pub fn list_tasks(conn: &Connection, project_id: &str) -> CommandResult<Vec<TaskSummary>> {
    let mut stmt = conn
        .prepare(
            "SELECT id, project_id, epic_id, title, description, status, status_reason, sort_order,
                    created_at, updated_at, last_transition_at
             FROM tasks WHERE project_id = ?1 ORDER BY sort_order ASC, created_at ASC",
        )
        .map_err(|err| CommandError::database("태스크 목록을 읽지 못했습니다.", err))?;
    let rows = stmt
        .query_map(params![project_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, String>(9)?,
                row.get::<_, String>(10)?,
            ))
        })
        .map_err(|err| CommandError::database("태스크 목록을 읽지 못했습니다.", err))?;

    let mut tasks = Vec::new();
    for row in rows {
        let (
            id,
            project_id,
            epic_id,
            title,
            description,
            status,
            status_reason,
            sort_order,
            created_at,
            updated_at,
            last_transition_at,
        ) = row.map_err(|err| CommandError::database("태스크 목록을 읽지 못했습니다.", err))?;
        let external_refs = list_external_refs(conn, &id)?;
        tasks.push(TaskSummary {
            id,
            project_id,
            epic_id,
            title,
            description,
            status,
            status_reason,
            sort_order,
            external_refs,
            created_at,
            updated_at,
            last_transition_at,
        });
    }
    Ok(tasks)
}

pub fn update_task_status(
    conn: &mut Connection,
    project_id: &str,
    task_id: &str,
    status: &str,
    status_reason: Option<String>,
) -> CommandResult<TaskSummary> {
    validate_task_status(status)?;
    let task = get_task(conn, task_id)?;
    if task.project_id != project_id {
        return Err(CommandError::validation("대상 태스크를 찾을 수 없습니다."));
    }
    let timestamp = now();
    let tx = conn
        .transaction()
        .map_err(|err| CommandError::database("태스크 상태를 저장하지 못했습니다.", err))?;
    tx.execute(
        "UPDATE tasks
         SET status = ?1, status_reason = ?2, updated_at = ?3, last_transition_at = ?3
         WHERE id = ?4 AND project_id = ?5",
        params![status, status_reason, timestamp, task_id, project_id],
    )
    .map_err(|err| CommandError::database("태스크 상태를 저장하지 못했습니다.", err))?;
    insert_audit(
        &tx,
        project_id,
        "Task",
        Some(task_id),
        "task.status_changed",
        json!({
            "taskId": task_id,
            "from": task.status,
            "to": status,
            "reason": status_reason,
            "source": "manual"
        }),
    )?;
    tx.commit()
        .map_err(|err| CommandError::database("태스크 상태를 저장하지 못했습니다.", err))?;
    get_task(conn, task_id)
}

pub fn get_task_worktree(
    conn: &Connection,
    project_id: &str,
    task_id: &str,
) -> CommandResult<Option<TaskWorktreeSummary>> {
    conn.query_row(
        "SELECT id, project_id, task_id, branch_name, worktree_path, base_branch, head_hash,
                status, created_at, updated_at
         FROM task_worktrees WHERE project_id = ?1 AND task_id = ?2",
        params![project_id, task_id],
        map_task_worktree,
    )
    .optional()
    .map_err(|err| CommandError::database("태스크 worktree를 읽지 못했습니다.", err))
}

pub fn ensure_task_worktree(
    conn: &mut Connection,
    root: &Path,
    project_id: &str,
    task_id: &str,
) -> CommandResult<TaskWorktreeSummary> {
    if let Some(worktree) = get_task_worktree(conn, project_id, task_id)? {
        insert_audit(
            conn,
            project_id,
            "Task",
            Some(task_id),
            "task_worktree.reused",
            json!({
                "taskId": task_id,
                "worktreePath": worktree.worktree_path,
                "branchName": worktree.branch_name
            }),
        )?;
        return Ok(worktree);
    }

    let task = get_task(conn, task_id)?;
    if task.project_id != project_id {
        return Err(CommandError::validation("대상 태스크를 찾을 수 없습니다."));
    }

    let project = get_project(conn, project_id)?;
    let settings = effective_settings(conn, project_id)?;
    let base_ref = project
        .base_branch
        .clone()
        .or_else(|| git::current_branch(root))
        .or_else(|| git::head_hash(root))
        .ok_or_else(|| {
            CommandError::validation("worktree 기준이 되는 Git HEAD를 찾을 수 없습니다.")
        })?;
    let worktree_root = resolve_worktree_root(root, settings.worktree_root.as_deref());
    let slug = task_slug(&task.title, &task.id);
    let worktree_path = worktree_root.join(&slug);
    if worktree_path.exists() {
        return Err(CommandError::validation(
            "태스크 worktree 경로가 이미 존재합니다. 프로젝트 설정의 worktreeRoot를 확인해주세요.",
        ));
    }

    let branch_name = unique_task_branch(root, &slug)?;
    fs::create_dir_all(&worktree_root)
        .map_err(|err| CommandError::io("worktree 루트 폴더를 만들지 못했습니다.", err))?;
    git::add_worktree(root, &worktree_path, &branch_name, &base_ref)?;

    let id = new_id();
    let timestamp = now();
    let worktree_path_text = worktree_path.to_string_lossy().to_string();
    let head_hash = git::head_hash(&worktree_path);
    let tx = conn
        .transaction()
        .map_err(|err| CommandError::database("태스크 worktree를 저장하지 못했습니다.", err))?;
    tx.execute(
        "INSERT INTO task_worktrees (
           id, project_id, task_id, branch_name, worktree_path, base_branch, head_hash,
           status, created_at, updated_at
         )
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'Active', ?8, ?8)",
        params![
            id,
            project_id,
            task_id,
            branch_name.as_str(),
            worktree_path_text.as_str(),
            base_ref.as_str(),
            head_hash,
            timestamp
        ],
    )
    .map_err(|err| CommandError::database("태스크 worktree를 저장하지 못했습니다.", err))?;
    insert_audit(
        &tx,
        project_id,
        "Task",
        Some(task_id),
        "task_worktree.created",
        json!({
            "taskId": task_id,
            "worktreePath": worktree_path_text,
            "branchName": branch_name,
            "baseRef": base_ref
        }),
    )?;
    tx.commit()
        .map_err(|err| CommandError::database("태스크 worktree를 저장하지 못했습니다.", err))?;
    get_task_worktree(conn, project_id, task_id)?
        .ok_or_else(|| CommandError::validation("태스크 worktree를 찾을 수 없습니다."))
}

pub fn audit_tail(
    conn: &Connection,
    project_id: &str,
    limit: i64,
) -> CommandResult<Vec<AuditLogEntry>> {
    let mut stmt = conn
        .prepare(
            "SELECT id, project_id, entity_type, entity_id, event_type, payload_json, created_at
             FROM audit_logs WHERE project_id = ?1 ORDER BY created_at DESC LIMIT ?2",
        )
        .map_err(|err| CommandError::database("감사 로그를 읽지 못했습니다.", err))?;
    let rows = stmt
        .query_map(params![project_id, limit.clamp(1, 100)], |row| {
            let payload_raw: String = row.get(5)?;
            Ok(AuditLogEntry {
                id: row.get(0)?,
                project_id: row.get(1)?,
                entity_type: row.get(2)?,
                entity_id: row.get(3)?,
                event_type: row.get(4)?,
                payload: serde_json::from_str(&payload_raw).unwrap_or(Value::Null),
                created_at: row.get(6)?,
            })
        })
        .map_err(|err| CommandError::database("감사 로그를 읽지 못했습니다.", err))?;
    collect_rows(rows, "감사 로그를 읽지 못했습니다.")
}

pub fn run_stub_role(
    conn: &mut Connection,
    root: &Path,
    project_id: &str,
    task_id: &str,
    role_id: &str,
) -> CommandResult<AgentRunSummary> {
    validate_role_id(role_id)?;
    let task = get_task(conn, task_id)?;
    if task.project_id != project_id {
        return Err(CommandError::validation("대상 태스크를 찾을 수 없습니다."));
    }
    validate_role_run_state(conn, project_id, &task, role_id)?;

    let run_id = new_id();
    let artifact_dir = format!(".helm/artifacts/runs/{run_id}");
    validate_relative_artifact_path(&artifact_dir)?;
    let summary_path = format!("{artifact_dir}/summary.md");
    let result_path = format!("{artifact_dir}/structured-result.json");
    let stdout_log_path = format!("{artifact_dir}/stdout.log");
    let stderr_log_path = format!("{artifact_dir}/stderr.log");
    let artifact_abs_dir = root.join(&artifact_dir);
    fs::create_dir_all(&artifact_abs_dir)
        .map_err(|err| CommandError::io("실행 산출물을 저장하지 못했습니다.", err))?;

    let summary = stub_summary(role_id);
    let result = stub_result(role_id);
    fs::write(artifact_abs_dir.join("summary.md"), summary)
        .map_err(|err| CommandError::io("실행 산출물을 저장하지 못했습니다.", err))?;
    fs::write(
        artifact_abs_dir.join("structured-result.json"),
        result.to_string(),
    )
    .map_err(|err| CommandError::io("실행 산출물을 저장하지 못했습니다.", err))?;
    fs::write(
        artifact_abs_dir.join("stdout.log"),
        "stub role run completed\n",
    )
    .map_err(|err| CommandError::io("실행 산출물을 저장하지 못했습니다.", err))?;
    fs::write(artifact_abs_dir.join("stderr.log"), "")
        .map_err(|err| CommandError::io("실행 산출물을 저장하지 못했습니다.", err))?;
    fs::write(artifact_abs_dir.join("changed-files.json"), "[]")
        .map_err(|err| CommandError::io("실행 산출물을 저장하지 못했습니다.", err))?;
    fs::write(artifact_abs_dir.join("diff.patch"), "")
        .map_err(|err| CommandError::io("실행 산출물을 저장하지 못했습니다.", err))?;

    let result_status = validate_structured_result(&result)
        .then_some("pass".to_string())
        .ok_or_else(|| CommandError::validation("실행 결과 JSON을 읽을 수 없습니다."))?;

    let timestamp = now();
    let mut created_approval_id = None;
    let next_status = next_status_for_role(role_id);
    let tx = conn
        .transaction()
        .map_err(|err| CommandError::database("Helm 데이터 저장에 실패했습니다.", err))?;
    tx.execute(
        "INSERT INTO agent_runs (
           id, project_id, task_id, role_id, status, artifact_dir, summary_path, result_path,
           stdout_log_path, stderr_log_path, exit_code, result_status, started_at, finished_at,
           created_at, updated_at
         )
         VALUES (?1, ?2, ?3, ?4, 'Succeeded', ?5, ?6, ?7, ?8, ?9, 0, ?10, ?11, ?11, ?11, ?11)",
        params![
            run_id,
            project_id,
            task_id,
            role_id,
            artifact_dir,
            summary_path,
            result_path,
            stdout_log_path,
            stderr_log_path,
            result_status,
            timestamp
        ],
    )
    .map_err(|err| CommandError::database("Helm 데이터 저장에 실패했습니다.", err))?;
    insert_audit(
        &tx,
        project_id,
        "AgentRun",
        Some(&run_id),
        "agent_run.created",
        json!({
            "runId": run_id,
            "taskId": task_id,
            "roleId": role_id,
            "artifactDir": artifact_dir
        }),
    )?;
    insert_audit(
        &tx,
        project_id,
        "AgentRun",
        Some(&run_id),
        "agent_run.finished",
        json!({
            "runId": run_id,
            "taskId": task_id,
            "roleId": role_id,
            "status": "Succeeded",
            "resultStatus": "pass",
            "exitCode": 0
        }),
    )?;

    if role_id == "planner" {
        let approval_id = new_id();
        tx.execute(
            "INSERT INTO approvals (
               id, project_id, entity_type, entity_id, approval_type, status,
               requested_reason, requested_at, created_at, updated_at
             )
             VALUES (?1, ?2, 'Task', ?3, 'PlanApproval', 'Pending', ?4, ?5, ?5, ?5)",
            params![
                approval_id,
                project_id,
                task_id,
                "planner stub run completed",
                timestamp
            ],
        )
        .map_err(|err| CommandError::database("승인 요청을 저장하지 못했습니다.", err))?;
        insert_audit(
            &tx,
            project_id,
            "Task",
            Some(task_id),
            "approval.created",
            json!({
                "approvalId": approval_id,
                "approvalType": "PlanApproval",
                "entityType": "Task",
                "entityId": task_id,
                "requestedReason": "planner stub run completed"
            }),
        )?;
        created_approval_id = Some(approval_id);
    } else if let Some(status) = next_status {
        tx.execute(
            "UPDATE tasks
             SET status = ?1, status_reason = NULL, updated_at = ?2, last_transition_at = ?2
             WHERE id = ?3 AND project_id = ?4",
            params![status, timestamp, task_id, project_id],
        )
        .map_err(|err| CommandError::database("태스크 상태를 저장하지 못했습니다.", err))?;
        insert_audit(
            &tx,
            project_id,
            "Task",
            Some(task_id),
            "task.status_changed",
            json!({
                "taskId": task_id,
                "from": task.status,
                "to": status,
                "reason": format!("{role_id} stub run succeeded"),
                "source": "agent_run"
            }),
        )?;
    }
    tx.commit()
        .map_err(|err| CommandError::database("Helm 데이터 저장에 실패했습니다.", err))?;

    let _ = created_approval_id;
    get_agent_run(conn, &run_id)
}

pub fn prepare_role_context(
    conn: &mut Connection,
    root: &Path,
    project_id: &str,
    task_id: &str,
    role_id: &str,
) -> CommandResult<AgentRunSummary> {
    validate_role_id(role_id)?;
    let task = get_task(conn, task_id)?;
    if task.project_id != project_id {
        return Err(CommandError::validation("대상 태스크를 찾을 수 없습니다."));
    }
    validate_role_run_state(conn, project_id, &task, role_id)?;
    let worktree = get_task_worktree(conn, project_id, task_id)?.ok_or_else(|| {
        CommandError::validation("role 실행 전에 태스크 worktree를 먼저 준비해주세요.")
    })?;
    if has_active_run(conn, project_id, task_id)? {
        return Err(CommandError::validation(
            "이미 준비 중이거나 실행 중인 role run이 있습니다.",
        ));
    }

    let run_id = new_id();
    let timestamp = now();
    let artifact_dir = format!(".helm/artifacts/runs/{run_id}");
    validate_relative_artifact_path(&artifact_dir)?;
    let artifact_path = root.join(&artifact_dir);
    fs::create_dir_all(&artifact_path)
        .map_err(|err| CommandError::io("실행 산출물 폴더를 만들지 못했습니다.", err))?;

    let context_pack = build_context_pack_markdown(root, &task, &worktree, role_id)?;
    let context_manifest = build_context_manifest(root, &task, &worktree, role_id)?;
    let placeholder_result = json!({
        "schemaVersion": 1,
        "status": "needs_changes",
        "summary": "Context Pack이 준비되었고 host runner 실행을 기다리고 있습니다.",
        "changedFiles": [],
        "risks": ["아직 실제 host runner가 실행되지 않았습니다."],
        "nextActions": ["run_host_role 실행"],
        "gateResult": null
    });
    fs::write(artifact_path.join("context-pack.md"), context_pack)
        .map_err(|err| CommandError::io("Context Pack을 저장하지 못했습니다.", err))?;
    fs::write(
        artifact_path.join("context-pack.json"),
        serde_json::to_string_pretty(&context_manifest)
            .map_err(|err| CommandError::io("Context Pack manifest를 만들지 못했습니다.", err))?,
    )
    .map_err(|err| CommandError::io("Context Pack manifest를 저장하지 못했습니다.", err))?;
    fs::write(
        artifact_path.join("structured-result.schema.json"),
        include_str!("../schemas/structured-result.schema.json"),
    )
    .map_err(|err| CommandError::io("structured result schema를 저장하지 못했습니다.", err))?;
    fs::write(
        artifact_path.join("summary.md"),
        "# Host Run Queued\n\nContext Pack이 준비되었고 실제 host runner 실행 전입니다.\n",
    )
    .map_err(|err| CommandError::io("실행 요약을 저장하지 못했습니다.", err))?;
    fs::write(
        artifact_path.join("structured-result.json"),
        serde_json::to_string_pretty(&placeholder_result)
            .map_err(|err| CommandError::io("structured result를 만들지 못했습니다.", err))?,
    )
    .map_err(|err| CommandError::io("structured result를 저장하지 못했습니다.", err))?;
    fs::write(artifact_path.join("stdout.log"), "")
        .map_err(|err| CommandError::io("stdout 로그를 저장하지 못했습니다.", err))?;
    fs::write(artifact_path.join("stderr.log"), "")
        .map_err(|err| CommandError::io("stderr 로그를 저장하지 못했습니다.", err))?;

    let tx = conn
        .transaction()
        .map_err(|err| CommandError::database("실행 컨텍스트를 저장하지 못했습니다.", err))?;
    tx.execute(
        "INSERT INTO agent_runs (
           id, project_id, task_id, role_id, status, artifact_dir, summary_path, result_path,
           stdout_log_path, stderr_log_path, exit_code, result_status, started_at, finished_at,
           created_at, updated_at
         )
         VALUES (?1, ?2, ?3, ?4, 'Queued', ?5, ?6, ?7, ?8, ?9, NULL, NULL, NULL, NULL, ?10, ?10)",
        params![
            run_id,
            project_id,
            task_id,
            role_id,
            artifact_dir,
            "summary.md",
            "structured-result.json",
            "stdout.log",
            "stderr.log",
            timestamp
        ],
    )
    .map_err(|err| CommandError::database("실행 컨텍스트를 저장하지 못했습니다.", err))?;
    insert_audit(
        &tx,
        project_id,
        "AgentRun",
        Some(&run_id),
        "agent_run.context_prepared",
        json!({
            "runId": run_id,
            "taskId": task_id,
            "roleId": role_id,
            "artifactDir": artifact_dir,
            "worktreePath": worktree.worktree_path
        }),
    )?;
    tx.commit()
        .map_err(|err| CommandError::database("실행 컨텍스트를 저장하지 못했습니다.", err))?;
    get_agent_run(conn, &run_id)
}

pub fn prepare_next_role_context(
    conn: &mut Connection,
    root: &Path,
    project_id: &str,
    task_id: &str,
) -> CommandResult<AgentRunSummary> {
    let task = get_task(conn, task_id)?;
    if task.project_id != project_id {
        return Err(CommandError::validation("대상 태스크를 찾을 수 없습니다."));
    }
    let role_id = next_role_for_task_status(&task.status).ok_or_else(|| {
        CommandError::validation("현재 태스크 상태에서 자동으로 실행할 role이 없습니다.")
    })?;
    ensure_task_worktree(conn, root, project_id, task_id)?;
    prepare_role_context(conn, root, project_id, task_id, role_id)
}

pub fn run_host_role(
    conn: &mut Connection,
    root: &Path,
    project_id: &str,
    run_id: &str,
    cancellation: Arc<AtomicBool>,
) -> CommandResult<AgentRunSummary> {
    let run = get_agent_run(conn, run_id)?;
    if run.project_id != project_id {
        return Err(CommandError::validation(
            "대상 실행 기록을 찾을 수 없습니다.",
        ));
    }
    if run.status != "Queued" {
        return Err(CommandError::validation(
            "Queued 상태의 host run만 실행할 수 있습니다.",
        ));
    }
    let task = get_task(conn, &run.task_id)?;
    validate_role_run_state(conn, project_id, &task, &run.role_id)?;
    let worktree = get_task_worktree(conn, project_id, &run.task_id)?.ok_or_else(|| {
        CommandError::validation("host run 실행 전에 태스크 worktree를 먼저 준비해주세요.")
    })?;
    let settings = effective_settings(conn, project_id)?;
    let placeholders = host_runner_placeholders(root, &worktree, &run);
    let runner_command = resolve_host_runner_command(&settings, &run.role_id, &placeholders)?;
    let command_args = runner_command.args;
    let timeout_seconds = runner_command.timeout_seconds;
    if command_args.is_empty() {
        return Err(CommandError::validation(
            "role preset에 실행 command가 설정되어 있지 않습니다.",
        ));
    }

    let started_at = now();
    conn.execute(
        "UPDATE agent_runs SET status = 'Running', started_at = ?1, updated_at = ?1 WHERE id = ?2",
        params![started_at, run_id],
    )
    .map_err(|err| CommandError::database("host run 상태를 저장하지 못했습니다.", err))?;
    insert_audit(
        conn,
        project_id,
        "AgentRun",
        Some(run_id),
        "agent_run.started",
        json!({
            "runId": run_id,
            "taskId": run.task_id,
            "roleId": run.role_id,
            "runner": "HelmHostRunner",
            "provider": runner_command.provider.clone(),
            "connectionId": runner_command.connection_id.clone(),
            "model": runner_command.model.clone()
        }),
    )?;

    let artifact_path = root.join(&run.artifact_dir);
    let command_started_at = now();
    let command_started_instant = Instant::now();
    let command_output = run_command_with_timeout(
        Command::new(&command_args[0])
            .args(&command_args[1..])
            .current_dir(&worktree.worktree_path)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env(
                "HELM_ARTIFACT_DIR",
                artifact_path.to_string_lossy().to_string(),
            )
            .env(
                "HELM_CONTEXT_PACK",
                artifact_path
                    .join("context-pack.md")
                    .to_string_lossy()
                    .to_string(),
            )
            .env(
                "HELM_CONTEXT_MANIFEST",
                artifact_path
                    .join("context-pack.json")
                    .to_string_lossy()
                    .to_string(),
            )
            .env(
                "HELM_RESULT_PATH",
                artifact_path
                    .join("structured-result.json")
                    .to_string_lossy()
                    .to_string(),
            )
            .env(
                "HELM_SUMMARY_PATH",
                artifact_path
                    .join("summary.md")
                    .to_string_lossy()
                    .to_string(),
            )
            .env(
                "HELM_SCHEMA_PATH",
                artifact_path
                    .join("structured-result.schema.json")
                    .to_string_lossy()
                    .to_string(),
            )
            .env("HELM_WORKTREE_PATH", worktree.worktree_path.clone())
            .env("HELM_TASK_ID", run.task_id.clone())
            .env("HELM_ROLE_ID", run.role_id.clone())
            .env("HELM_MODEL", runner_command.model.unwrap_or_default())
            .env(
                "HELM_JIRA_ENABLED",
                jira_config_bool(&settings.jira_config, "enabled"),
            )
            .env(
                "HELM_JIRA_SITE_URL",
                jira_config_string(&settings.jira_config, "siteUrl"),
            )
            .env(
                "HELM_JIRA_PROJECT_KEY",
                jira_config_string(&settings.jira_config, "projectKey"),
            )
            .env(
                "HELM_JIRA_EPIC_ISSUE_TYPE",
                jira_config_string(&settings.jira_config, "epicIssueType"),
            )
            .env(
                "HELM_JIRA_TASK_ISSUE_TYPE",
                jira_config_string(&settings.jira_config, "taskIssueType"),
            ),
        timeout_seconds,
        cancellation,
    )?;
    let command_duration_ms = command_started_instant
        .elapsed()
        .as_millis()
        .min(i64::MAX as u128) as i64;
    let command_finished_at = now();

    fs::write(artifact_path.join("stdout.log"), &command_output.stdout)
        .map_err(|err| CommandError::io("stdout 로그를 저장하지 못했습니다.", err))?;
    fs::write(artifact_path.join("stderr.log"), &command_output.stderr)
        .map_err(|err| CommandError::io("stderr 로그를 저장하지 못했습니다.", err))?;
    let changed_files = git::changed_files(Path::new(&worktree.worktree_path))?;
    fs::write(
        artifact_path.join("changed-files.json"),
        serde_json::to_string_pretty(&changed_files)
            .map_err(|err| CommandError::io("changed files를 만들지 못했습니다.", err))?,
    )
    .map_err(|err| CommandError::io("changed files를 저장하지 못했습니다.", err))?;
    let diff_output = Command::new("git")
        .arg("-C")
        .arg(&worktree.worktree_path)
        .args(["diff", "--binary", "HEAD", "--"])
        .output()
        .map_err(|err| CommandError::io("Git diff를 만들지 못했습니다.", err))?;
    if diff_output.status.success() {
        fs::write(artifact_path.join("diff.patch"), diff_output.stdout)
            .map_err(|err| CommandError::io("Git diff를 저장하지 못했습니다.", err))?;
    } else {
        fs::write(artifact_path.join("diff.patch"), diff_output.stderr)
            .map_err(|err| CommandError::io("Git diff 오류를 저장하지 못했습니다.", err))?;
    }

    let result_path = artifact_path.join("structured-result.json");
    let result_value = fs::read_to_string(&result_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
    let result_status = result_value
        .as_ref()
        .and_then(|value| value.get("status"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let schema_ok = result_value
        .as_ref()
        .is_some_and(validate_structured_result);
    let has_blocking_gate = result_value
        .as_ref()
        .is_some_and(structured_result_has_blocking_gate);
    let diff_consistency =
        diff_consistency_check(&run.role_id, result_value.as_ref(), &changed_files);
    let exit_code = command_output.exit_code;
    let final_status = if command_output.canceled {
        write_fallback_result(&artifact_path, exit_code)?;
        "Canceled"
    } else if command_output.timed_out {
        write_fallback_result(&artifact_path, exit_code)?;
        "TimedOut"
    } else if !schema_ok {
        write_fallback_result(&artifact_path, exit_code)?;
        "NeedsInspection"
    } else if exit_code != 0 {
        "Failed"
    } else if has_blocking_gate || diff_consistency.is_some() {
        "NeedsInspection"
    } else if result_status.as_deref() == Some("pass") {
        "Succeeded"
    } else {
        "NeedsInspection"
    };
    let finished_at = now();

    let persistence_result = (|| -> CommandResult<()> {
        let tx = conn
            .transaction()
            .map_err(|err| CommandError::database("host run 결과를 저장하지 못했습니다.", err))?;
        let evidence_id = insert_command_evidence(
            &tx,
            CommandEvidenceInput {
                project_id,
                task_id: Some(&run.task_id),
                run_id: Some(run_id),
                command_args: &command_args,
                cwd: &worktree.worktree_path,
                exit_code,
                timed_out: command_output.timed_out,
                canceled: command_output.canceled,
                stdout_path: Some("stdout.log"),
                stderr_path: Some("stderr.log"),
                changed_files_path: Some("changed-files.json"),
                diff_path: Some("diff.patch"),
                duration_ms: Some(command_duration_ms),
                started_at: &command_started_at,
                finished_at: Some(&command_finished_at),
            },
        )?;
        tx.execute(
            "UPDATE agent_runs
             SET status = ?1, exit_code = ?2, result_status = ?3, finished_at = ?4, updated_at = ?4
             WHERE id = ?5",
            params![final_status, exit_code, result_status, finished_at, run_id],
        )
        .map_err(|err| CommandError::database("host run 결과를 저장하지 못했습니다.", err))?;
        insert_audit(
            &tx,
            project_id,
            "AgentRun",
            Some(run_id),
            "agent_run.finished",
            json!({
                "runId": run_id,
                "taskId": run.task_id,
                "roleId": run.role_id,
                "status": final_status,
                "exitCode": exit_code,
                "resultStatus": result_status,
                "changedFiles": changed_files,
                "evidenceId": evidence_id
            }),
        )?;

        if let Some(value) = result_value.as_ref() {
            persist_gate_result_from_structured_result(
                &tx,
                project_id,
                &run.task_id,
                run_id,
                &run.role_id,
                value,
                final_status,
            )?;
        }

        if let Some(check) = diff_consistency.as_ref() {
            let gate_result = diff_consistency_gate_result(check);
            persist_gate_result_from_structured_result(
                &tx,
                project_id,
                &run.task_id,
                run_id,
                &run.role_id,
                &gate_result,
                "NeedsInspection",
            )?;
        }

        if final_status == "Succeeded" && result_status.as_deref() == Some("pass") {
            apply_successful_role_result(&tx, project_id, &task, &run.role_id, run_id)?;
        }

        tx.commit()
            .map_err(|err| CommandError::database("host run 결과를 저장하지 못했습니다.", err))?;
        Ok(())
    })();

    if let Err(err) = persistence_result {
        let _ = mark_host_run_persistence_failed(
            conn,
            project_id,
            run_id,
            &run.task_id,
            &run.role_id,
            &err,
        );
        return Err(err);
    }

    get_agent_run(conn, run_id)
}

pub fn mark_host_run_launch_error(
    conn: &mut Connection,
    root: &Path,
    project_id: &str,
    run_id: &str,
    message: &str,
) -> CommandResult<AgentRunSummary> {
    let run = get_agent_run(conn, run_id)?;
    if run.project_id != project_id {
        return Err(CommandError::validation(
            "대상 실행 기록을 찾을 수 없습니다.",
        ));
    }

    let artifact_path = root.join(&run.artifact_dir);
    fs::create_dir_all(&artifact_path)
        .map_err(|err| CommandError::io("실행 산출물 폴더를 만들지 못했습니다.", err))?;
    let stderr_path = artifact_path.join("stderr.log");
    let stderr = fs::read_to_string(&stderr_path).unwrap_or_default();
    let next_stderr = if stderr.trim().is_empty() {
        format!("{message}\n")
    } else {
        format!("{}\n{message}\n", stderr.trim_end())
    };
    fs::write(&stderr_path, next_stderr)
        .map_err(|err| CommandError::io("stderr 로그를 저장하지 못했습니다.", err))?;
    write_fallback_result(&artifact_path, -1)?;

    let finished_at = now();
    conn.execute(
        "UPDATE agent_runs
         SET status = 'NeedsInspection',
             exit_code = -1,
             result_status = 'needs_changes',
             finished_at = ?1,
             updated_at = ?1
         WHERE id = ?2 AND project_id = ?3",
        params![finished_at, run_id, project_id],
    )
    .map_err(|err| CommandError::database("host run 실패 상태를 저장하지 못했습니다.", err))?;
    insert_audit(
        conn,
        project_id,
        "AgentRun",
        Some(run_id),
        "agent_run.launch_failed",
        json!({
            "runId": run_id,
            "taskId": run.task_id,
            "roleId": run.role_id,
            "message": message
        }),
    )?;
    get_agent_run(conn, run_id)
}

pub fn retry_host_role(
    conn: &mut Connection,
    root: &Path,
    project_id: &str,
    run_id: &str,
) -> CommandResult<AgentRunSummary> {
    let run = get_agent_run(conn, run_id)?;
    if run.project_id != project_id {
        return Err(CommandError::validation(
            "대상 실행 기록을 찾을 수 없습니다.",
        ));
    }
    if matches!(run.status.as_str(), "Queued" | "Running" | "Succeeded") {
        return Err(CommandError::validation(
            "이 상태의 host run은 retry할 수 없습니다.",
        ));
    }
    prepare_role_context(conn, root, project_id, &run.task_id, &run.role_id)
}

pub fn list_agent_runs(
    conn: &Connection,
    project_id: &str,
    task_id: &str,
) -> CommandResult<Vec<AgentRunSummary>> {
    let mut stmt = conn
        .prepare(
            "SELECT id, project_id, task_id, role_id, status, artifact_dir, summary_path, result_path,
                    stdout_log_path, stderr_log_path, exit_code, result_status, started_at, finished_at,
                    created_at, updated_at
             FROM agent_runs WHERE project_id = ?1 AND task_id = ?2 ORDER BY created_at DESC",
        )
        .map_err(|err| CommandError::database("실행 기록을 읽지 못했습니다.", err))?;
    let rows = stmt
        .query_map(params![project_id, task_id], map_agent_run)
        .map_err(|err| CommandError::database("실행 기록을 읽지 못했습니다.", err))?;
    collect_rows(rows, "실행 기록을 읽지 못했습니다.")
}

pub fn list_task_timeline(
    conn: &Connection,
    project_id: &str,
    task_id: &str,
) -> CommandResult<Vec<TaskTimelineEntry>> {
    let task = get_task(conn, task_id)?;
    if task.project_id != project_id {
        return Err(CommandError::validation("대상 태스크를 찾을 수 없습니다."));
    }

    let mut entries = Vec::new();
    let runs = list_agent_runs(conn, project_id, task_id)?;
    for run in runs {
        entries.push(TaskTimelineEntry {
            id: run.id.clone(),
            project_id: project_id.to_string(),
            task_id: task_id.to_string(),
            entry_type: "agent_run".to_string(),
            title: format!("{} {}", run.role_id, run.status),
            summary: run.result_status.clone(),
            status: Some(run.status.clone()),
            created_at: run.created_at.clone(),
            metadata: json!(run),
        });
    }

    let mut approval_stmt = conn
        .prepare(
            "SELECT id, project_id, entity_type, entity_id, approval_type, status,
                    requested_reason, decision_reason, requested_at, decided_at, created_at, updated_at
             FROM approvals
             WHERE project_id = ?1
               AND entity_type = 'Task'
               AND entity_id = ?2
             ORDER BY created_at DESC",
        )
        .map_err(|err| CommandError::database("태스크 타임라인을 읽지 못했습니다.", err))?;
    let approvals = approval_stmt
        .query_map(params![project_id, task_id], map_approval)
        .map_err(|err| CommandError::database("태스크 타임라인을 읽지 못했습니다.", err))?;
    for approval in collect_rows(approvals, "태스크 타임라인을 읽지 못했습니다.")? {
        entries.push(TaskTimelineEntry {
            id: approval.id.clone(),
            project_id: project_id.to_string(),
            task_id: task_id.to_string(),
            entry_type: "approval".to_string(),
            title: approval.approval_type.clone(),
            summary: Some(approval.requested_reason.clone()),
            status: Some(approval.status.clone()),
            created_at: approval.created_at.clone(),
            metadata: json!(approval),
        });
    }

    let mut evidence_stmt = conn
        .prepare(
            "SELECT id, command_json, cwd, exit_code, timed_out, canceled, stdout_path, stderr_path,
                    changed_files_path, diff_path, duration_ms, started_at, finished_at, created_at
             FROM command_evidence
             WHERE project_id = ?1 AND task_id = ?2
             ORDER BY created_at DESC",
        )
        .map_err(|err| CommandError::database("태스크 타임라인을 읽지 못했습니다.", err))?;
    let evidence_rows = evidence_stmt
        .query_map(params![project_id, task_id], |row| {
            let id: String = row.get(0)?;
            let command_raw: String = row.get(1)?;
            let cwd: String = row.get(2)?;
            let exit_code: Option<i64> = row.get(3)?;
            let timed_out: i64 = row.get(4)?;
            let canceled: i64 = row.get(5)?;
            let stdout_path: Option<String> = row.get(6)?;
            let stderr_path: Option<String> = row.get(7)?;
            let changed_files_path: Option<String> = row.get(8)?;
            let diff_path: Option<String> = row.get(9)?;
            let duration_ms: Option<i64> = row.get(10)?;
            let started_at: String = row.get(11)?;
            let finished_at: Option<String> = row.get(12)?;
            let created_at: String = row.get(13)?;
            let command_value: Value = serde_json::from_str(&command_raw).unwrap_or(Value::Null);
            Ok(TaskTimelineEntry {
                id,
                project_id: project_id.to_string(),
                task_id: task_id.to_string(),
                entry_type: "command_evidence".to_string(),
                title: "Command evidence".to_string(),
                summary: exit_code.map(|code| format!("exit code {code}")),
                status: Some(
                    if timed_out == 1 {
                        "TimedOut"
                    } else if canceled == 1 {
                        "Canceled"
                    } else {
                        "Finished"
                    }
                    .to_string(),
                ),
                created_at,
                metadata: json!({
                    "command": command_value,
                    "cwd": cwd,
                    "exitCode": exit_code,
                    "timedOut": timed_out == 1,
                    "canceled": canceled == 1,
                    "stdoutPath": stdout_path,
                    "stderrPath": stderr_path,
                    "changedFilesPath": changed_files_path,
                    "diffPath": diff_path,
                    "durationMs": duration_ms,
                    "startedAt": started_at,
                    "finishedAt": finished_at
                }),
            })
        })
        .map_err(|err| CommandError::database("태스크 타임라인을 읽지 못했습니다.", err))?;
    entries.extend(collect_rows(
        evidence_rows,
        "태스크 타임라인을 읽지 못했습니다.",
    )?);

    let mut gate_stmt = conn
        .prepare(
            "SELECT id, run_id, gate, status, blocking, summary, blockers_json,
                    affected_files_json, suggested_next_json, created_at
             FROM gate_results
             WHERE project_id = ?1 AND task_id = ?2
             ORDER BY created_at DESC",
        )
        .map_err(|err| CommandError::database("태스크 타임라인을 읽지 못했습니다.", err))?;
    let gate_rows = gate_stmt
        .query_map(params![project_id, task_id], |row| {
            let id: String = row.get(0)?;
            let run_id: Option<String> = row.get(1)?;
            let gate: String = row.get(2)?;
            let status: String = row.get(3)?;
            let blocking: i64 = row.get(4)?;
            let summary: String = row.get(5)?;
            let blockers_raw: String = row.get(6)?;
            let affected_files_raw: String = row.get(7)?;
            let suggested_next_raw: Option<String> = row.get(8)?;
            let created_at: String = row.get(9)?;
            Ok(TaskTimelineEntry {
                id,
                project_id: project_id.to_string(),
                task_id: task_id.to_string(),
                entry_type: "gate_result".to_string(),
                title: gate.clone(),
                summary: Some(summary.clone()),
                status: Some(status.clone()),
                created_at,
                metadata: json!({
                    "runId": run_id,
                    "gate": gate,
                    "status": status,
                    "blocking": blocking == 1,
                    "summary": summary,
                    "blockers": serde_json::from_str::<Value>(&blockers_raw).unwrap_or(Value::Null),
                    "affectedFiles": serde_json::from_str::<Value>(&affected_files_raw).unwrap_or(Value::Null),
                    "suggestedNext": suggested_next_raw
                        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
                }),
            })
        })
        .map_err(|err| CommandError::database("태스크 타임라인을 읽지 못했습니다.", err))?;
    entries.extend(collect_rows(
        gate_rows,
        "태스크 타임라인을 읽지 못했습니다.",
    )?);

    let mut repair_stmt = conn
        .prepare(
            "SELECT id, run_id, gate_result_id, status, severity, summary,
                    required_action, affected_files_json, created_at, updated_at
             FROM repair_requests
             WHERE project_id = ?1 AND task_id = ?2
             ORDER BY created_at DESC",
        )
        .map_err(|err| CommandError::database("태스크 타임라인을 읽지 못했습니다.", err))?;
    let repair_rows = repair_stmt
        .query_map(params![project_id, task_id], |row| {
            let id: String = row.get(0)?;
            let run_id: Option<String> = row.get(1)?;
            let gate_result_id: Option<String> = row.get(2)?;
            let status: String = row.get(3)?;
            let severity: String = row.get(4)?;
            let summary: String = row.get(5)?;
            let required_action: String = row.get(6)?;
            let affected_files_raw: String = row.get(7)?;
            let created_at: String = row.get(8)?;
            let updated_at: String = row.get(9)?;
            Ok(TaskTimelineEntry {
                id,
                project_id: project_id.to_string(),
                task_id: task_id.to_string(),
                entry_type: "repair_request".to_string(),
                title: format!("{} repair", severity),
                summary: Some(summary.clone()),
                status: Some(status.clone()),
                created_at,
                metadata: json!({
                    "runId": run_id,
                    "gateResultId": gate_result_id,
                    "status": status,
                    "severity": severity,
                    "summary": summary,
                    "requiredAction": required_action,
                    "affectedFiles": serde_json::from_str::<Value>(&affected_files_raw).unwrap_or(Value::Null),
                    "updatedAt": updated_at
                }),
            })
        })
        .map_err(|err| CommandError::database("태스크 타임라인을 읽지 못했습니다.", err))?;
    entries.extend(collect_rows(
        repair_rows,
        "태스크 타임라인을 읽지 못했습니다.",
    )?);

    entries.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    Ok(entries)
}

pub fn get_agent_run(conn: &Connection, run_id: &str) -> CommandResult<AgentRunSummary> {
    conn.query_row(
        "SELECT id, project_id, task_id, role_id, status, artifact_dir, summary_path, result_path,
                stdout_log_path, stderr_log_path, exit_code, result_status, started_at, finished_at,
                created_at, updated_at
         FROM agent_runs WHERE id = ?1",
        params![run_id],
        map_agent_run,
    )
    .map_err(|err| {
        CommandError::with_details(
            "ValidationFailed",
            "대상 실행 기록을 찾을 수 없습니다.",
            err,
        )
    })
}

pub fn reconcile_interrupted_runs(conn: &Connection, project_id: &str) -> CommandResult<usize> {
    let timestamp = now();
    let count = conn
        .execute(
            "UPDATE agent_runs
             SET status = 'NeedsInspection',
                 finished_at = COALESCE(finished_at, ?1),
                 updated_at = ?1
             WHERE project_id = ?2 AND status = 'Running'",
            params![timestamp, project_id],
        )
        .map_err(|err| CommandError::database("중단된 실행 상태를 정리하지 못했습니다.", err))?;

    if count > 0 {
        insert_audit(
            conn,
            project_id,
            "AgentRun",
            None,
            "agent_run.reconciled",
            json!({
                "from": "Running",
                "to": "NeedsInspection",
                "count": count,
                "reason": "Helm app restarted before the host run finished"
            }),
        )?;
    }

    Ok(count)
}

fn mark_host_run_persistence_failed(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    task_id: &str,
    role_id: &str,
    error: &CommandError,
) -> CommandResult<()> {
    let timestamp = now();
    conn.execute(
        "UPDATE agent_runs
         SET status = 'NeedsInspection',
             result_status = COALESCE(result_status, 'needs_changes'),
             finished_at = COALESCE(finished_at, ?1),
             updated_at = ?1
         WHERE id = ?2 AND project_id = ?3",
        params![timestamp, run_id, project_id],
    )
    .map_err(|err| CommandError::database("host run 실패 상태를 저장하지 못했습니다.", err))?;
    insert_audit(
        conn,
        project_id,
        "AgentRun",
        Some(run_id),
        "agent_run.persistence_failed",
        json!({
            "runId": run_id,
            "taskId": task_id,
            "roleId": role_id,
            "error": {
                "code": error.code.as_str(),
                "message": error.message.as_str(),
                "details": error.details.as_deref()
            }
        }),
    )
}

pub fn read_run_artifact(
    conn: &Connection,
    root: &Path,
    project_id: &str,
    run_id: &str,
    artifact_name: &str,
) -> CommandResult<String> {
    if !matches!(
        artifact_name,
        "summary.md"
            | "structured-result.json"
            | "stdout.log"
            | "stderr.log"
            | "context-pack.md"
            | "context-pack.json"
            | "structured-result.schema.json"
            | "changed-files.json"
            | "diff.patch"
    ) {
        return Err(CommandError::validation("허용되지 않은 실행 산출물입니다."));
    }
    let run = get_agent_run(conn, run_id)?;
    if run.project_id != project_id {
        return Err(CommandError::validation(
            "대상 실행 기록을 찾을 수 없습니다.",
        ));
    }
    validate_relative_artifact_path(&run.artifact_dir)?;
    let artifact_path = root.join(&run.artifact_dir).join(artifact_name);
    let artifact_dir = root.join(&run.artifact_dir);
    let metadata = fs::symlink_metadata(&artifact_path)
        .map_err(|err| CommandError::io("실행 산출물 파일을 찾을 수 없습니다.", err))?;
    if metadata.file_type().is_symlink() {
        return Err(CommandError::validation(
            "심볼릭 링크 산출물은 열 수 없습니다.",
        ));
    }
    let canonical_dir = artifact_dir
        .canonicalize()
        .map_err(|err| CommandError::io("실행 산출물 파일을 찾을 수 없습니다.", err))?;
    let canonical_file = artifact_path
        .canonicalize()
        .map_err(|err| CommandError::io("실행 산출물 파일을 찾을 수 없습니다.", err))?;
    if !canonical_file.starts_with(&canonical_dir) {
        return Err(CommandError::validation(
            "허용되지 않은 실행 산출물 경로입니다.",
        ));
    }
    fs::read_to_string(canonical_file)
        .map_err(|err| CommandError::io("실행 산출물 파일을 찾을 수 없습니다.", err))
}

pub fn list_approvals(
    conn: &Connection,
    project_id: &str,
    status: Option<String>,
) -> CommandResult<Vec<ApprovalSummary>> {
    if let Some(status) = status.as_deref() {
        validate_approval_status(status)?;
        let mut stmt = conn
            .prepare(
                "SELECT id, project_id, entity_type, entity_id, approval_type, status,
                        requested_reason, decision_reason, requested_at, decided_at, created_at, updated_at
                 FROM approvals WHERE project_id = ?1 AND status = ?2 ORDER BY requested_at DESC",
            )
            .map_err(|err| CommandError::database("승인 요청을 읽지 못했습니다.", err))?;
        let rows = stmt
            .query_map(params![project_id, status], map_approval)
            .map_err(|err| CommandError::database("승인 요청을 읽지 못했습니다.", err))?;
        return collect_rows(rows, "승인 요청을 읽지 못했습니다.");
    }
    let mut stmt = conn
        .prepare(
            "SELECT id, project_id, entity_type, entity_id, approval_type, status,
                    requested_reason, decision_reason, requested_at, decided_at, created_at, updated_at
             FROM approvals WHERE project_id = ?1 ORDER BY requested_at DESC",
        )
        .map_err(|err| CommandError::database("승인 요청을 읽지 못했습니다.", err))?;
    let rows = stmt
        .query_map(params![project_id], map_approval)
        .map_err(|err| CommandError::database("승인 요청을 읽지 못했습니다.", err))?;
    collect_rows(rows, "승인 요청을 읽지 못했습니다.")
}

pub fn decide_approval(
    conn: &mut Connection,
    project_id: &str,
    approval_id: &str,
    decision: &str,
    reason: &str,
) -> CommandResult<ApprovalSummary> {
    let reason = required_text(reason, "승인 또는 반려 사유를 입력해주세요.")?;
    let approval = get_approval(conn, approval_id)?;
    if approval.project_id != project_id {
        return Err(CommandError::validation(
            "대상 승인 요청을 찾을 수 없습니다.",
        ));
    }
    if approval.status != "Pending" {
        return Err(CommandError::validation("이미 처리된 승인 요청입니다."));
    }
    let timestamp = now();
    let next_task_status = if approval.approval_type == "PlanApproval" {
        Some(if decision == "Approved" {
            "Ready"
        } else {
            "Blocked"
        })
    } else {
        None
    };
    let task_before = if next_task_status.is_some() {
        Some(get_task(conn, &approval.entity_id)?)
    } else {
        None
    };
    let tx = conn
        .transaction()
        .map_err(|err| CommandError::database("승인 결정을 저장하지 못했습니다.", err))?;
    tx.execute(
        "UPDATE approvals
         SET status = ?1, decision_reason = ?2, decided_at = ?3, updated_at = ?3
         WHERE id = ?4 AND project_id = ?5",
        params![decision, reason, timestamp, approval_id, project_id],
    )
    .map_err(|err| CommandError::database("승인 결정을 저장하지 못했습니다.", err))?;
    let event_type = if decision == "Approved" {
        "approval.approved"
    } else {
        "approval.rejected"
    };
    insert_audit(
        &tx,
        project_id,
        &approval.entity_type,
        Some(&approval.entity_id),
        event_type,
        json!({
            "approvalId": approval_id,
            "approvalType": approval.approval_type,
            "entityType": approval.entity_type,
            "entityId": approval.entity_id,
            "decisionReason": reason
        }),
    )?;
    if let (Some(status), Some(task)) = (next_task_status, task_before) {
        tx.execute(
            "UPDATE tasks
             SET status = ?1, status_reason = ?2, updated_at = ?3, last_transition_at = ?3
             WHERE id = ?4 AND project_id = ?5",
            params![status, reason, timestamp, task.id, project_id],
        )
        .map_err(|err| CommandError::database("태스크 상태를 저장하지 못했습니다.", err))?;
        insert_audit(
            &tx,
            project_id,
            "Task",
            Some(&task.id),
            "task.status_changed",
            json!({
                "taskId": task.id,
                "from": task.status,
                "to": status,
                "reason": if decision == "Approved" { "PlanApproval approved" } else { "PlanApproval rejected" },
                "source": "approval"
            }),
        )?;
    }
    tx.commit()
        .map_err(|err| CommandError::database("승인 결정을 저장하지 못했습니다.", err))?;
    get_approval(conn, approval_id)
}

pub fn task_counts(tasks: &[TaskSummary]) -> TaskCounts {
    let mut by_status = HashMap::new();
    for task in tasks {
        *by_status.entry(task.status.clone()).or_insert(0) += 1;
    }
    TaskCounts {
        total: tasks.len(),
        done: tasks
            .iter()
            .filter(|task| matches!(task.status.as_str(), "Done" | "Merged"))
            .count(),
        by_status,
    }
}

fn map_agent_run(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentRunSummary> {
    Ok(AgentRunSummary {
        id: row.get(0)?,
        project_id: row.get(1)?,
        task_id: row.get(2)?,
        role_id: row.get(3)?,
        status: row.get(4)?,
        artifact_dir: row.get(5)?,
        summary_path: row.get(6)?,
        result_path: row.get(7)?,
        stdout_log_path: row.get(8)?,
        stderr_log_path: row.get(9)?,
        exit_code: row.get(10)?,
        result_status: row.get(11)?,
        started_at: row.get(12)?,
        finished_at: row.get(13)?,
        created_at: row.get(14)?,
        updated_at: row.get(15)?,
    })
}

fn map_approval(row: &rusqlite::Row<'_>) -> rusqlite::Result<ApprovalSummary> {
    Ok(ApprovalSummary {
        id: row.get(0)?,
        project_id: row.get(1)?,
        entity_type: row.get(2)?,
        entity_id: row.get(3)?,
        approval_type: row.get(4)?,
        status: row.get(5)?,
        requested_reason: row.get(6)?,
        decision_reason: row.get(7)?,
        requested_at: row.get(8)?,
        decided_at: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

fn map_task_worktree(row: &rusqlite::Row<'_>) -> rusqlite::Result<TaskWorktreeSummary> {
    Ok(TaskWorktreeSummary {
        id: row.get(0)?,
        project_id: row.get(1)?,
        task_id: row.get(2)?,
        branch_name: row.get(3)?,
        worktree_path: row.get(4)?,
        base_branch: row.get(5)?,
        head_hash: row.get(6)?,
        status: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

fn get_approval(conn: &Connection, id: &str) -> CommandResult<ApprovalSummary> {
    conn.query_row(
        "SELECT id, project_id, entity_type, entity_id, approval_type, status,
                requested_reason, decision_reason, requested_at, decided_at, created_at, updated_at
         FROM approvals WHERE id = ?1",
        params![id],
        map_approval,
    )
    .map_err(|err| {
        CommandError::with_details(
            "ValidationFailed",
            "대상 승인 요청을 찾을 수 없습니다.",
            err,
        )
    })
}

fn get_epic(conn: &Connection, id: &str) -> CommandResult<EpicSummary> {
    conn.query_row(
        "SELECT id, project_id, title, status, plan_path, created_at, updated_at FROM epics WHERE id = ?1",
        params![id],
        map_epic,
    )
    .map_err(|err| CommandError::with_details("ValidationFailed", "대상 에픽을 찾을 수 없습니다.", err))
}

fn get_task(conn: &Connection, id: &str) -> CommandResult<TaskSummary> {
    let row = conn
        .query_row(
            "SELECT id, project_id, epic_id, title, description, status, status_reason, sort_order,
                    created_at, updated_at, last_transition_at
             FROM tasks WHERE id = ?1",
            params![id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, i64>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, String>(10)?,
                ))
            },
        )
        .map_err(|err| {
            CommandError::with_details("ValidationFailed", "대상 태스크를 찾을 수 없습니다.", err)
        })?;
    let external_refs = list_external_refs(conn, &row.0)?;
    Ok(TaskSummary {
        id: row.0,
        project_id: row.1,
        epic_id: row.2,
        title: row.3,
        description: row.4,
        status: row.5,
        status_reason: row.6,
        sort_order: row.7,
        external_refs,
        created_at: row.8,
        updated_at: row.9,
        last_transition_at: row.10,
    })
}

fn list_external_refs(
    conn: &Connection,
    task_id: &str,
) -> CommandResult<Vec<TaskExternalRefSummary>> {
    let mut stmt = conn
        .prepare(
            "SELECT id, project_id, task_id, ref_type, ref_value, ref_title, created_at
             FROM task_external_refs WHERE task_id = ?1 ORDER BY created_at ASC",
        )
        .map_err(|err| CommandError::database("외부 참조를 읽지 못했습니다.", err))?;
    let rows = stmt
        .query_map(params![task_id], |row| {
            Ok(TaskExternalRefSummary {
                id: row.get(0)?,
                project_id: row.get(1)?,
                task_id: row.get(2)?,
                ref_type: row.get(3)?,
                ref_value: row.get(4)?,
                ref_title: row.get(5)?,
                created_at: row.get(6)?,
            })
        })
        .map_err(|err| CommandError::database("외부 참조를 읽지 못했습니다.", err))?;
    collect_rows(rows, "외부 참조를 읽지 못했습니다.")
}

fn map_epic(row: &rusqlite::Row<'_>) -> rusqlite::Result<EpicSummary> {
    Ok(EpicSummary {
        id: row.get(0)?,
        project_id: row.get(1)?,
        title: row.get(2)?,
        status: row.get(3)?,
        plan_path: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

fn collect_rows<T>(
    rows: impl Iterator<Item = rusqlite::Result<T>>,
    message: &str,
) -> CommandResult<Vec<T>> {
    rows.map(|row| row.map_err(|err| CommandError::database(message, err)))
        .collect()
}

fn insert_audit(
    conn: &Connection,
    project_id: &str,
    entity_type: &str,
    entity_id: Option<&str>,
    event_type: &str,
    payload: Value,
) -> CommandResult<()> {
    conn.execute(
        "INSERT INTO audit_logs (id, project_id, entity_type, entity_id, event_type, payload_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            new_id(),
            project_id,
            entity_type,
            entity_id,
            event_type,
            payload.to_string(),
            now()
        ],
    )
    .map_err(|err| CommandError::database("감사 로그를 저장하지 못했습니다.", err))?;
    Ok(())
}

struct CommandEvidenceInput<'a> {
    project_id: &'a str,
    task_id: Option<&'a str>,
    run_id: Option<&'a str>,
    command_args: &'a [String],
    cwd: &'a str,
    exit_code: i32,
    timed_out: bool,
    canceled: bool,
    stdout_path: Option<&'a str>,
    stderr_path: Option<&'a str>,
    changed_files_path: Option<&'a str>,
    diff_path: Option<&'a str>,
    duration_ms: Option<i64>,
    started_at: &'a str,
    finished_at: Option<&'a str>,
}

fn insert_command_evidence(
    conn: &Connection,
    input: CommandEvidenceInput<'_>,
) -> CommandResult<String> {
    let id = new_id();
    conn.execute(
        "INSERT INTO command_evidence (
           id, project_id, task_id, run_id, command_json, cwd, exit_code, timed_out, canceled,
           stdout_path, stderr_path, changed_files_path, diff_path, duration_ms,
           started_at, finished_at, created_at
         )
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
        params![
            id,
            input.project_id,
            input.task_id,
            input.run_id,
            serde_json::to_string(input.command_args).map_err(|err| {
                CommandError::io("command evidence를 직렬화하지 못했습니다.", err)
            })?,
            input.cwd,
            input.exit_code,
            bool_to_i64(input.timed_out),
            bool_to_i64(input.canceled),
            input.stdout_path,
            input.stderr_path,
            input.changed_files_path,
            input.diff_path,
            input.duration_ms,
            input.started_at,
            input.finished_at,
            now()
        ],
    )
    .map_err(|err| CommandError::database("command evidence를 저장하지 못했습니다.", err))?;
    Ok(id)
}

fn persist_gate_result_from_structured_result(
    conn: &Connection,
    project_id: &str,
    task_id: &str,
    run_id: &str,
    role_id: &str,
    result: &Value,
    final_status: &str,
) -> CommandResult<()> {
    let explicit_gate = result.get("gateResult").and_then(Value::as_object);
    let synthetic_gate = gate_for_role(role_id).filter(|_| {
        final_status == "Succeeded" && result.get("status").and_then(Value::as_str) == Some("pass")
    });
    if explicit_gate.is_none() && synthetic_gate.is_none() {
        return Ok(());
    }

    let fallback_gate = synthetic_gate.unwrap_or("rules");
    let gate = explicit_gate
        .and_then(|gate| gate.get("gate"))
        .and_then(Value::as_str)
        .filter(|value| valid_gate(value))
        .unwrap_or(fallback_gate);
    let status = explicit_gate
        .and_then(|gate| gate.get("status"))
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "pass" | "warn" | "fail"))
        .unwrap_or(if final_status == "Succeeded" {
            "pass"
        } else {
            "needs_inspection"
        });
    let blocking = explicit_gate
        .and_then(|gate| gate.get("blocking"))
        .and_then(Value::as_bool)
        .unwrap_or(status == "fail" || status == "needs_inspection");
    let blockers = explicit_gate
        .and_then(|gate| gate.get("blockers"))
        .filter(|value| value.is_array())
        .cloned()
        .unwrap_or_else(|| json!([]));
    let affected_files = explicit_gate
        .and_then(|gate| gate.get("affectedFiles"))
        .filter(|value| value.is_array())
        .cloned()
        .or_else(|| {
            result
                .get("changedFiles")
                .filter(|value| value.is_array())
                .cloned()
        })
        .unwrap_or_else(|| json!([]));
    let suggested_next = explicit_gate
        .and_then(|gate| gate.get("suggestedNext"))
        .filter(|value| value.is_object())
        .cloned();
    let summary = result
        .get("summary")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("gate result가 기록되었습니다.");
    let gate_result_id = new_id();
    let timestamp = now();

    conn.execute(
        "INSERT INTO gate_results (
           id, project_id, task_id, run_id, gate, status, blocking, summary,
           blockers_json, affected_files_json, suggested_next_json, created_at
         )
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            gate_result_id,
            project_id,
            task_id,
            run_id,
            gate,
            status,
            bool_to_i64(blocking),
            summary,
            blockers.to_string(),
            affected_files.to_string(),
            suggested_next.as_ref().map(Value::to_string),
            timestamp
        ],
    )
    .map_err(|err| CommandError::database("gate result를 저장하지 못했습니다.", err))?;

    if blocking {
        insert_repair_request_for_gate(
            conn,
            project_id,
            task_id,
            run_id,
            &gate_result_id,
            &blockers,
            &affected_files,
            suggested_next.as_ref(),
            summary,
        )?;
    }

    insert_audit(
        conn,
        project_id,
        "Task",
        Some(task_id),
        "gate_result.recorded",
        json!({
            "runId": run_id,
            "gateResultId": gate_result_id,
            "gate": gate,
            "status": status,
            "blocking": blocking
        }),
    )?;
    Ok(())
}

fn insert_repair_request_for_gate(
    conn: &Connection,
    project_id: &str,
    task_id: &str,
    run_id: &str,
    gate_result_id: &str,
    blockers: &Value,
    affected_files: &Value,
    suggested_next: Option<&Value>,
    fallback_summary: &str,
) -> CommandResult<()> {
    let first_blocker = blockers.as_array().and_then(|items| items.first());
    let severity = first_blocker
        .and_then(|item| item.get("severity"))
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "error" | "warning"))
        .unwrap_or("error");
    let summary = first_blocker
        .and_then(|item| item.get("summary"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(fallback_summary);
    let required_action = suggested_next
        .and_then(|item| item.get("reason"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("blocking gate result를 해결한 뒤 해당 role을 재실행한다.");
    let timestamp = now();

    conn.execute(
        "INSERT INTO repair_requests (
           id, project_id, task_id, run_id, gate_result_id, status, severity, summary,
           required_action, affected_files_json, created_at, updated_at
         )
         VALUES (?1, ?2, ?3, ?4, ?5, 'Open', ?6, ?7, ?8, ?9, ?10, ?10)",
        params![
            new_id(),
            project_id,
            task_id,
            run_id,
            gate_result_id,
            severity,
            summary,
            required_action,
            affected_files.to_string(),
            timestamp
        ],
    )
    .map_err(|err| CommandError::database("repair request를 저장하지 못했습니다.", err))?;
    Ok(())
}

fn bool_to_i64(value: bool) -> i64 {
    if value {
        1
    } else {
        0
    }
}

fn valid_gate(value: &str) -> bool {
    matches!(
        value,
        "plan_verification" | "code_review" | "test" | "security" | "rules"
    )
}

fn gate_for_role(role_id: &str) -> Option<&'static str> {
    match role_id {
        "plan_verifier" => Some("plan_verification"),
        "code_reviewer" => Some("code_review"),
        "tester" => Some("test"),
        _ => None,
    }
}

fn ensure_epic_exists(conn: &Connection, project_id: &str, epic_id: &str) -> CommandResult<()> {
    let exists: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM epics WHERE id = ?1 AND project_id = ?2",
            params![epic_id, project_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| CommandError::database("에픽 정보를 확인하지 못했습니다.", err))?;
    if exists.is_none() {
        return Err(CommandError::validation("대상 에픽을 찾을 수 없습니다."));
    }
    Ok(())
}

fn next_task_sort_order(conn: &Connection, project_id: &str) -> CommandResult<i64> {
    conn.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM tasks WHERE project_id = ?1",
        params![project_id],
        |row| row.get(0),
    )
    .map_err(|err| CommandError::database("태스크 순서를 계산하지 못했습니다.", err))
}

fn required_text(value: &str, message: &str) -> CommandResult<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(CommandError::validation(message));
    }
    Ok(trimmed.to_string())
}

fn validate_external_ref(input: &TaskExternalRefInput) -> CommandResult<()> {
    if !matches!(
        input.ref_type.as_str(),
        "JiraEpic" | "JiraTask" | "MarkdownPlan" | "PlainText" | "Url"
    ) {
        return Err(CommandError::validation(
            "지원하지 않는 외부 참조 타입입니다.",
        ));
    }
    required_text(&input.ref_value, "외부 참조 값을 입력해주세요.")?;
    Ok(())
}

fn validate_task_status(status: &str) -> CommandResult<()> {
    if matches!(
        status,
        "Planned"
            | "Ready"
            | "Coding"
            | "PlanVerification"
            | "CodeReview"
            | "Testing"
            | "MergeWaiting"
            | "Merged"
            | "Done"
            | "Blocked"
    ) {
        return Ok(());
    }
    Err(CommandError::validation("지원하지 않는 태스크 상태입니다."))
}

fn validate_role_id(role_id: &str) -> CommandResult<()> {
    if matches!(
        role_id,
        "planner" | "coder" | "plan_verifier" | "code_reviewer" | "tester"
    ) {
        return Ok(());
    }
    Err(CommandError::validation("지원하지 않는 역할입니다."))
}

fn validate_approval_status(status: &str) -> CommandResult<()> {
    if matches!(status, "Pending" | "Approved" | "Rejected" | "Expired") {
        return Ok(());
    }
    Err(CommandError::validation("지원하지 않는 승인 상태입니다."))
}

fn jira_config_string(config: &Option<Value>, key: &str) -> String {
    config
        .as_ref()
        .and_then(|value| value.get(key))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn jira_config_bool(config: &Option<Value>, key: &str) -> String {
    config
        .as_ref()
        .and_then(|value| value.get(key))
        .and_then(Value::as_bool)
        .unwrap_or(false)
        .to_string()
}

fn resolve_worktree_root(root: &Path, configured: Option<&str>) -> PathBuf {
    let path = configured
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join(".helm").join("worktrees"));
    if path.is_relative() {
        root.join(path)
    } else {
        path
    }
}

fn task_slug(title: &str, task_id: &str) -> String {
    let mut slug = String::new();
    for ch in title.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
        } else if matches!(ch, ' ' | '-' | '_' | '.') && !slug.ends_with('-') {
            slug.push('-');
        }
        if slug.len() >= 40 {
            break;
        }
    }
    let slug = slug.trim_matches('-');
    let prefix = if slug.is_empty() { "task" } else { slug };
    let short_id = task_id.chars().take(8).collect::<String>();
    format!("{prefix}-{short_id}")
}

fn unique_task_branch(root: &Path, slug: &str) -> CommandResult<String> {
    let base = format!("helm/{slug}");
    if !git::branch_exists(root, &base)? {
        return Ok(base);
    }
    for index in 2..100 {
        let candidate = format!("{base}-{index}");
        if !git::branch_exists(root, &candidate)? {
            return Ok(candidate);
        }
    }
    Err(CommandError::validation(
        "사용 가능한 태스크 branch 이름을 만들지 못했습니다.",
    ))
}

fn has_active_run(conn: &Connection, project_id: &str, task_id: &str) -> CommandResult<bool> {
    let exists: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM agent_runs
             WHERE project_id = ?1 AND task_id = ?2 AND status IN ('Queued', 'Running')
             LIMIT 1",
            params![project_id, task_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| CommandError::database("실행 상태를 확인하지 못했습니다.", err))?;
    Ok(exists.is_some())
}

fn host_runner_placeholders(
    root: &Path,
    worktree: &TaskWorktreeSummary,
    run: &AgentRunSummary,
) -> HashMap<String, String> {
    let artifact_dir = root.join(&run.artifact_dir);
    HashMap::from([
        (
            "artifactDir".to_string(),
            artifact_dir.to_string_lossy().to_string(),
        ),
        (
            "projectRoot".to_string(),
            root.to_string_lossy().to_string(),
        ),
        (
            "contextPackPath".to_string(),
            artifact_dir
                .join("context-pack.md")
                .to_string_lossy()
                .to_string(),
        ),
        (
            "contextManifestPath".to_string(),
            artifact_dir
                .join("context-pack.json")
                .to_string_lossy()
                .to_string(),
        ),
        (
            "resultPath".to_string(),
            artifact_dir
                .join("structured-result.json")
                .to_string_lossy()
                .to_string(),
        ),
        (
            "summaryPath".to_string(),
            artifact_dir
                .join("summary.md")
                .to_string_lossy()
                .to_string(),
        ),
        (
            "schemaPath".to_string(),
            artifact_dir
                .join("structured-result.schema.json")
                .to_string_lossy()
                .to_string(),
        ),
        ("worktreePath".to_string(), worktree.worktree_path.clone()),
        ("taskId".to_string(), run.task_id.clone()),
        ("roleId".to_string(), run.role_id.clone()),
    ])
}

struct ResolvedHostRunnerCommand {
    args: Vec<String>,
    timeout_seconds: u64,
    provider: Option<String>,
    connection_id: Option<String>,
    model: Option<String>,
}

fn resolve_host_runner_command(
    settings: &EffectiveSettings,
    role_id: &str,
    placeholders: &HashMap<String, String>,
) -> CommandResult<ResolvedHostRunnerCommand> {
    if let Some(command) = role_assignment_command(settings, role_id, placeholders)? {
        return Ok(command);
    }

    Ok(ResolvedHostRunnerCommand {
        args: role_command_args(&settings.role_presets, role_id, placeholders)?,
        timeout_seconds: role_timeout_seconds(&settings.role_presets, role_id),
        provider: None,
        connection_id: None,
        model: None,
    })
}

fn role_assignment_command(
    settings: &EffectiveSettings,
    role_id: &str,
    placeholders: &HashMap<String, String>,
) -> CommandResult<Option<ResolvedHostRunnerCommand>> {
    let assignment = settings.role_assignments.as_array().and_then(|items| {
        items
            .iter()
            .find(|item| item.get("roleId").and_then(Value::as_str) == Some(role_id))
    });
    let Some(assignment) = assignment else {
        return Ok(None);
    };

    let Some(selection) = first_role_selection(assignment) else {
        return Ok(None);
    };
    let connection_id = selection
        .get("connectionId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            CommandError::validation("role selection의 connectionId가 올바르지 않습니다.")
        })?;
    let connection = settings
        .ai_connections
        .as_array()
        .and_then(|items| {
            items
                .iter()
                .find(|item| item.get("id").and_then(Value::as_str) == Some(connection_id))
        })
        .ok_or_else(|| CommandError::validation("역할에 배정된 AI CLI 연결을 찾을 수 없습니다."))?;
    if connection.get("enabled").and_then(Value::as_bool) == Some(false) {
        return Err(CommandError::validation(
            "역할에 배정된 AI CLI 연결이 비활성화되어 있습니다.",
        ));
    }

    let args = connection
        .get("commandArgs")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| {
                    item.as_str()
                        .map(|raw| apply_placeholders(raw, placeholders))
                        .ok_or_else(|| {
                            CommandError::validation("commandArgs는 문자열 배열이어야 합니다.")
                        })
                })
                .collect::<CommandResult<Vec<_>>>()
        })
        .transpose()?
        .unwrap_or_default();
    let provider = connection
        .get("provider")
        .and_then(Value::as_str)
        .map(str::to_string);
    let model = selection
        .get("model")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            connection
                .get("defaultModel")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
        })
        .map(str::to_string);
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

    Ok(Some(ResolvedHostRunnerCommand {
        args: inject_provider_options(args, provider.as_deref(), model.as_deref(), effort),
        timeout_seconds: connection
            .get("timeoutSeconds")
            .and_then(Value::as_u64)
            .unwrap_or_else(|| role_timeout_seconds(&settings.role_presets, role_id))
            .clamp(1, 21600),
        provider,
        connection_id: Some(connection_id.to_string()),
        model,
    }))
}

fn first_role_selection(assignment: &Value) -> Option<Value> {
    if let Some(selection) = assignment
        .get("selections")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
    {
        return Some(selection.clone());
    }
    assignment
        .get("connectionIds")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .and_then(Value::as_str)
        .map(|connection_id| json!({ "connectionId": connection_id }))
}

fn inject_provider_options(
    args: Vec<String>,
    provider: Option<&str>,
    model: Option<&str>,
    effort: Option<&str>,
) -> Vec<String> {
    let with_model = match (provider, model) {
        (Some("codex"), Some(model)) if !has_arg(&args, &["-m", "--model"]) => {
            insert_after_command(args, "exec", ["-m".to_string(), model.to_string()])
        }
        (Some("claude"), Some(model)) if !has_arg(&args, &["--model"]) => {
            insert_after_index(args, 0, ["--model".to_string(), model.to_string()])
        }
        _ => args,
    };

    match (provider, effort) {
        (Some("claude"), Some(effort)) if !has_arg(&with_model, &["--effort"]) => {
            insert_after_index(with_model, 0, ["--effort".to_string(), effort.to_string()])
        }
        _ => with_model,
    }
}

fn has_arg(args: &[String], names: &[&str]) -> bool {
    args.iter().any(|arg| names.iter().any(|name| arg == name))
}

fn insert_after_command<const N: usize>(
    args: Vec<String>,
    command: &str,
    insert: [String; N],
) -> Vec<String> {
    let index = args.iter().position(|arg| arg == command).unwrap_or(0);
    insert_after_index(args, index, insert)
}

fn insert_after_index<const N: usize>(
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

fn role_command_args(
    role_presets: &Value,
    role_id: &str,
    placeholders: &HashMap<String, String>,
) -> CommandResult<Vec<String>> {
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
            let raw = arg.as_str().ok_or_else(|| {
                CommandError::validation("commandArgs는 문자열 배열이어야 합니다.")
            })?;
            parsed.push(apply_placeholders(raw, placeholders));
        }
        return Ok(parsed);
    }

    if let Some(template) = preset.get("commandTemplate").and_then(Value::as_str) {
        return Ok(template
            .split_whitespace()
            .map(|part| apply_placeholders(part, placeholders))
            .collect());
    }

    Ok(Vec::new())
}

fn role_timeout_seconds(role_presets: &Value, role_id: &str) -> u64 {
    role_presets
        .as_array()
        .and_then(|items| {
            items
                .iter()
                .find(|item| item.get("roleId").and_then(Value::as_str) == Some(role_id))
        })
        .and_then(|preset| preset.get("timeoutSeconds"))
        .and_then(Value::as_u64)
        .unwrap_or(1800)
        .clamp(1, 21600)
}

fn apply_placeholders(value: &str, placeholders: &HashMap<String, String>) -> String {
    let mut rendered = value.to_string();
    for (key, replacement) in placeholders {
        rendered = rendered.replace(&format!("{{{key}}}"), replacement);
    }
    rendered
}

struct HostCommandOutput {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    exit_code: i32,
    timed_out: bool,
    canceled: bool,
}

fn run_command_with_timeout(
    command: &mut Command,
    timeout_seconds: u64,
    cancellation: Arc<AtomicBool>,
) -> CommandResult<HostCommandOutput> {
    let mut child = command
        .spawn()
        .map_err(|err| CommandError::io("host runner command를 실행하지 못했습니다.", err))?;
    let deadline = Instant::now() + Duration::from_secs(timeout_seconds);

    loop {
        if child
            .try_wait()
            .map_err(|err| CommandError::io("host runner 상태를 확인하지 못했습니다.", err))?
            .is_some()
        {
            let output = child
                .wait_with_output()
                .map_err(|err| CommandError::io("host runner 출력을 읽지 못했습니다.", err))?;
            return Ok(HostCommandOutput {
                stdout: output.stdout,
                stderr: output.stderr,
                exit_code: output.status.code().unwrap_or(-1),
                timed_out: false,
                canceled: false,
            });
        }

        if cancellation.load(Ordering::SeqCst) {
            let _ = child.kill();
            let output = child.wait_with_output().map_err(|err| {
                CommandError::io("취소된 host runner 출력을 읽지 못했습니다.", err)
            })?;
            return Ok(HostCommandOutput {
                stdout: output.stdout,
                stderr: output.stderr,
                exit_code: -1,
                timed_out: false,
                canceled: true,
            });
        }

        if Instant::now() >= deadline {
            let _ = child.kill();
            let output = child.wait_with_output().map_err(|err| {
                CommandError::io("timeout 된 host runner 출력을 읽지 못했습니다.", err)
            })?;
            return Ok(HostCommandOutput {
                stdout: output.stdout,
                stderr: output.stderr,
                exit_code: -1,
                timed_out: true,
                canceled: false,
            });
        }

        std::thread::sleep(Duration::from_millis(100));
    }
}

fn write_fallback_result(artifact_path: &Path, exit_code: i32) -> CommandResult<()> {
    let fallback = json!({
        "schemaVersion": 1,
        "status": "needs_changes",
        "summary": "host runner가 유효한 structured-result.json을 남기지 않아 검토가 필요합니다.",
        "changedFiles": [],
        "risks": ["structured-result schema 검증 실패"],
        "nextActions": ["stdout.log와 stderr.log 확인"],
        "gateResult": null
    });
    fs::write(
        artifact_path.join("summary.md"),
        format!(
            "# Host Run Needs Inspection\n\nexit code: {exit_code}\n\nstructured-result.json이 없거나 schema 검증에 실패했습니다.\n"
        ),
    )
    .map_err(|err| CommandError::io("fallback summary를 저장하지 못했습니다.", err))?;
    fs::write(
        artifact_path.join("structured-result.json"),
        serde_json::to_string_pretty(&fallback)
            .map_err(|err| CommandError::io("fallback result를 만들지 못했습니다.", err))?,
    )
    .map_err(|err| CommandError::io("fallback result를 저장하지 못했습니다.", err))?;
    Ok(())
}

fn apply_successful_role_result(
    conn: &Connection,
    project_id: &str,
    task: &TaskSummary,
    role_id: &str,
    run_id: &str,
) -> CommandResult<()> {
    let timestamp = now();
    if role_id == "planner" {
        conn.execute(
            "INSERT INTO approvals (
               id, project_id, entity_type, entity_id, approval_type, status,
               requested_reason, decision_reason, requested_at, decided_at, created_at, updated_at
             )
             VALUES (?1, ?2, 'Task', ?3, 'PlanApproval', 'Pending', ?4, NULL, ?5, NULL, ?5, ?5)",
            params![
                new_id(),
                project_id,
                task.id,
                "planner host run completed",
                timestamp
            ],
        )
        .map_err(|err| CommandError::database("승인 요청을 저장하지 못했습니다.", err))?;
        insert_audit(
            conn,
            project_id,
            "Task",
            Some(&task.id),
            "approval.created",
            json!({
                "taskId": task.id,
                "runId": run_id,
                "approvalType": "PlanApproval",
                "requestedReason": "planner host run completed"
            }),
        )?;
        return Ok(());
    }

    if let Some(next_status) = next_status_for_role(role_id) {
        conn.execute(
            "UPDATE tasks
             SET status = ?1, status_reason = ?2, updated_at = ?3, last_transition_at = ?3
             WHERE id = ?4 AND project_id = ?5",
            params![
                next_status,
                format!("{role_id} host run succeeded"),
                timestamp,
                task.id,
                project_id
            ],
        )
        .map_err(|err| CommandError::database("태스크 상태를 저장하지 못했습니다.", err))?;
        insert_audit(
            conn,
            project_id,
            "Task",
            Some(&task.id),
            "task.status_changed",
            json!({
                "taskId": task.id,
                "from": task.status,
                "to": next_status,
                "runId": run_id,
                "source": "host_runner"
            }),
        )?;
    }
    Ok(())
}

struct RoleContextContract {
    objective: &'static str,
    focus: &'static [&'static str],
    pass_conditions: &'static [&'static str],
    blocking_conditions: &'static [&'static str],
    forbidden: &'static [&'static str],
    gate: Option<&'static str>,
}

impl RoleContextContract {
    fn to_json(&self, role_id: &str) -> Value {
        json!({
            "roleId": role_id,
            "objective": self.objective,
            "focus": self.focus,
            "passConditions": self.pass_conditions,
            "blockingConditions": self.blocking_conditions,
            "forbidden": self.forbidden,
            "gate": self.gate
        })
    }
}

fn role_context_contract(role_id: &str) -> RoleContextContract {
    match role_id {
        "planner" => RoleContextContract {
            objective: "사용자 목표와 현재 저장소 맥락을 바탕으로 승인 가능한 실행 계획을 만든다.",
            focus: &[
                "문제 정의, 범위, acceptance criteria, 위험, 검증 계획을 명확히 분리한다.",
                "구현을 직접 변경하지 않고 계획 산출물만 작성한다.",
                "불확실하거나 사용자 확인이 필요한 항목은 open question으로 남긴다.",
            ],
            pass_conditions: &[
                "계획이 태스크의 목표와 직접 연결되어 있다.",
                "구현자가 바로 실행할 수 있는 작업 단위와 검증 방법이 있다.",
                "승인 전 자동 상태 전이를 요구하지 않는다.",
            ],
            blocking_conditions: &[
                "요구사항이 상충하거나 핵심 정보가 부족하다.",
                "저장소 구조를 확인하지 않고 큰 범위의 변경을 제안한다.",
            ],
            forbidden: &[
                "사용자 승인 없이 파일을 변경하지 않는다.",
                "현재 task scope 밖의 리팩토링을 계획에 끼워 넣지 않는다.",
            ],
            gate: None,
        },
        "coder" => RoleContextContract {
            objective: "승인된 계획과 task scope 안에서 최소 변경으로 구현을 완료한다.",
            focus: &[
                "기존 코드 스타일과 모듈 경계를 따른다.",
                "변경 파일과 의도, 남은 위험을 structured result에 정확히 기록한다.",
                "새 query/filter/API 계약 변경이 있으면 관련 cache key와 타입을 함께 갱신한다.",
            ],
            pass_conditions: &[
                "요구사항을 만족하는 코드 변경이 worktree에 남아 있다.",
                "고아 import, 명백한 타입 오류, 스키마 불일치를 만들지 않는다.",
                "검증하지 못한 항목은 risks 또는 nextActions에 남긴다.",
            ],
            blocking_conditions: &[
                "승인된 계획과 다른 방향의 변경이 필요하다.",
                "필수 파일이나 API 계약을 찾지 못했다.",
                "테스트 또는 타입 오류를 스스로 해결하지 못했다.",
            ],
            forbidden: &[
                "관련 없는 파일 정리나 스타일 변경을 하지 않는다.",
                "사용자 변경으로 보이는 dirty file을 되돌리지 않는다.",
            ],
            gate: None,
        },
        "plan_verifier" => RoleContextContract {
            objective: "승인된 계획과 실제 diff가 일치하는지 판정한다.",
            focus: &[
                "변경 파일, diff, task 설명, approval 상태를 비교한다.",
                "계획 밖 변경, 누락된 acceptance criteria, 위험한 상태 전이를 찾는다.",
                "차단 이슈는 gateResult.blocking=true로 남긴다.",
            ],
            pass_conditions: &[
                "구현 diff가 승인된 계획 범위 안에 있다.",
                "필수 acceptance criteria가 코드 또는 검증 계획으로 대응된다.",
                "blocking issue가 없으면 gateResult.status=pass를 남긴다.",
            ],
            blocking_conditions: &[
                "계획 밖 변경이 있거나 필수 변경이 누락되었다.",
                "사용자 승인이 필요한 범위 변경이 있다.",
            ],
            forbidden: &[
                "직접 코드를 수정하지 않는다.",
                "검토하지 않은 항목을 pass로 처리하지 않는다.",
            ],
            gate: Some("plan_verification"),
        },
        "code_reviewer" => RoleContextContract {
            objective: "diff의 결함, 유지보수 위험, 타입/상태 흐름 문제를 리뷰한다.",
            focus: &[
                "버그 가능성, 데이터 손실, stale cache, 권한/상태 전이 오류를 우선한다.",
                "발견 사항은 재현 조건과 파일 단위 근거를 포함한다.",
                "차단 이슈는 gateResult.blocking=true로 남긴다.",
            ],
            pass_conditions: &[
                "사용자 요구사항 대비 명백한 결함이 없다.",
                "새 위험이 있으면 non-blocking risk로 구분되어 있다.",
                "blocking finding이 없으면 gateResult.status=pass를 남긴다.",
            ],
            blocking_conditions: &[
                "런타임 오류, 타입 계약 위반, 잘못된 상태 전이가 예상된다.",
                "테스트 없이 넘기기 어려운 공용 계약 변경이 있다.",
            ],
            forbidden: &[
                "리뷰 중 직접 수정하지 않는다.",
                "스타일 취향만으로 blocking을 만들지 않는다.",
            ],
            gate: Some("code_review"),
        },
        "tester" => RoleContextContract {
            objective: "설정된 검증 명령과 산출물을 바탕으로 merge 전 품질을 판정한다.",
            focus: &[
                "타입체크, 단위 테스트, 빌드, 필요한 수동 검증 결과를 구분한다.",
                "실패 로그의 원인과 재시도 가능한 명령을 남긴다.",
                "차단 이슈는 gateResult.blocking=true로 남긴다.",
            ],
            pass_conditions: &[
                "필수 검증 명령이 통과했거나 명확한 생략 사유가 있다.",
                "변경 범위에 맞는 테스트 근거가 summary에 있다.",
                "blocking failure가 없으면 gateResult.status=pass를 남긴다.",
            ],
            blocking_conditions: &[
                "필수 테스트, 타입체크, 빌드가 실패했다.",
                "실패를 검증하지 못했거나 재현 가능한 로그가 없다.",
            ],
            forbidden: &[
                "검증 실패를 pass로 처리하지 않는다.",
                "테스트 목적 외 구현 변경을 하지 않는다.",
            ],
            gate: Some("test"),
        },
        _ => RoleContextContract {
            objective: "주어진 task scope 안에서 role 실행 결과를 만든다.",
            focus: &["Context Pack에 포함된 task, worktree, diff 정보를 따른다."],
            pass_conditions: &["structured-result.json schema v1을 만족한다."],
            blocking_conditions: &["role을 안전하게 완료할 수 없다."],
            forbidden: &["사용자 변경을 되돌리지 않는다."],
            gate: Some("rules"),
        },
    }
}

fn markdown_list(items: &[&str]) -> String {
    if items.is_empty() {
        return "- 없음".to_string();
    }
    items
        .iter()
        .map(|item| format!("- {item}"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn build_context_pack_markdown(
    root: &Path,
    task: &TaskSummary,
    worktree: &TaskWorktreeSummary,
    role_id: &str,
) -> CommandResult<String> {
    let contract = role_context_contract(role_id);
    let changed_files = git::changed_files(root)?;
    let recent_commits = git::recent_commits(root, 5)?;
    let refs = task
        .external_refs
        .iter()
        .map(|item| format!("- {}: {}", item.ref_type, item.ref_value))
        .collect::<Vec<_>>()
        .join("\n");
    let files = changed_files
        .iter()
        .map(|item| format!("- {} {}", item.status, item.path))
        .collect::<Vec<_>>()
        .join("\n");
    let commits = recent_commits
        .iter()
        .map(|item| format!("- {} {}", item.short_hash, item.subject))
        .collect::<Vec<_>>()
        .join("\n");

    Ok(format!(
        "# Helm Context Pack\n\n\
         ## Task\n\n\
         - id: {}\n\
         - title: {}\n\
         - status: {}\n\
         - role: {}\n\n\
         ## Description\n\n{}\n\n\
         ## Worktree\n\n\
         - branch: {}\n\
         - path: {}\n\
         - head: {}\n\n\
         ## Role Contract\n\n\
         - objective: {}\n\
         - gate: {}\n\n\
         ### Focus\n\n{}\n\n\
         ### Pass Conditions\n\n{}\n\n\
         ### Blocking Conditions\n\n{}\n\n\
         ### Forbidden\n\n{}\n\n\
         ## External Refs\n\n{}\n\n\
         ## Changed Files\n\n{}\n\n\
         ## Recent Commits\n\n{}\n\n\
         ## Expected Output\n\n\
         Agent는 `summary.md`와 schema v1을 만족하는 `structured-result.json`을 남겨야 한다.\n\
         `status=pass`는 pass conditions를 만족할 때만 사용한다.\n\
         차단 이슈가 있으면 `gateResult.status=fail`, `blocking=true`, `blockers`, `affectedFiles`, `suggestedNext`를 채운다.\n",
        task.id,
        task.title,
        task.status,
        role_id,
        if task.description.trim().is_empty() {
            "설명 없음"
        } else {
            task.description.as_str()
        },
        worktree.branch_name,
        worktree.worktree_path,
        worktree.head_hash.as_deref().unwrap_or("-"),
        contract.objective,
        contract.gate.unwrap_or("none"),
        markdown_list(contract.focus.as_ref()),
        markdown_list(contract.pass_conditions.as_ref()),
        markdown_list(contract.blocking_conditions.as_ref()),
        markdown_list(contract.forbidden.as_ref()),
        if refs.is_empty() {
            "- 없음"
        } else {
            refs.as_str()
        },
        if files.is_empty() {
            "- 변경 파일 없음"
        } else {
            files.as_str()
        },
        if commits.is_empty() {
            "- 커밋 없음"
        } else {
            commits.as_str()
        }
    ))
}

fn build_context_manifest(
    root: &Path,
    task: &TaskSummary,
    worktree: &TaskWorktreeSummary,
    role_id: &str,
) -> CommandResult<Value> {
    let contract = role_context_contract(role_id);
    Ok(json!({
        "schemaVersion": 1,
        "generatedAt": now(),
        "projectRoot": root.to_string_lossy(),
        "task": task,
        "roleId": role_id,
        "roleContract": contract.to_json(role_id),
        "worktree": worktree,
        "git": {
            "changedFiles": git::changed_files(root)?,
            "recentCommits": git::recent_commits(root, 5)?
        },
        "sources": [
            "task",
            "worktree",
            "externalRefs",
            "git.changedFiles",
            "git.recentCommits",
            "roleContract"
        ],
        "expectedArtifacts": [
            "summary.md",
            "structured-result.json",
            "stdout.log",
            "stderr.log"
        ]
    }))
}

fn validate_role_run_state(
    conn: &Connection,
    project_id: &str,
    task: &TaskSummary,
    role_id: &str,
) -> CommandResult<()> {
    let allowed = match role_id {
        "planner" => matches!(task.status.as_str(), "Planned" | "Blocked"),
        "coder" => task.status == "Ready",
        "plan_verifier" => task.status == "PlanVerification",
        "code_reviewer" => task.status == "CodeReview",
        "tester" => task.status == "Testing",
        _ => false,
    };
    if !allowed {
        return Err(CommandError::validation(
            "현재 태스크 상태에서는 이 역할을 실행할 수 없습니다.",
        ));
    }

    if role_id == "planner" {
        if has_plan_approval(conn, project_id, &task.id, "Pending")? {
            return Err(CommandError::validation(
                "이미 대기 중인 계획 승인이 있습니다.",
            ));
        }
        if has_plan_approval(conn, project_id, &task.id, "Approved")? {
            return Err(CommandError::validation("이미 승인된 계획이 있습니다."));
        }
    }

    if role_id == "coder" && !has_plan_approval(conn, project_id, &task.id, "Approved")? {
        return Err(CommandError::validation(
            "계획 승인 전에는 구현자 역할을 실행할 수 없습니다.",
        ));
    }

    Ok(())
}

fn has_plan_approval(
    conn: &Connection,
    project_id: &str,
    task_id: &str,
    status: &str,
) -> CommandResult<bool> {
    let exists: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM approvals
             WHERE project_id = ?1 AND entity_type = 'Task' AND entity_id = ?2
               AND approval_type = 'PlanApproval' AND status = ?3
             LIMIT 1",
            params![project_id, task_id, status],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| CommandError::database("승인 요청을 확인하지 못했습니다.", err))?;
    Ok(exists.is_some())
}

fn next_status_for_role(role_id: &str) -> Option<&'static str> {
    match role_id {
        "coder" => Some("PlanVerification"),
        "plan_verifier" => Some("CodeReview"),
        "code_reviewer" => Some("Testing"),
        "tester" => Some("MergeWaiting"),
        _ => None,
    }
}

fn next_role_for_task_status(status: &str) -> Option<&'static str> {
    match status {
        "Planned" | "Blocked" => Some("planner"),
        "Ready" => Some("coder"),
        "PlanVerification" => Some("plan_verifier"),
        "CodeReview" => Some("code_reviewer"),
        "Testing" => Some("tester"),
        _ => None,
    }
}

fn stub_summary(role_id: &str) -> String {
    format!(
        "# Stub {} Result\n\n이 실행은 실제 agent process 없이 생성된 Phase 2 검증용 결과입니다.\n\n- 역할: {}\n- 결과: pass\n",
        role_id, role_id
    )
}

fn stub_result(role_id: &str) -> Value {
    let next_action = if role_id == "planner" {
        "PlanApproval 승인 후 Ready 상태로 전이합니다."
    } else {
        "다음 상태로 전이합니다."
    };
    json!({
        "schemaVersion": 1,
        "status": "pass",
        "summary": format!("{role_id} stub run이 완료되었습니다."),
        "changedFiles": [],
        "risks": [],
        "nextActions": [next_action],
        "gateResult": null
    })
}

fn validate_structured_result(value: &Value) -> bool {
    value.get("schemaVersion").and_then(Value::as_i64) == Some(1)
        && matches!(
            value.get("status").and_then(Value::as_str),
            Some("pass" | "fail" | "needs_changes")
        )
        && value
            .get("summary")
            .and_then(Value::as_str)
            .is_some_and(|summary| !summary.trim().is_empty())
        && value.get("changedFiles").is_some_and(Value::is_array)
        && value.get("risks").is_some_and(Value::is_array)
        && value.get("nextActions").is_some_and(Value::is_array)
        && value
            .get("gateResult")
            .is_some_and(validate_gate_result_value)
}

fn structured_result_has_blocking_gate(value: &Value) -> bool {
    value
        .get("gateResult")
        .and_then(Value::as_object)
        .is_some_and(|gate| {
            let status = gate.get("status").and_then(Value::as_str);
            gate.get("blocking")
                .and_then(Value::as_bool)
                .unwrap_or(matches!(status, Some("fail" | "needs_inspection")))
        })
}

fn validate_gate_result_value(value: &Value) -> bool {
    if value.is_null() {
        return true;
    }
    let Some(gate) = value.as_object() else {
        return false;
    };

    gate.get("gate")
        .and_then(Value::as_str)
        .is_some_and(valid_gate)
        && matches!(
            gate.get("status").and_then(Value::as_str),
            Some("pass" | "warn" | "fail")
        )
        && gate.get("blocking").is_some_and(Value::is_boolean)
        && gate
            .get("blockers")
            .and_then(Value::as_array)
            .is_some_and(|items| items.iter().all(validate_gate_blocker))
        && gate
            .get("affectedFiles")
            .and_then(Value::as_array)
            .is_some_and(|items| items.iter().all(|item| item.as_str().is_some()))
        && gate
            .get("suggestedNext")
            .and_then(Value::as_object)
            .is_some_and(|suggested_next| {
                matches!(
                    suggested_next.get("action").and_then(Value::as_str),
                    Some("fix" | "retry" | "request_changes" | "approve" | "manual_review")
                ) && suggested_next
                    .get("reason")
                    .and_then(Value::as_str)
                    .is_some_and(|reason| !reason.trim().is_empty())
            })
}

fn validate_gate_blocker(value: &Value) -> bool {
    let Some(blocker) = value.as_object() else {
        return false;
    };
    blocker
        .get("id")
        .and_then(Value::as_str)
        .is_some_and(|id| !id.trim().is_empty())
        && matches!(
            blocker.get("severity").and_then(Value::as_str),
            Some("error" | "warning")
        )
        && blocker
            .get("summary")
            .and_then(Value::as_str)
            .is_some_and(|summary| !summary.trim().is_empty())
        && blocker
            .get("file")
            .is_none_or(|file| file.as_str().is_some())
}

struct DiffConsistencyCheck {
    actual_files: Vec<String>,
    reported_files: Vec<String>,
    missing_files: Vec<String>,
    extra_files: Vec<String>,
}

fn diff_consistency_check(
    role_id: &str,
    result: Option<&Value>,
    actual_changed_files: &[GitFileStatus],
) -> Option<DiffConsistencyCheck> {
    if role_id != "coder" {
        return None;
    }
    let result = result?;
    if result.get("status").and_then(Value::as_str) != Some("pass") {
        return None;
    }

    let reported_files = result
        .get("changedFiles")
        .and_then(Value::as_array)?
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect::<BTreeSet<_>>();
    let actual_files = actual_changed_files
        .iter()
        .map(|file| file.path.clone())
        .collect::<BTreeSet<_>>();

    if reported_files == actual_files {
        return None;
    }

    let missing_files = actual_files
        .difference(&reported_files)
        .cloned()
        .collect::<Vec<_>>();
    let extra_files = reported_files
        .difference(&actual_files)
        .cloned()
        .collect::<Vec<_>>();

    Some(DiffConsistencyCheck {
        actual_files: actual_files.into_iter().collect(),
        reported_files: reported_files.into_iter().collect(),
        missing_files,
        extra_files,
    })
}

fn diff_consistency_gate_result(check: &DiffConsistencyCheck) -> Value {
    let affected_files = check
        .actual_files
        .iter()
        .chain(check.reported_files.iter())
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    json!({
        "schemaVersion": 1,
        "status": "needs_changes",
        "summary": "structured-result changedFiles가 실제 Git diff와 일치하지 않습니다.",
        "changedFiles": affected_files.clone(),
        "risks": [
            "agent가 보고한 변경 파일과 실제 worktree 변경 파일이 달라 자동 전이를 중단했습니다."
        ],
        "nextActions": [
            "changedFiles를 실제 diff와 맞춘 뒤 coder role을 재실행하거나 수동으로 검토합니다."
        ],
        "gateResult": {
            "gate": "rules",
            "status": "fail",
            "blocking": true,
            "blockers": [
                {
                    "id": "changed-files-mismatch",
                    "severity": "error",
                    "summary": "reported changedFiles와 actual Git diff가 다릅니다."
                }
            ],
            "affectedFiles": affected_files,
            "suggestedNext": {
                "action": "fix",
                "reason": format!(
                    "missing={:?}, extra={:?}",
                    check.missing_files, check.extra_files
                )
            }
        }
    })
}

fn validate_relative_artifact_path(path: &str) -> CommandResult<()> {
    if path.trim().is_empty() || path.starts_with('/') || path.split('/').any(|part| part == "..") {
        return Err(CommandError::validation(
            "허용되지 않은 실행 산출물 경로입니다.",
        ));
    }
    Ok(())
}

fn option_string(value: Option<String>) -> Value {
    value.map(Value::String).unwrap_or(Value::Null)
}

fn option_i64(value: Option<i64>) -> Value {
    value.map(Value::from).unwrap_or(Value::Null)
}

fn default_role_presets() -> Value {
    json!([
        { "roleId": "planner", "label": "설계자", "provider": null },
        { "roleId": "coder", "label": "구현자", "provider": null },
        { "roleId": "plan_verifier", "label": "계획 검토자", "provider": null },
        { "roleId": "code_reviewer", "label": "코드 리뷰어", "provider": null },
        { "roleId": "tester", "label": "테스트 담당자", "provider": null }
    ])
}

fn default_ai_connections() -> Value {
    json!([])
}

fn default_role_assignments() -> Value {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    struct TestRepo {
        root: PathBuf,
    }

    impl Drop for TestRepo {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn test_repo() -> TestRepo {
        let root = std::env::temp_dir().join(format!("helm-test-{}", new_id()));
        fs::create_dir_all(&root).expect("create temp repo");
        run_git(&root, &["init"]);
        run_git(&root, &["config", "user.name", "Helm Test"]);
        run_git(&root, &["config", "user.email", "helm-test@example.com"]);
        fs::write(root.join("README.md"), "# test\n").expect("write readme");
        run_git(&root, &["add", "README.md"]);
        run_git(&root, &["commit", "-m", "initial"]);
        TestRepo { root }
    }

    fn run_git(root: &Path, args: &[&str]) {
        let output = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .output()
            .expect("run git");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn open_test_project(repo: &TestRepo) -> (Connection, ProjectSummary) {
        let mut conn = open_project_db(&repo.root).expect("open project db");
        let project = upsert_project(&conn, &repo.root).expect("upsert project");
        run_migrations(&mut conn).expect("migrations");
        (conn, project)
    }

    fn create_test_task(conn: &mut Connection, project_id: &str) -> TaskSummary {
        create_task(
            conn,
            project_id,
            CreateTaskInput {
                epic_id: None,
                title: "Fixture core loop".to_string(),
                description: Some("검증용 태스크".to_string()),
                external_refs: None,
            },
        )
        .expect("create task")
    }

    fn run_prepared_host_role(
        conn: &mut Connection,
        repo: &TestRepo,
        project_id: &str,
        task_id: &str,
        role_id: &str,
    ) -> AgentRunSummary {
        let run =
            prepare_role_context(conn, &repo.root, project_id, task_id, role_id).expect("context");
        run_host_role(
            conn,
            &repo.root,
            project_id,
            &run.id,
            Arc::new(AtomicBool::new(false)),
        )
        .expect("host run")
    }

    #[test]
    fn migrations_are_idempotent() {
        let mut conn = Connection::open_in_memory().expect("in-memory db");

        run_migrations(&mut conn).expect("first migration");
        run_migrations(&mut conn).expect("second migration");

        let version: i64 = conn
            .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
                row.get(0)
            })
            .expect("version");
        assert_eq!(version, 4);
    }

    #[test]
    fn rejects_unsafe_artifact_paths() {
        assert!(validate_relative_artifact_path(".helm/artifacts/runs/abc").is_ok());
        assert!(validate_relative_artifact_path("/tmp/abc").is_err());
        assert!(validate_relative_artifact_path(".helm/../secrets").is_err());
        assert!(validate_relative_artifact_path("").is_err());
    }

    #[test]
    fn validates_structured_result_contract() {
        let valid = stub_result("planner");
        assert!(validate_structured_result(&valid));

        let invalid = json!({
            "schemaVersion": 1,
            "status": "pass",
            "changedFiles": [],
            "risks": [],
            "nextActions": [],
            "gateResult": null
        });
        assert!(!validate_structured_result(&invalid));

        let invalid_gate = json!({
            "schemaVersion": 1,
            "status": "pass",
            "summary": "gate shape invalid",
            "changedFiles": [],
            "risks": [],
            "nextActions": [],
            "gateResult": {
                "gate": "code_review",
                "status": "pass",
                "blocking": false,
                "blockers": [{ "severity": "error", "summary": "missing id" }],
                "affectedFiles": [],
                "suggestedNext": { "action": "approve", "reason": "검증" }
            }
        });
        assert!(!validate_structured_result(&invalid_gate));
    }

    #[test]
    fn role_context_contracts_are_role_specific() {
        let planner = role_context_contract("planner");
        let verifier = role_context_contract("plan_verifier");
        let reviewer = role_context_contract("code_reviewer");
        let tester = role_context_contract("tester");

        assert_eq!(planner.gate, None);
        assert_eq!(verifier.gate, Some("plan_verification"));
        assert_eq!(reviewer.gate, Some("code_review"));
        assert_eq!(tester.gate, Some("test"));
        assert_ne!(planner.objective, verifier.objective);
    }

    #[test]
    fn planner_stub_creates_plan_approval_and_approval_moves_task_ready() {
        let repo = test_repo();
        let (mut conn, project) = open_test_project(&repo);
        let task = create_test_task(&mut conn, &project.id);

        let planner_run = run_stub_role(&mut conn, &repo.root, &project.id, &task.id, "planner")
            .expect("planner");
        assert_eq!(planner_run.status, "Succeeded");

        let approvals =
            list_approvals(&conn, &project.id, Some("Pending".to_string())).expect("approvals");
        assert_eq!(approvals.len(), 1);
        assert_eq!(approvals[0].approval_type, "PlanApproval");

        decide_approval(
            &mut conn,
            &project.id,
            &approvals[0].id,
            "Approved",
            "계획 승인",
        )
        .expect("approve");
        let updated = get_task(&conn, &task.id).expect("task");
        assert_eq!(updated.status, "Ready");
    }

    #[test]
    fn coder_is_blocked_before_plan_approval_and_allowed_after_approval() {
        let repo = test_repo();
        let (mut conn, project) = open_test_project(&repo);
        let task = create_test_task(&mut conn, &project.id);

        let blocked = run_stub_role(&mut conn, &repo.root, &project.id, &task.id, "coder")
            .expect_err("coder should be blocked");
        assert_eq!(blocked.code, "ValidationFailed");

        run_stub_role(&mut conn, &repo.root, &project.id, &task.id, "planner").expect("planner");
        let approval = list_approvals(&conn, &project.id, Some("Pending".to_string()))
            .expect("approvals")
            .remove(0);
        decide_approval(&mut conn, &project.id, &approval.id, "Approved", "승인").expect("approve");

        let coder_run =
            run_stub_role(&mut conn, &repo.root, &project.id, &task.id, "coder").expect("coder");
        assert_eq!(coder_run.status, "Succeeded");
        let updated = get_task(&conn, &task.id).expect("task");
        assert_eq!(updated.status, "PlanVerification");
    }

    #[test]
    fn prepare_role_context_creates_queued_run_and_context_artifacts() {
        let repo = test_repo();
        let (mut conn, project) = open_test_project(&repo);
        let task = create_test_task(&mut conn, &project.id);

        run_stub_role(&mut conn, &repo.root, &project.id, &task.id, "planner").expect("planner");
        let approval = list_approvals(&conn, &project.id, Some("Pending".to_string()))
            .expect("approvals")
            .remove(0);
        decide_approval(&mut conn, &project.id, &approval.id, "Approved", "승인").expect("approve");
        ensure_task_worktree(&mut conn, &repo.root, &project.id, &task.id).expect("worktree");

        let run = prepare_role_context(&mut conn, &repo.root, &project.id, &task.id, "coder")
            .expect("context");
        assert_eq!(run.status, "Queued");

        let artifact_dir = repo.root.join(&run.artifact_dir);
        assert!(artifact_dir.join("context-pack.md").exists());
        assert!(artifact_dir.join("context-pack.json").exists());
        assert!(artifact_dir.join("structured-result.schema.json").exists());

        let context_pack =
            fs::read_to_string(artifact_dir.join("context-pack.md")).expect("context pack");
        assert!(context_pack.contains("## Role Contract"));
        assert!(
            context_pack.contains("승인된 계획과 task scope 안에서 최소 변경으로 구현을 완료한다.")
        );

        let manifest: Value = serde_json::from_str(
            &fs::read_to_string(artifact_dir.join("context-pack.json")).expect("manifest"),
        )
        .expect("manifest json");
        assert_eq!(
            manifest
                .get("roleContract")
                .and_then(|value| value.get("roleId"))
                .and_then(Value::as_str),
            Some("coder")
        );
        assert_eq!(
            manifest
                .get("roleContract")
                .and_then(|value| value.get("gate")),
            Some(&Value::Null)
        );
    }

    #[test]
    fn fixture_host_core_loop_reaches_merge_waiting() {
        let repo = test_repo();
        let (mut conn, project) = open_test_project(&repo);
        let task = create_test_task(&mut conn, &project.id);
        let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("desktop app dir")
            .join("scripts")
            .join("fixture-runner.mjs");

        update_settings(
            &conn,
            &project.id,
            ProjectSettingsPatch {
                role_presets: Some(json!([
                    {
                        "roleId": "planner",
                        "label": "설계자",
                        "provider": "fixture",
                        "commandArgs": ["node", script.to_string_lossy(), "--mode", "pass"],
                        "timeoutSeconds": 60
                    },
                    {
                        "roleId": "coder",
                        "label": "구현자",
                        "provider": "fixture",
                        "commandArgs": ["node", script.to_string_lossy(), "--mode", "pass"],
                        "timeoutSeconds": 60
                    },
                    {
                        "roleId": "plan_verifier",
                        "label": "계획 검토자",
                        "provider": "fixture",
                        "commandArgs": ["node", script.to_string_lossy(), "--mode", "pass"],
                        "timeoutSeconds": 60
                    },
                    {
                        "roleId": "code_reviewer",
                        "label": "코드 리뷰어",
                        "provider": "fixture",
                        "commandArgs": ["node", script.to_string_lossy(), "--mode", "pass"],
                        "timeoutSeconds": 60
                    },
                    {
                        "roleId": "tester",
                        "label": "테스트 담당자",
                        "provider": "fixture",
                        "commandArgs": ["node", script.to_string_lossy(), "--mode", "pass"],
                        "timeoutSeconds": 60
                    }
                ])),
                ai_connections: None,
                role_assignments: None,
                worktree_root: None,
                jira_config: None,
                obsidian_vault_path: None,
                token_budget: None,
                artifact_retention_days: None,
            },
        )
        .expect("settings");
        ensure_task_worktree(&mut conn, &repo.root, &project.id, &task.id).expect("worktree");

        let planner = run_prepared_host_role(&mut conn, &repo, &project.id, &task.id, "planner");
        assert_eq!(planner.status, "Succeeded");
        let approval = list_approvals(&conn, &project.id, Some("Pending".to_string()))
            .expect("approvals")
            .remove(0);
        decide_approval(
            &mut conn,
            &project.id,
            &approval.id,
            "Approved",
            "계획 승인",
        )
        .expect("approve");

        let coder = run_prepared_host_role(&mut conn, &repo, &project.id, &task.id, "coder");
        assert_eq!(
            coder.status,
            "Succeeded",
            "coder result: {}; changed files: {}",
            fs::read_to_string(
                repo.root
                    .join(&coder.artifact_dir)
                    .join("structured-result.json")
            )
            .unwrap_or_default(),
            fs::read_to_string(
                repo.root
                    .join(&coder.artifact_dir)
                    .join("changed-files.json")
            )
            .unwrap_or_default()
        );
        let verifier =
            run_prepared_host_role(&mut conn, &repo, &project.id, &task.id, "plan_verifier");
        assert_eq!(verifier.status, "Succeeded");
        let reviewer =
            run_prepared_host_role(&mut conn, &repo, &project.id, &task.id, "code_reviewer");
        assert_eq!(reviewer.status, "Succeeded");
        let tester = run_prepared_host_role(&mut conn, &repo, &project.id, &task.id, "tester");
        assert_eq!(tester.status, "Succeeded");

        let updated_task = get_task(&conn, &task.id).expect("task");
        assert_eq!(updated_task.status, "MergeWaiting");

        let run_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM agent_runs WHERE task_id = ?1",
                params![task.id],
                |row| row.get(0),
            )
            .expect("run count");
        assert_eq!(run_count, 5);

        let evidence_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM command_evidence WHERE task_id = ?1",
                params![task.id],
                |row| row.get(0),
            )
            .expect("evidence count");
        assert_eq!(evidence_count, 5);

        let gate_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM gate_results WHERE task_id = ?1",
                params![task.id],
                |row| row.get(0),
            )
            .expect("gate count");
        assert_eq!(gate_count, 3);
    }

    #[test]
    fn host_run_records_command_evidence_gate_result_and_timeline() {
        let repo = test_repo();
        let (mut conn, project) = open_test_project(&repo);
        let task = create_test_task(&mut conn, &project.id);
        let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("desktop app dir")
            .join("scripts")
            .join("fixture-runner.mjs");

        update_task_status(
            &mut conn,
            &project.id,
            &task.id,
            "PlanVerification",
            Some("테스트 상태 전환".to_string()),
        )
        .expect("status");
        update_settings(
            &conn,
            &project.id,
            ProjectSettingsPatch {
                role_presets: Some(json!([
                    {
                        "roleId": "plan_verifier",
                        "label": "계획 검토자",
                        "provider": "fixture",
                        "commandArgs": ["node", script.to_string_lossy(), "--mode", "pass"],
                        "timeoutSeconds": 60
                    }
                ])),
                ai_connections: None,
                role_assignments: None,
                worktree_root: None,
                jira_config: None,
                obsidian_vault_path: None,
                token_budget: None,
                artifact_retention_days: None,
            },
        )
        .expect("settings");
        ensure_task_worktree(&mut conn, &repo.root, &project.id, &task.id).expect("worktree");

        let run = prepare_role_context(
            &mut conn,
            &repo.root,
            &project.id,
            &task.id,
            "plan_verifier",
        )
        .expect("context");
        let finished = run_host_role(
            &mut conn,
            &repo.root,
            &project.id,
            &run.id,
            Arc::new(AtomicBool::new(false)),
        )
        .expect("host run");
        assert_eq!(finished.status, "Succeeded");

        let evidence_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM command_evidence WHERE run_id = ?1",
                params![run.id],
                |row| row.get(0),
            )
            .expect("evidence count");
        assert_eq!(evidence_count, 1);

        let gate_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM gate_results WHERE run_id = ?1 AND gate = 'plan_verification'",
                params![run.id],
                |row| row.get(0),
            )
            .expect("gate count");
        assert_eq!(gate_count, 1);

        let timeline = list_task_timeline(&conn, &project.id, &task.id).expect("timeline");
        assert!(timeline
            .iter()
            .any(|entry| entry.entry_type == "command_evidence"));
        assert!(timeline
            .iter()
            .any(|entry| entry.entry_type == "gate_result"));
    }

    #[test]
    fn host_run_blocking_gate_creates_repair_request_without_advancing() {
        let repo = test_repo();
        let (mut conn, project) = open_test_project(&repo);
        let task = create_test_task(&mut conn, &project.id);
        let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("desktop app dir")
            .join("scripts")
            .join("fixture-runner.mjs");

        update_task_status(
            &mut conn,
            &project.id,
            &task.id,
            "PlanVerification",
            Some("테스트 상태 전환".to_string()),
        )
        .expect("status");
        update_settings(
            &conn,
            &project.id,
            ProjectSettingsPatch {
                role_presets: Some(json!([
                    {
                        "roleId": "plan_verifier",
                        "label": "계획 검토자",
                        "provider": "fixture",
                        "commandArgs": ["node", script.to_string_lossy(), "--mode", "gate_fail"],
                        "timeoutSeconds": 60
                    }
                ])),
                ai_connections: None,
                role_assignments: None,
                worktree_root: None,
                jira_config: None,
                obsidian_vault_path: None,
                token_budget: None,
                artifact_retention_days: None,
            },
        )
        .expect("settings");
        ensure_task_worktree(&mut conn, &repo.root, &project.id, &task.id).expect("worktree");

        let run = prepare_role_context(
            &mut conn,
            &repo.root,
            &project.id,
            &task.id,
            "plan_verifier",
        )
        .expect("context");
        let finished = run_host_role(
            &mut conn,
            &repo.root,
            &project.id,
            &run.id,
            Arc::new(AtomicBool::new(false)),
        )
        .expect("host run");
        assert_eq!(finished.status, "NeedsInspection");
        assert_eq!(finished.result_status.as_deref(), Some("pass"));

        let updated_task = get_task(&conn, &task.id).expect("task");
        assert_eq!(updated_task.status, "PlanVerification");

        let gate_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM gate_results
                 WHERE run_id = ?1 AND gate = 'plan_verification' AND status = 'fail' AND blocking = 1",
                params![run.id],
                |row| row.get(0),
            )
            .expect("gate count");
        assert_eq!(gate_count, 1);

        let repair_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM repair_requests WHERE run_id = ?1 AND status = 'Open'",
                params![run.id],
                |row| row.get(0),
            )
            .expect("repair count");
        assert_eq!(repair_count, 1);

        let timeline = list_task_timeline(&conn, &project.id, &task.id).expect("timeline");
        assert!(timeline
            .iter()
            .any(|entry| entry.entry_type == "repair_request"));
    }

    #[test]
    fn coder_host_run_blocks_when_reported_changed_files_do_not_match_diff() {
        let repo = test_repo();
        let (mut conn, project) = open_test_project(&repo);
        let task = create_test_task(&mut conn, &project.id);
        let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("desktop app dir")
            .join("scripts")
            .join("fixture-runner.mjs");

        run_stub_role(&mut conn, &repo.root, &project.id, &task.id, "planner").expect("planner");
        let approval = list_approvals(&conn, &project.id, Some("Pending".to_string()))
            .expect("approvals")
            .remove(0);
        decide_approval(&mut conn, &project.id, &approval.id, "Approved", "승인").expect("approve");
        update_settings(
            &conn,
            &project.id,
            ProjectSettingsPatch {
                role_presets: Some(json!([
                    {
                        "roleId": "coder",
                        "label": "구현자",
                        "provider": "fixture",
                        "commandArgs": ["node", script.to_string_lossy(), "--mode", "changed_files_mismatch"],
                        "timeoutSeconds": 60
                    }
                ])),
                ai_connections: None,
                role_assignments: None,
                worktree_root: None,
                jira_config: None,
                obsidian_vault_path: None,
                token_budget: None,
                artifact_retention_days: None,
            },
        )
        .expect("settings");
        ensure_task_worktree(&mut conn, &repo.root, &project.id, &task.id).expect("worktree");

        let run = prepare_role_context(&mut conn, &repo.root, &project.id, &task.id, "coder")
            .expect("context");
        let finished = run_host_role(
            &mut conn,
            &repo.root,
            &project.id,
            &run.id,
            Arc::new(AtomicBool::new(false)),
        )
        .expect("host run");
        assert_eq!(finished.status, "NeedsInspection");
        assert_eq!(finished.result_status.as_deref(), Some("pass"));

        let updated_task = get_task(&conn, &task.id).expect("task");
        assert_eq!(updated_task.status, "Ready");

        let rules_gate_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM gate_results
                 WHERE run_id = ?1 AND gate = 'rules' AND status = 'fail' AND blocking = 1",
                params![run.id],
                |row| row.get(0),
            )
            .expect("gate count");
        assert_eq!(rules_gate_count, 1);

        let repair_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM repair_requests WHERE run_id = ?1 AND status = 'Open'",
                params![run.id],
                |row| row.get(0),
            )
            .expect("repair count");
        assert_eq!(repair_count, 1);
    }

    #[test]
    fn prepare_next_role_context_creates_worktree_and_planner_queue() {
        let repo = test_repo();
        let (mut conn, project) = open_test_project(&repo);
        let task = create_test_task(&mut conn, &project.id);

        let run =
            prepare_next_role_context(&mut conn, &repo.root, &project.id, &task.id).expect("next");
        let worktree = get_task_worktree(&conn, &project.id, &task.id).expect("worktree");

        assert_eq!(run.role_id, "planner");
        assert_eq!(run.status, "Queued");
        assert!(worktree.is_some());
    }

    #[test]
    fn prepare_next_role_context_after_plan_approval_queues_coder() {
        let repo = test_repo();
        let (mut conn, project) = open_test_project(&repo);
        let task = create_test_task(&mut conn, &project.id);

        run_stub_role(&mut conn, &repo.root, &project.id, &task.id, "planner").expect("planner");
        let approval = list_approvals(&conn, &project.id, Some("Pending".to_string()))
            .expect("approvals")
            .remove(0);
        decide_approval(&mut conn, &project.id, &approval.id, "Approved", "승인").expect("approve");

        let run =
            prepare_next_role_context(&mut conn, &repo.root, &project.id, &task.id).expect("next");

        assert_eq!(run.role_id, "coder");
        assert_eq!(run.status, "Queued");
    }

    #[test]
    fn role_assignment_command_injects_provider_model_flag() {
        let settings = EffectiveSettings {
            role_presets: default_role_presets(),
            ai_connections: json!([
                {
                    "id": "codex-local",
                    "label": "Codex CLI",
                    "provider": "codex",
                    "commandArgs": ["codex", "exec", "--cd", "{worktreePath}", "--", "run {roleId}"],
                    "timeoutSeconds": 120,
                    "enabled": true,
                    "defaultModel": "gpt-5.2"
                }
            ]),
            role_assignments: json!([
                {
                    "roleId": "coder",
                    "selectionMode": "single",
                    "connectionIds": ["codex-local"],
                    "selections": [{ "connectionId": "codex-local", "model": "gpt-5.4" }],
                    "aggregationPolicy": null
                }
            ]),
            worktree_root: None,
            jira_config: None,
            obsidian_vault_path: None,
            token_budget: None,
            artifact_retention_days: Some(30),
        };
        let placeholders = HashMap::from([
            ("worktreePath".to_string(), "/tmp/helm-worktree".to_string()),
            ("roleId".to_string(), "coder".to_string()),
        ]);

        let command =
            resolve_host_runner_command(&settings, "coder", &placeholders).expect("command");

        assert_eq!(
            command.args,
            vec![
                "codex",
                "exec",
                "-m",
                "gpt-5.4",
                "--cd",
                "/tmp/helm-worktree",
                "--",
                "run coder"
            ]
        );
        assert_eq!(command.timeout_seconds, 120);
        assert_eq!(command.model.as_deref(), Some("gpt-5.4"));
    }

    #[test]
    fn reconcile_interrupted_runs_marks_running_runs_for_inspection() {
        let repo = test_repo();
        let (mut conn, project) = open_test_project(&repo);
        let task = create_test_task(&mut conn, &project.id);
        let timestamp = now();
        let run_id = new_id();

        conn.execute(
            "INSERT INTO agent_runs (
               id, project_id, task_id, role_id, status, artifact_dir, summary_path, result_path,
               stdout_log_path, stderr_log_path, started_at, created_at, updated_at
             )
             VALUES (?1, ?2, ?3, 'coder', 'Running', ?4, 'summary.md', 'structured-result.json',
                     'stdout.log', 'stderr.log', ?5, ?5, ?5)",
            params![
                run_id,
                project.id,
                task.id,
                ".helm/artifacts/runs/reconcile-test",
                timestamp
            ],
        )
        .expect("insert running run");

        let count = reconcile_interrupted_runs(&conn, &project.id).expect("reconcile");
        assert_eq!(count, 1);

        let run = get_agent_run(&conn, &run_id).expect("run");
        assert_eq!(run.status, "NeedsInspection");
        assert!(run.finished_at.is_some());
    }
}
