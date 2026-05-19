use crate::git;
use crate::models::{
    AgentRunSummary, ApprovalSummary, AuditLogEntry, CommandError, CommandResult, CreateEpicInput,
    CreateTaskInput, EffectiveSettings, EpicSummary, ProjectSettingsPatch, ProjectSummary,
    TaskCounts, TaskExternalRefInput, TaskExternalRefSummary, TaskSummary, TaskWorktreeSummary,
};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};
use uuid::Uuid;

const SUPPORTED_SCHEMA_VERSION: i64 = 3;
const PHASE1_MIGRATION: &str = include_str!("../migrations/0001_phase1.sql");
const PHASE2_MIGRATION: &str = include_str!("../migrations/0002_phase2_runs_approvals.sql");
const PHASE3A_MIGRATION: &str = include_str!("../migrations/0003_phase3a_worktrees.sql");

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
        worktree_root: settings
            .remove("worktreeRoot")
            .and_then(|value| value.as_str().map(str::to_string)),
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
    if let Some(value) = patch.worktree_root {
        values.push(("worktreeRoot", option_string(value)));
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
    let command_args = role_command_args(
        &settings.role_presets,
        &run.role_id,
        &host_runner_placeholders(root, &worktree, &run),
    )?;
    let timeout_seconds = role_timeout_seconds(&settings.role_presets, &run.role_id);
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
            "runner": "HelmHostRunner"
        }),
    )?;

    let artifact_path = root.join(&run.artifact_dir);
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
            .env("HELM_ROLE_ID", run.role_id.clone()),
        timeout_seconds,
        cancellation,
    )?;

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
    } else if result_status.as_deref() == Some("pass") {
        "Succeeded"
    } else {
        "NeedsInspection"
    };
    let finished_at = now();
    conn.execute(
        "UPDATE agent_runs
         SET status = ?1, exit_code = ?2, result_status = ?3, finished_at = ?4, updated_at = ?4
         WHERE id = ?5",
        params![final_status, exit_code, result_status, finished_at, run_id],
    )
    .map_err(|err| CommandError::database("host run 결과를 저장하지 못했습니다.", err))?;
    insert_audit(
        conn,
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
            "changedFiles": changed_files
        }),
    )?;

    if final_status == "Succeeded" && result_status.as_deref() == Some("pass") {
        apply_successful_role_result(conn, project_id, &task, &run.role_id, run_id)?;
    }

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

fn build_context_pack_markdown(
    root: &Path,
    task: &TaskSummary,
    worktree: &TaskWorktreeSummary,
    role_id: &str,
) -> CommandResult<String> {
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
         ## External Refs\n\n{}\n\n\
         ## Changed Files\n\n{}\n\n\
         ## Recent Commits\n\n{}\n\n\
         ## Expected Output\n\n\
         Agent는 `summary.md`와 schema v1을 만족하는 `structured-result.json`을 남겨야 한다.\n",
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
    Ok(json!({
        "schemaVersion": 1,
        "projectRoot": root.to_string_lossy(),
        "task": task,
        "roleId": role_id,
        "worktree": worktree,
        "git": {
            "changedFiles": git::changed_files(root)?,
            "recentCommits": git::recent_commits(root, 5)?
        },
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
        && value.get("gateResult").is_some()
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

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(version, 3);
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
    }
}
