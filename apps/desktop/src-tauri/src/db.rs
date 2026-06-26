use crate::git;
use crate::models::{
    AgentRunSummary, AgentSessionSummary, ApprovalSummary, AuditLogEntry, CommandError,
    CommandResult, CoordinationExportSummary, CreateEpicInput, CreatePlanningSessionInput,
    ConversationMessage, CreateTaskInput, DecidePlanDraftInput, EffectiveSettings, EpicSummary,
    GitFileStatus,
    PlanDraftRevisionSummary, PlanningApprovalSummary, PlanningMaterializationSummary,
    PlanningMessageSummary, PlanningSessionDetail, PlanningSessionSummary, ProjectSettingsPatch,
    ProjectSummary, RunEventSummary, SavePlanDraftRevisionInput, SaveTerminalScriptInput,
    TaskCounts, TaskExternalRefInput, TaskExternalRefSummary, TaskGraphConflictSummary,
    TaskGraphExportSummary, TaskSummary, TaskTimelineEntry, TaskWorktreeSummary,
    TerminalSavedScriptSummary,
};
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::env;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc,
};
use std::time::{Duration, Instant};
use uuid::Uuid;

const SUPPORTED_SCHEMA_VERSION: i64 = 18;
const PHASE1_MIGRATION: &str = include_str!("../migrations/0001_phase1.sql");
const PHASE2_MIGRATION: &str = include_str!("../migrations/0002_phase2_runs_approvals.sql");
const PHASE3A_MIGRATION: &str = include_str!("../migrations/0003_phase3a_worktrees.sql");
const PHASE4_MIGRATION: &str = include_str!("../migrations/0004_evidence_gate_timeline.sql");
const PHASE5_MIGRATION: &str = include_str!("../migrations/0005_run_events.sql");
const PHASE6_MIGRATION: &str = include_str!("../migrations/0006_run_lifecycle.sql");
const PHASE7_MIGRATION: &str = include_str!("../migrations/0007_repair_run_links.sql");
const PHASE8_MIGRATION: &str = include_str!("../migrations/0008_planning_workspace.sql");
const PHASE9_MIGRATION: &str = include_str!("../migrations/0009_planning_approvals_artifacts.sql");
const PHASE10_MIGRATION: &str = include_str!("../migrations/0010_terminal_orca_parity.sql");
const PHASE11_MIGRATION: &str = include_str!("../migrations/0011_agent_run_runner_metadata.sql");
const PHASE12_MIGRATION: &str = include_str!("../migrations/0012_agent_run_host_pid.sql");
const PHASE13_MIGRATION: &str = include_str!("../migrations/0013_review_approval.sql");
const PHASE14_MIGRATION: &str = include_str!("../migrations/0014_task_worktree_mode.sql");
const PHASE15_MIGRATION: &str = include_str!("../migrations/0015_conversation_messages.sql");
const PHASE16_MIGRATION: &str = include_str!("../migrations/0016_role_retrospectives.sql");
const PHASE17_MIGRATION: &str = include_str!("../migrations/0017_role_lesson_approval.sql");
const PHASE18_MIGRATION: &str = include_str!("../migrations/0018_role_lesson_source.sql");
const TASK_STATUS_ORDER: &[&str] = &[
    "Planned",
    "Ready",
    "Coding",
    "PlanVerification",
    "CodeReview",
    "Testing",
    "MergeWaiting",
    "Merged",
    "Done",
    "Blocked",
];
const REPAIR_FAILURE_LIMIT: i64 = 3;

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

pub fn list_terminal_saved_scripts(
    conn: &Connection,
    project_id: &str,
) -> CommandResult<Vec<TerminalSavedScriptSummary>> {
    let mut stmt = conn
        .prepare(
            "SELECT id, project_id, name, command, cwd_mode, node_bin_path, tags_json,
                    last_used_at, created_at, updated_at
             FROM terminal_saved_scripts
             WHERE project_id = ?1
             ORDER BY COALESCE(last_used_at, updated_at) DESC, updated_at DESC",
        )
        .map_err(|err| CommandError::database("저장된 터미널 스크립트를 읽지 못했습니다.", err))?;
    let rows = stmt
        .query_map(params![project_id], terminal_saved_script_from_row)
        .map_err(|err| CommandError::database("저장된 터미널 스크립트를 읽지 못했습니다.", err))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| CommandError::database("저장된 터미널 스크립트를 읽지 못했습니다.", err))
}

pub fn save_terminal_saved_script(
    conn: &mut Connection,
    project_id: &str,
    input: SaveTerminalScriptInput,
) -> CommandResult<TerminalSavedScriptSummary> {
    ensure_project_exists(conn, project_id)?;
    let id = input
        .id
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(new_id);
    if let Some(existing_project_id) = conn
        .query_row(
            "SELECT project_id FROM terminal_saved_scripts WHERE id = ?1",
            params![id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|err| {
            CommandError::database("저장된 터미널 스크립트를 확인하지 못했습니다.", err)
        })?
    {
        if existing_project_id != project_id {
            return Err(CommandError::validation(
                "다른 프로젝트의 터미널 스크립트는 수정할 수 없습니다.",
            ));
        }
    }
    let name = normalize_terminal_script_name(&input.name)?;
    let command = normalize_terminal_script_command(&input.command)?;
    validate_terminal_script_safety(&command)?;
    let cwd_mode = input.cwd_mode.unwrap_or_else(|| "active_pane".to_string());
    validate_terminal_script_cwd_mode(&cwd_mode)?;
    let node_bin_path = input.node_bin_path.and_then(|value| {
        let trimmed = value.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    });
    let tags = input
        .tags
        .unwrap_or_default()
        .into_iter()
        .map(|tag| tag.trim().to_string())
        .filter(|tag| !tag.is_empty())
        .take(16)
        .collect::<Vec<_>>();
    let tags_json = serde_json::to_string(&tags).map_err(|err| {
        CommandError::with_details("SerializationFailed", "태그를 저장하지 못했습니다.", err)
    })?;
    let timestamp = now();
    conn.execute(
        "INSERT INTO terminal_saved_scripts (
           id, project_id, name, command, cwd_mode, node_bin_path, tags_json,
           last_used_at, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, ?8)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           command = excluded.command,
           cwd_mode = excluded.cwd_mode,
           node_bin_path = excluded.node_bin_path,
           tags_json = excluded.tags_json,
           updated_at = excluded.updated_at",
        params![
            id,
            project_id,
            name,
            command,
            cwd_mode,
            node_bin_path,
            tags_json,
            timestamp
        ],
    )
    .map_err(|err| CommandError::database("터미널 스크립트를 저장하지 못했습니다.", err))?;
    get_terminal_saved_script(conn, project_id, &id)
}

pub fn mark_terminal_saved_script_used(
    conn: &mut Connection,
    project_id: &str,
    script_id: &str,
) -> CommandResult<TerminalSavedScriptSummary> {
    let timestamp = now();
    let changed = conn
        .execute(
            "UPDATE terminal_saved_scripts
             SET last_used_at = ?3, updated_at = ?3
             WHERE project_id = ?1 AND id = ?2",
            params![project_id, script_id, timestamp],
        )
        .map_err(|err| {
            CommandError::database("터미널 스크립트 사용 시간을 저장하지 못했습니다.", err)
        })?;
    if changed == 0 {
        return Err(CommandError::validation(
            "저장된 터미널 스크립트를 찾을 수 없습니다.",
        ));
    }
    get_terminal_saved_script(conn, project_id, script_id)
}

pub fn delete_terminal_saved_script(
    conn: &mut Connection,
    project_id: &str,
    script_id: &str,
) -> CommandResult<()> {
    conn.execute(
        "DELETE FROM terminal_saved_scripts WHERE project_id = ?1 AND id = ?2",
        params![project_id, script_id],
    )
    .map_err(|err| CommandError::database("터미널 스크립트를 삭제하지 못했습니다.", err))?;
    Ok(())
}

fn get_terminal_saved_script(
    conn: &Connection,
    project_id: &str,
    script_id: &str,
) -> CommandResult<TerminalSavedScriptSummary> {
    conn.query_row(
        "SELECT id, project_id, name, command, cwd_mode, node_bin_path, tags_json,
                last_used_at, created_at, updated_at
         FROM terminal_saved_scripts
         WHERE project_id = ?1 AND id = ?2",
        params![project_id, script_id],
        terminal_saved_script_from_row,
    )
    .optional()
    .map_err(|err| CommandError::database("저장된 터미널 스크립트를 읽지 못했습니다.", err))?
    .ok_or_else(|| CommandError::validation("저장된 터미널 스크립트를 찾을 수 없습니다."))
}

fn terminal_saved_script_from_row(row: &Row<'_>) -> rusqlite::Result<TerminalSavedScriptSummary> {
    let tags_json: String = row.get(6)?;
    let tags = serde_json::from_str::<Vec<String>>(&tags_json).unwrap_or_default();
    Ok(TerminalSavedScriptSummary {
        id: row.get(0)?,
        project_id: row.get(1)?,
        name: row.get(2)?,
        command: row.get(3)?,
        cwd_mode: row.get(4)?,
        node_bin_path: row.get(5)?,
        tags,
        last_used_at: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

fn ensure_project_exists(conn: &Connection, project_id: &str) -> CommandResult<()> {
    let exists = conn
        .query_row(
            "SELECT 1 FROM projects WHERE id = ?1",
            params![project_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(|err| CommandError::database("프로젝트를 확인하지 못했습니다.", err))?;
    exists.ok_or_else(|| CommandError::validation("프로젝트를 찾을 수 없습니다."))
}

fn normalize_terminal_script_name(value: &str) -> CommandResult<String> {
    let name = value.trim().chars().take(80).collect::<String>();
    if name.is_empty() {
        return Err(CommandError::validation("스크립트 이름을 입력해주세요."));
    }
    Ok(name)
}

fn normalize_terminal_script_command(value: &str) -> CommandResult<String> {
    let command = value
        .trim()
        .replace("\r\n", "\n")
        .chars()
        .take(4000)
        .collect::<String>();
    if command.is_empty() {
        return Err(CommandError::validation("저장할 스크립트가 비어 있습니다."));
    }
    Ok(command)
}

fn validate_terminal_script_cwd_mode(value: &str) -> CommandResult<()> {
    match value {
        "active_pane" | "project_root" | "fixed_cwd" => Ok(()),
        _ => Err(CommandError::validation(
            "지원하지 않는 터미널 스크립트 cwd mode입니다.",
        )),
    }
}

fn validate_terminal_script_safety(command: &str) -> CommandResult<()> {
    let lower = command.to_lowercase();
    let secret_markers = [
        "password=",
        "passwd=",
        "token=",
        "secret=",
        "api_key=",
        "apikey=",
        "authorization=",
        "bearer ",
    ];
    if secret_markers.iter().any(|marker| lower.contains(marker)) {
        return Err(CommandError::validation(
            "비밀값처럼 보이는 내용은 저장된 터미널 스크립트에 넣을 수 없습니다.",
        ));
    }
    Ok(())
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
    } else if !table_exists(conn, "command_evidence")? {
        apply_schema_patch(conn, PHASE4_MIGRATION)?;
    }
    if current_version < 5 {
        apply_migration(conn, 5, "phase5_run_events", PHASE5_MIGRATION)?;
    } else if !table_exists(conn, "run_events")? {
        apply_schema_patch(conn, PHASE5_MIGRATION)?;
    }
    if current_version < 6 {
        apply_migration(conn, 6, "phase6_run_lifecycle", PHASE6_MIGRATION)?;
    } else if !table_has_column(conn, "agent_runs", "lifecycle_phase")? {
        apply_schema_patch(conn, PHASE6_MIGRATION)?;
    }
    if current_version < 7 {
        apply_migration(conn, 7, "phase7_repair_run_links", PHASE7_MIGRATION)?;
    } else if !table_has_column(conn, "agent_runs", "repair_request_id")? {
        apply_schema_patch(conn, PHASE7_MIGRATION)?;
    }
    if current_version < 8 {
        apply_migration(conn, 8, "phase8_planning_workspace", PHASE8_MIGRATION)?;
    } else if !table_exists(conn, "planning_sessions")? {
        apply_schema_patch(conn, PHASE8_MIGRATION)?;
    }
    if current_version < 9 {
        apply_migration(
            conn,
            9,
            "phase9_planning_approvals_artifacts",
            PHASE9_MIGRATION,
        )?;
    } else if !table_exists(conn, "planning_approvals")?
        || !table_has_column(conn, "plan_draft_revisions", "artifact_path")?
    {
        apply_phase9_schema_patch(conn)?;
    }
    if current_version < 10 {
        apply_migration(conn, 10, "phase10_terminal_orca_parity", PHASE10_MIGRATION)?;
    } else if !table_exists(conn, "terminal_saved_scripts")?
        || !table_exists(conn, "terminal_layouts")?
    {
        apply_schema_patch(conn, PHASE10_MIGRATION)?;
    }
    if current_version < 11 {
        apply_migration(
            conn,
            11,
            "phase11_agent_run_runner_metadata",
            PHASE11_MIGRATION,
        )?;
    } else if !table_has_column(conn, "agent_runs", "provider")?
        || !table_has_column(conn, "agent_runs", "connection_id")?
        || !table_has_column(conn, "agent_runs", "model")?
    {
        apply_phase11_schema_patch(conn)?;
    }
    if current_version < 12 {
        apply_migration(conn, 12, "phase12_agent_run_host_pid", PHASE12_MIGRATION)?;
    } else if !table_has_column(conn, "agent_runs", "host_pid")? {
        apply_schema_patch(conn, PHASE12_MIGRATION)?;
    }
    if current_version < 13 {
        apply_migration(conn, 13, "phase13_review_approval", PHASE13_MIGRATION)?;
    }
    if current_version < 14 {
        apply_migration(conn, 14, "phase14_task_worktree_mode", PHASE14_MIGRATION)?;
    } else if !table_has_column(conn, "tasks", "worktree_mode")? {
        apply_schema_patch(conn, PHASE14_MIGRATION)?;
    }
    if current_version < 15 {
        apply_migration(conn, 15, "phase15_conversation_messages", PHASE15_MIGRATION)?;
    } else if !table_exists(conn, "conversation_messages")? {
        apply_schema_patch(conn, PHASE15_MIGRATION)?;
    }
    if current_version < 16 {
        apply_migration(conn, 16, "phase16_role_retrospectives", PHASE16_MIGRATION)?;
    } else if !table_exists(conn, "role_retrospectives")? {
        apply_schema_patch(conn, PHASE16_MIGRATION)?;
    }
    if current_version < 17 {
        apply_migration(conn, 17, "phase17_role_lesson_approval", PHASE17_MIGRATION)?;
    }
    if current_version < 18 {
        apply_migration(conn, 18, "phase18_role_lesson_source", PHASE18_MIGRATION)?;
    } else if !table_has_column(conn, "role_retrospectives", "source")? {
        apply_schema_patch(conn, PHASE18_MIGRATION)?;
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

fn apply_schema_patch(conn: &mut Connection, sql: &str) -> CommandResult<()> {
    let tx = conn
        .transaction()
        .map_err(|err| CommandError::database("Helm 데이터베이스 업데이트에 실패했습니다.", err))?;
    tx.execute_batch(sql)
        .map_err(|err| CommandError::database("Helm 데이터베이스 업데이트에 실패했습니다.", err))?;
    tx.commit()
        .map_err(|err| CommandError::database("Helm 데이터베이스 업데이트에 실패했습니다.", err))?;
    Ok(())
}

fn apply_phase9_schema_patch(conn: &mut Connection) -> CommandResult<()> {
    let tx = conn
        .transaction()
        .map_err(|err| CommandError::database("Helm 데이터베이스 업데이트에 실패했습니다.", err))?;
    if !table_has_column(&tx, "plan_draft_revisions", "artifact_path")? {
        tx.execute_batch("ALTER TABLE plan_draft_revisions ADD COLUMN artifact_path TEXT;")
            .map_err(|err| {
                CommandError::database("Helm 데이터베이스 업데이트에 실패했습니다.", err)
            })?;
    }
    if !table_has_column(&tx, "plan_draft_revisions", "content_hash")? {
        tx.execute_batch("ALTER TABLE plan_draft_revisions ADD COLUMN content_hash TEXT;")
            .map_err(|err| {
                CommandError::database("Helm 데이터베이스 업데이트에 실패했습니다.", err)
            })?;
    }
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS planning_approvals (
           id TEXT PRIMARY KEY,
           project_id TEXT NOT NULL,
           session_id TEXT NOT NULL,
           draft_id TEXT NOT NULL UNIQUE,
           status TEXT NOT NULL,
           requested_reason TEXT NOT NULL,
           decision_reason TEXT,
           requested_at TEXT NOT NULL,
           decided_at TEXT,
           created_at TEXT NOT NULL,
           updated_at TEXT NOT NULL,
           CHECK (status IN ('Pending', 'Approved', 'Rejected')),
           FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
           FOREIGN KEY (session_id) REFERENCES planning_sessions(id) ON DELETE CASCADE,
           FOREIGN KEY (draft_id) REFERENCES plan_draft_revisions(id) ON DELETE CASCADE
         );
         CREATE INDEX IF NOT EXISTS idx_planning_approvals_session_status
           ON planning_approvals(session_id, status);

         INSERT INTO planning_approvals (
           id,
           project_id,
           session_id,
           draft_id,
           status,
           requested_reason,
           decision_reason,
           requested_at,
           decided_at,
           created_at,
           updated_at
         )
         SELECT
           lower(hex(randomblob(16))),
           drafts.project_id,
           drafts.session_id,
           drafts.id,
           CASE WHEN sessions.status = 'Approved' THEN 'Approved' ELSE 'Pending' END,
           'Backfilled approval request for existing Plan Document revision',
           CASE WHEN sessions.status = 'Approved' THEN 'Backfilled from approved planning session' ELSE NULL END,
           drafts.created_at,
           CASE WHEN sessions.status = 'Approved' THEN sessions.updated_at ELSE NULL END,
           drafts.created_at,
           sessions.updated_at
         FROM plan_draft_revisions AS drafts
         JOIN planning_sessions AS sessions
           ON sessions.id = drafts.session_id
          AND sessions.project_id = drafts.project_id
         WHERE sessions.current_draft_id = drafts.id
           AND NOT EXISTS (
             SELECT 1
             FROM planning_approvals AS approvals
             WHERE approvals.draft_id = drafts.id
           );",
    )
    .map_err(|err| CommandError::database("Helm 데이터베이스 업데이트에 실패했습니다.", err))?;
    tx.commit()
        .map_err(|err| CommandError::database("Helm 데이터베이스 업데이트에 실패했습니다.", err))?;
    Ok(())
}

fn apply_phase11_schema_patch(conn: &mut Connection) -> CommandResult<()> {
    let tx = conn
        .transaction()
        .map_err(|err| CommandError::database("Helm 데이터베이스 업데이트에 실패했습니다.", err))?;
    if !table_has_column(&tx, "agent_runs", "provider")? {
        tx.execute_batch("ALTER TABLE agent_runs ADD COLUMN provider TEXT;")
            .map_err(|err| {
                CommandError::database("Helm 데이터베이스 업데이트에 실패했습니다.", err)
            })?;
    }
    if !table_has_column(&tx, "agent_runs", "connection_id")? {
        tx.execute_batch("ALTER TABLE agent_runs ADD COLUMN connection_id TEXT;")
            .map_err(|err| {
                CommandError::database("Helm 데이터베이스 업데이트에 실패했습니다.", err)
            })?;
    }
    if !table_has_column(&tx, "agent_runs", "model")? {
        tx.execute_batch("ALTER TABLE agent_runs ADD COLUMN model TEXT;")
            .map_err(|err| {
                CommandError::database("Helm 데이터베이스 업데이트에 실패했습니다.", err)
            })?;
    }
    backfill_agent_run_runner_metadata(&tx)?;
    tx.commit()
        .map_err(|err| CommandError::database("Helm 데이터베이스 업데이트에 실패했습니다.", err))?;
    Ok(())
}

fn backfill_agent_run_runner_metadata(conn: &Connection) -> CommandResult<()> {
    conn.execute_batch(
        "UPDATE agent_runs
         SET
           provider = COALESCE(provider, (
             SELECT json_extract(run_events.payload_json, '$.provider')
             FROM run_events
             WHERE run_events.run_id = agent_runs.id
               AND run_events.message = 'Runner request captured'
               AND json_valid(run_events.payload_json)
             ORDER BY run_events.seq DESC
             LIMIT 1
           )),
           connection_id = COALESCE(connection_id, (
             SELECT json_extract(run_events.payload_json, '$.connectionId')
             FROM run_events
             WHERE run_events.run_id = agent_runs.id
               AND run_events.message = 'Runner request captured'
               AND json_valid(run_events.payload_json)
             ORDER BY run_events.seq DESC
             LIMIT 1
           )),
           model = COALESCE(model, (
             SELECT json_extract(run_events.payload_json, '$.model')
             FROM run_events
             WHERE run_events.run_id = agent_runs.id
               AND run_events.message = 'Runner request captured'
               AND json_valid(run_events.payload_json)
             ORDER BY run_events.seq DESC
             LIMIT 1
           ))
         WHERE EXISTS (
           SELECT 1
           FROM run_events
           WHERE run_events.run_id = agent_runs.id
             AND run_events.message = 'Runner request captured'
             AND json_valid(run_events.payload_json)
         );",
    )
    .map_err(|err| CommandError::database("agent run runner 메타를 백필하지 못했습니다.", err))?;
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

fn table_exists(conn: &Connection, table_name: &str) -> CommandResult<bool> {
    let exists: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
            params![table_name],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| CommandError::database("Helm 데이터베이스를 확인하지 못했습니다.", err))?;
    Ok(exists.is_some())
}

fn table_has_column(conn: &Connection, table_name: &str, column_name: &str) -> CommandResult<bool> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table_name})"))
        .map_err(|err| CommandError::database("Helm 데이터베이스를 확인하지 못했습니다.", err))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|err| CommandError::database("Helm 데이터베이스를 확인하지 못했습니다.", err))?;
    for row in rows {
        if row.map_err(|err| {
            CommandError::database("Helm 데이터베이스를 확인하지 못했습니다.", err)
        })? == column_name
        {
            return Ok(true);
        }
    }
    Ok(false)
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
        role_policies: settings
            .remove("rolePolicies")
            .unwrap_or_else(default_role_policies),
        conductor_config: settings.remove("conductorConfig"),
        worktree_root: settings
            .remove("worktreeRoot")
            .and_then(|value| value.as_str().map(str::to_string)),
        worktree_setup: settings
            .remove("worktreeSetup")
            .filter(|value| !value.is_null()),
        jira_config: settings.remove("jiraConfig"),
        obsidian_vault_path: settings
            .remove("obsidianVaultPath")
            .and_then(|value| {
                value
                    .as_str()
                    .map(str::trim)
                    .filter(|path| !path.is_empty())
                    .map(str::to_string)
            })
            .or_else(default_obsidian_vault_path),
        obsidian_artifact_path: settings.remove("obsidianArtifactPath").and_then(|value| {
            value
                .as_str()
                .map(str::trim)
                .filter(|path| !path.is_empty())
                .map(str::to_string)
        }),
        token_budget: settings
            .remove("tokenBudget")
            .and_then(|value| value.as_i64()),
        artifact_retention_days: settings
            .remove("artifactRetentionDays")
            .and_then(|value| value.as_i64())
            .or(Some(30)),
    })
}

fn default_obsidian_vault_path() -> Option<String> {
    #[cfg(test)]
    {
        return None;
    }
    #[cfg(not(test))]
    {
        let home = env::var("HOME").ok()?;
        let path = Path::new(&home)
            .join("Documents")
            .join("Obsidian Vault")
            .join("Claude");
        path.is_dir().then(|| path.to_string_lossy().to_string())
    }
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
    if let Some(value) = patch.role_policies {
        values.push(("rolePolicies", normalize_role_policies(value)));
    }
    if let Some(value) = patch.conductor_config {
        values.push(("conductorConfig", value.unwrap_or(Value::Null)));
    }
    if let Some(value) = patch.worktree_root {
        values.push(("worktreeRoot", option_string(value)));
    }
    if let Some(value) = patch.worktree_setup {
        if let Some(config) = value.as_ref() {
            validate_worktree_setup_config(config)?;
        }
        values.push(("worktreeSetup", value.unwrap_or(Value::Null)));
    }
    if let Some(value) = patch.jira_config {
        values.push(("jiraConfig", value.unwrap_or(Value::Null)));
    }
    if let Some(value) = patch.obsidian_vault_path {
        values.push(("obsidianVaultPath", option_string(value)));
    }
    if let Some(value) = patch.obsidian_artifact_path {
        values.push(("obsidianArtifactPath", option_string(value)));
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
    let worktree_mode = match input.worktree_mode.as_deref() {
        None | Some("current_branch") => "current_branch",
        Some("worktree") => "worktree",
        Some(_) => return Err(CommandError::validation("알 수 없는 worktree 모드입니다.")),
    };

    let id = new_id();
    let timestamp = now();
    let sort_order = next_task_sort_order(conn, project_id)?;
    let tx = conn
        .transaction()
        .map_err(|err| CommandError::database("태스크를 저장하지 못했습니다.", err))?;
    tx.execute(
        "INSERT INTO tasks (
           id, project_id, epic_id, title, description, status, sort_order,
           worktree_mode, created_at, updated_at, last_transition_at
         )
         VALUES (?1, ?2, ?3, ?4, ?5, 'Planned', ?6, ?7, ?8, ?8, ?8)",
        params![
            id,
            project_id,
            input.epic_id,
            title,
            description,
            sort_order,
            worktree_mode,
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

pub fn append_task_instruction(
    conn: &mut Connection,
    project_id: &str,
    task_id: &str,
    message: &str,
) -> CommandResult<TaskSummary> {
    let task = get_task(conn, task_id)?;
    if task.project_id != project_id {
        return Err(CommandError::validation("대상 태스크를 찾을 수 없습니다."));
    }
    let instruction = required_text(message, "후속 지시를 입력해주세요.")?;
    let timestamp = now();
    let tx = conn
        .transaction()
        .map_err(|err| CommandError::database("후속 지시를 저장하지 못했습니다.", err))?;
    tx.execute(
        "INSERT INTO task_external_refs (id, project_id, task_id, ref_type, ref_value, ref_title, created_at)
         VALUES (?1, ?2, ?3, 'PlainText', ?4, ?5, ?6)",
        params![
            new_id(),
            project_id,
            task_id,
            instruction.as_str(),
            "후속 사용자 지시",
            timestamp
        ],
    )
    .map_err(|err| CommandError::database("후속 지시를 저장하지 못했습니다.", err))?;
    tx.execute(
        "UPDATE tasks SET updated_at = ?1 WHERE id = ?2 AND project_id = ?3",
        params![timestamp, task_id, project_id],
    )
    .map_err(|err| CommandError::database("태스크 갱신 시간을 저장하지 못했습니다.", err))?;
    insert_audit(
        &tx,
        project_id,
        "Task",
        Some(task_id),
        "task.instruction.appended",
        json!({ "message": instruction }),
    )?;
    tx.commit()
        .map_err(|err| CommandError::database("후속 지시를 저장하지 못했습니다.", err))?;
    get_task(conn, task_id)
}

pub fn create_planning_session(
    conn: &mut Connection,
    project_id: &str,
    input: CreatePlanningSessionInput,
) -> CommandResult<PlanningSessionDetail> {
    get_project(conn, project_id)?;
    let goal_text = required_text(&input.goal_text, "계획 목표를 입력해주세요.")?;
    let title = input
        .title
        .as_deref()
        .map(|value| required_text(value, "계획 제목을 입력해주세요."))
        .transpose()?
        .unwrap_or_else(|| planning_title_from_goal(&goal_text));
    let jira_ref = input
        .jira_ref
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let jira_state = input.jira_state.unwrap_or_else(|| {
        if jira_ref.is_some() {
            "Linked".to_string()
        } else {
            "Missing".to_string()
        }
    });
    validate_planning_jira_state(&jira_state)?;

    let id = new_id();
    let timestamp = now();
    let tx = conn
        .transaction()
        .map_err(|err| CommandError::database("계획 세션을 저장하지 못했습니다.", err))?;
    tx.execute(
        "INSERT INTO planning_sessions (
           id, project_id, title, goal_text, status, jira_ref, jira_state,
           created_at, updated_at
         )
         VALUES (?1, ?2, ?3, ?4, 'Drafting', ?5, ?6, ?7, ?7)",
        params![id, project_id, title, goal_text, jira_ref, jira_state, timestamp],
    )
    .map_err(|err| CommandError::database("계획 세션을 저장하지 못했습니다.", err))?;
    tx.execute(
        "INSERT INTO planning_messages (
           id, project_id, session_id, role, content, created_at
         )
         VALUES (?1, ?2, ?3, 'user', ?4, ?5)",
        params![new_id(), project_id, id, goal_text, timestamp],
    )
    .map_err(|err| CommandError::database("계획 메시지를 저장하지 못했습니다.", err))?;
    insert_audit(
        &tx,
        project_id,
        "PlanningSession",
        Some(&id),
        "planning_session.created",
        json!({ "sessionId": id, "title": title }),
    )?;
    tx.commit()
        .map_err(|err| CommandError::database("계획 세션을 저장하지 못했습니다.", err))?;

    get_planning_session(conn, project_id, &id)
}

pub fn list_planning_sessions(
    conn: &Connection,
    project_id: &str,
) -> CommandResult<Vec<PlanningSessionSummary>> {
    get_project(conn, project_id)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, project_id, title, goal_text, status, jira_ref, jira_state,
                    current_draft_id, created_at, updated_at
             FROM planning_sessions
             WHERE project_id = ?1
             ORDER BY updated_at DESC, created_at DESC",
        )
        .map_err(|err| CommandError::database("계획 세션 목록을 읽지 못했습니다.", err))?;
    let rows = stmt
        .query_map(params![project_id], planning_session_row)
        .map_err(|err| CommandError::database("계획 세션 목록을 읽지 못했습니다.", err))?;

    let mut sessions = Vec::new();
    for row in rows {
        let row =
            row.map_err(|err| CommandError::database("계획 세션 목록을 읽지 못했습니다.", err))?;
        sessions.push(hydrate_planning_session_summary(conn, row)?);
    }
    Ok(sessions)
}

pub fn get_planning_session(
    conn: &Connection,
    project_id: &str,
    session_id: &str,
) -> CommandResult<PlanningSessionDetail> {
    let row = conn
        .query_row(
            "SELECT id, project_id, title, goal_text, status, jira_ref, jira_state,
                    current_draft_id, created_at, updated_at
             FROM planning_sessions
             WHERE id = ?1 AND project_id = ?2",
            params![session_id, project_id],
            planning_session_row,
        )
        .map_err(|err| {
            CommandError::with_details(
                "ValidationFailed",
                "대상 계획 세션을 찾을 수 없습니다.",
                err,
            )
        })?;
    let session = hydrate_planning_session_summary(conn, row)?;
    let messages = list_planning_messages(conn, project_id, session_id)?;
    Ok(PlanningSessionDetail { session, messages })
}

pub fn save_plan_draft_revision(
    conn: &mut Connection,
    root: &Path,
    project_id: &str,
    session_id: &str,
    input: SavePlanDraftRevisionInput,
) -> CommandResult<PlanningSessionDetail> {
    let session = get_planning_session(conn, project_id, session_id)?.session;
    if session.status == "Approved" {
        return Err(CommandError::validation(
            "이미 승인된 계획 세션은 draft를 갱신할 수 없습니다.",
        ));
    }

    let validation = validate_plan_draft_json(&input.draft_json)?;
    let title = required_text(
        plan_string_field(&input.draft_json, &["title"])
            .as_deref()
            .unwrap_or(""),
        "Plan Document title이 필요합니다.",
    )?;
    let summary = required_text(
        plan_string_field(&input.draft_json, &["summary"])
            .as_deref()
            .unwrap_or(""),
        "Plan Document summary가 필요합니다.",
    )?;
    let revision = next_plan_draft_revision(conn, session_id)?;
    let id = new_id();
    let timestamp = now();
    let plan_markdown = input
        .plan_markdown
        .unwrap_or_else(|| plan_markdown_from_draft_json(&input.draft_json, &session.goal_text));
    let artifact_path = planning_draft_artifact_path(session_id, revision);
    let content_hash = stable_content_hash(&plan_markdown);
    let obsidian_artifact_path = write_obsidian_plan_artifact(
        conn,
        project_id,
        session_id,
        revision,
        &title,
        &timestamp,
        &artifact_path,
        &content_hash,
        &plan_markdown,
    )?;
    let draft_json = serde_json::to_string(&input.draft_json).map_err(|err| {
        CommandError::with_details(
            "ValidationFailed",
            "Plan Document JSON을 저장할 수 없습니다.",
            err,
        )
    })?;
    let validation_json = validation.validation.to_string();
    let planner_message = input
        .planner_message
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    write_planning_artifact(root, &artifact_path, &plan_markdown)?;

    let tx = conn.transaction().map_err(|err| {
        CommandError::database("Plan Document revision을 저장하지 못했습니다.", err)
    })?;
    tx.execute(
        "UPDATE planning_approvals
         SET status = 'Rejected',
             decision_reason = 'Superseded by newer Plan Document revision',
             decided_at = ?1,
             updated_at = ?1
         WHERE project_id = ?2 AND session_id = ?3 AND status = 'Pending'",
        params![timestamp, project_id, session_id],
    )
    .map_err(|err| CommandError::database("이전 계획 승인 요청을 정리하지 못했습니다.", err))?;
    tx.execute(
        "INSERT INTO plan_draft_revisions (
           id, project_id, session_id, revision, title, summary, plan_markdown,
           artifact_path, content_hash, draft_json, validation_json, task_count,
           task_graph_count, barrier_count, verification_gate_count, created_at
         )
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
        params![
            id,
            project_id,
            session_id,
            revision,
            title,
            summary,
            plan_markdown,
            artifact_path,
            content_hash,
            draft_json,
            validation_json,
            validation.task_count,
            validation.task_graph_count,
            validation.barrier_count,
            validation.verification_gate_count,
            timestamp
        ],
    )
    .map_err(|err| CommandError::database("Plan Document revision을 저장하지 못했습니다.", err))?;
    tx.execute(
        "INSERT INTO planning_approvals (
           id, project_id, session_id, draft_id, status, requested_reason,
           decision_reason, requested_at, decided_at, created_at, updated_at
         )
         VALUES (?1, ?2, ?3, ?4, 'Pending', ?5, NULL, ?6, NULL, ?6, ?6)",
        params![
            new_id(),
            project_id,
            session_id,
            id,
            format!("Plan Document revision {revision} ready for approval"),
            timestamp
        ],
    )
    .map_err(|err| CommandError::database("계획 승인 요청을 저장하지 못했습니다.", err))?;
    tx.execute(
        "UPDATE planning_sessions
         SET title = ?1,
             status = 'ReadyForApproval',
             current_draft_id = ?2,
             updated_at = ?3
         WHERE id = ?4 AND project_id = ?5",
        params![title, id, timestamp, session_id, project_id],
    )
    .map_err(|err| CommandError::database("계획 세션을 갱신하지 못했습니다.", err))?;
    if let Some(message) = planner_message {
        tx.execute(
            "INSERT INTO planning_messages (
               id, project_id, session_id, role, content, draft_revision_id, created_at
             )
             VALUES (?1, ?2, ?3, 'planner', ?4, ?5, ?6)",
            params![new_id(), project_id, session_id, message, id, timestamp],
        )
        .map_err(|err| CommandError::database("계획 메시지를 저장하지 못했습니다.", err))?;
    }
    insert_audit(
        &tx,
        project_id,
        "PlanDraftRevision",
        Some(&id),
        "plan_draft_revision.saved",
        json!({
            "sessionId": session_id,
            "draftId": id,
            "revision": revision,
            "taskCount": validation.task_count,
            "taskGraphCount": validation.task_graph_count,
            "barrierCount": validation.barrier_count,
            "verificationGateCount": validation.verification_gate_count,
            "obsidianArtifactPath": obsidian_artifact_path
        }),
    )?;
    tx.commit().map_err(|err| {
        CommandError::database("Plan Document revision을 저장하지 못했습니다.", err)
    })?;

    get_planning_session(conn, project_id, session_id)
}

pub fn approve_plan_draft(
    conn: &mut Connection,
    project_id: &str,
    draft_id: &str,
    input: DecidePlanDraftInput,
) -> CommandResult<PlanningSessionDetail> {
    decide_plan_draft(conn, project_id, draft_id, input, "Approved")
}

pub fn reject_plan_draft(
    conn: &mut Connection,
    project_id: &str,
    draft_id: &str,
    input: DecidePlanDraftInput,
) -> CommandResult<PlanningSessionDetail> {
    decide_plan_draft(conn, project_id, draft_id, input, "Rejected")
}

pub fn materialize_plan_draft(
    conn: &mut Connection,
    project_id: &str,
    draft_id: &str,
) -> CommandResult<PlanningMaterializationSummary> {
    if let Some(existing) = get_materialization_by_draft(conn, project_id, draft_id)? {
        ensure_materialization_tasks_exist(conn, &existing)?;
        return Ok(existing);
    }

    let draft = get_plan_draft_revision(conn, draft_id)?;
    if draft.project_id != project_id {
        return Err(CommandError::validation(
            "대상 Plan Document를 찾을 수 없습니다.",
        ));
    }
    validate_plan_draft_json(&draft.draft_json)?;
    ensure_plan_draft_approved(conn, project_id, draft_id)?;
    let session = get_planning_session(conn, project_id, &draft.session_id)?.session;
    let draft_tasks = plan_draft_task_values(&draft.draft_json);
    if draft_tasks.is_empty() {
        return Err(CommandError::validation(
            "Plan Document에 materialize할 Task가 없습니다.",
        ));
    }

    let materialization_id = new_id();
    let timestamp = now();
    let mut created_task_ids = Vec::new();
    let base_sort_order = next_task_sort_order(conn, project_id)?;
    let tx = conn.transaction().map_err(|err| {
        CommandError::database("Plan Document를 Task로 변환하지 못했습니다.", err)
    })?;
    tx.execute(
        "INSERT INTO planning_materializations (
           id, project_id, session_id, draft_id, status, task_ids_json, created_at, updated_at
         )
         VALUES (?1, ?2, ?3, ?4, 'Succeeded', '[]', ?5, ?5)",
        params![
            materialization_id,
            project_id,
            draft.session_id,
            draft_id,
            timestamp
        ],
    )
    .map_err(|err| CommandError::database("계획 materialization을 저장하지 못했습니다.", err))?;

    for (index, draft_task) in draft_tasks.iter().enumerate() {
        let title = required_text(
            plan_string_field(draft_task, &["title"])
                .as_deref()
                .unwrap_or(""),
            "Plan task title이 필요합니다.",
        )?;
        let task_id = new_id();
        let description = task_description_from_plan_draft(&session, &draft, draft_task);
        tx.execute(
            "INSERT INTO tasks (
               id, project_id, title, description, status, sort_order,
               created_at, updated_at, last_transition_at
             )
             VALUES (?1, ?2, ?3, ?4, 'Ready', ?5, ?6, ?6, ?6)",
            params![
                task_id,
                project_id,
                title,
                description,
                base_sort_order + index as i64,
                timestamp
            ],
        )
        .map_err(|err| CommandError::database("계획 Task를 저장하지 못했습니다.", err))?;
        tx.execute(
            "INSERT INTO approvals (
               id, project_id, entity_type, entity_id, approval_type, status,
               requested_reason, decision_reason, requested_at, decided_at, created_at, updated_at
             )
             VALUES (?1, ?2, 'Task', ?3, 'PlanApproval', 'Approved', ?4, ?5, ?6, ?6, ?6, ?6)",
            params![
                new_id(),
                project_id,
                task_id,
                "Approved Plan Document materialized this Task",
                "Plan Document approval covers generated Task",
                timestamp
            ],
        )
        .map_err(|err| CommandError::database("계획 Task 승인 기록을 저장하지 못했습니다.", err))?;
        insert_planning_task_refs(&tx, project_id, &task_id, &session, &draft, draft_task)?;
        tx.execute(
            "INSERT INTO planning_materialization_items (
               id, project_id, materialization_id, draft_id, task_id, draft_task_key,
               sort_order, created_at
             )
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                new_id(),
                project_id,
                materialization_id,
                draft_id,
                task_id,
                plan_string_field(draft_task, &["id", "taskId", "task_id"]),
                index as i64,
                timestamp
            ],
        )
        .map_err(|err| {
            CommandError::database("계획 materialization 항목을 저장하지 못했습니다.", err)
        })?;
        created_task_ids.push(task_id);
    }

    let task_ids_json = serde_json::to_string(&created_task_ids).map_err(|err| {
        CommandError::with_details(
            "ValidationFailed",
            "생성된 Task 목록을 저장할 수 없습니다.",
            err,
        )
    })?;
    tx.execute(
        "UPDATE planning_materializations
         SET task_ids_json = ?1, updated_at = ?2
         WHERE id = ?3 AND project_id = ?4",
        params![task_ids_json, timestamp, materialization_id, project_id],
    )
    .map_err(|err| CommandError::database("계획 materialization을 저장하지 못했습니다.", err))?;
    tx.execute(
        "UPDATE planning_sessions
         SET status = 'Approved', current_draft_id = ?1, updated_at = ?2
         WHERE id = ?3 AND project_id = ?4",
        params![draft_id, timestamp, draft.session_id, project_id],
    )
    .map_err(|err| CommandError::database("계획 세션 승인 상태를 저장하지 못했습니다.", err))?;
    insert_audit(
        &tx,
        project_id,
        "PlanningMaterialization",
        Some(&materialization_id),
        "planning_materialization.succeeded",
        json!({
            "sessionId": draft.session_id,
            "draftId": draft_id,
            "taskIds": created_task_ids
        }),
    )?;
    tx.commit().map_err(|err| {
        CommandError::database("Plan Document를 Task로 변환하지 못했습니다.", err)
    })?;

    get_materialization(conn, project_id, &materialization_id)
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

pub fn delete_task(conn: &mut Connection, project_id: &str, task_id: &str) -> CommandResult<()> {
    let task = get_task(conn, task_id)?;
    if task.project_id != project_id {
        return Err(CommandError::validation(
            "해당 프로젝트의 태스크가 아닙니다.",
        ));
    }

    let active_run_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM agent_runs
             WHERE project_id = ?1 AND task_id = ?2 AND status IN ('Queued', 'Running')",
            params![project_id, task_id],
            |row| row.get(0),
        )
        .map_err(|err| CommandError::database("태스크 실행 상태를 확인하지 못했습니다.", err))?;

    if active_run_count > 0 {
        return Err(CommandError::validation(
            "실행 중인 작업자가 있는 태스크는 삭제할 수 없습니다.",
        ));
    }

    let tx = conn
        .transaction()
        .map_err(|err| CommandError::database("태스크를 삭제하지 못했습니다.", err))?;
    tx.execute(
        "DELETE FROM approvals
         WHERE project_id = ?1
           AND ((entity_type = 'Task' AND entity_id = ?2)
             OR (entity_type = 'AgentRun' AND entity_id IN (
               SELECT id FROM agent_runs WHERE project_id = ?1 AND task_id = ?2
             )))",
        params![project_id, task_id],
    )
    .map_err(|err| CommandError::database("태스크 승인 기록을 삭제하지 못했습니다.", err))?;
    tx.execute(
        "DELETE FROM audit_logs
         WHERE project_id = ?1
           AND ((entity_type = 'Task' AND entity_id = ?2)
             OR (entity_type = 'AgentRun' AND entity_id IN (
               SELECT id FROM agent_runs WHERE project_id = ?1 AND task_id = ?2
             )))",
        params![project_id, task_id],
    )
    .map_err(|err| CommandError::database("태스크 감사 기록을 삭제하지 못했습니다.", err))?;
    // conversation_messages.source_run_id는 FK가 아니라 일반 TEXT라 task cascade로 지워지지
    // 않는다. agent_runs가 cascade로 사라지기 전에, 이 task run에 묶인 채팅 요약을 먼저 지운다.
    tx.execute(
        "DELETE FROM conversation_messages
         WHERE project_id = ?1
           AND source_run_id IN (
             SELECT id FROM agent_runs WHERE project_id = ?1 AND task_id = ?2
           )",
        params![project_id, task_id],
    )
    .map_err(|err| CommandError::database("태스크 대화 메시지를 삭제하지 못했습니다.", err))?;
    let affected = tx
        .execute(
            "DELETE FROM tasks WHERE project_id = ?1 AND id = ?2",
            params![project_id, task_id],
        )
        .map_err(|err| CommandError::database("태스크를 삭제하지 못했습니다.", err))?;

    if affected == 0 {
        return Err(CommandError::validation(
            "삭제할 태스크를 찾을 수 없습니다.",
        ));
    }

    tx.commit()
        .map_err(|err| CommandError::database("태스크 삭제를 저장하지 못했습니다.", err))
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

    // current_branch 모드는 새 worktree를 만들지 않고 프로젝트 root(현재 브랜치)에서 in-place 작업한다.
    if task_worktree_mode(conn, task_id)? == "current_branch" {
        return register_inplace_worktree(conn, root, project_id, &task);
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
    // 이전 시도가 남긴 stale worktree admin 엔트리를 먼저 정리한다(없으면 no-op).
    git::prune_worktrees(root);
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
    // worktree add는 브랜치 생성+체크아웃+admin 등록의 비원자적 조합이라, 중간에 실패하면
    // 브랜치 ref만 남아 다음 시도(unique_task_branch)와 정리를 막는다 — 실패 시 직접 롤백한다.
    if let Err(err) = git::add_worktree(root, &worktree_path, &branch_name, &base_ref) {
        let _ = git::remove_worktree(root, &worktree_path);
        git::prune_worktrees(root);
        let _ = git::delete_branch(root, &branch_name, false);
        return Err(err);
    }
    // 훅(git-lfs/husky)이 막 만든 baseline untracked 노이즈를 exclude에 등록 — coder diff
    // 게이트 오판과 merge 커밋 오염을 원천 차단한다.
    git::exclude_baseline_untracked(&worktree_path);

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
    write_role_dossier(
        &artifact_abs_dir,
        role_id,
        &stub_role_dossier(role_id, task_id),
    )?;

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
           lifecycle_phase, claimed_at, heartbeat_at, attempt, created_at, updated_at
         )
         VALUES (?1, ?2, ?3, ?4, 'Succeeded', ?5, ?6, ?7, ?8, ?9, 0, ?10, ?11, ?11,
                 'completed', ?11, ?11, 1, ?11, ?11)",
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
    append_run_event(
        &tx,
        project_id,
        task_id,
        &run_id,
        "status",
        "Succeeded",
        json!({
            "status": "Succeeded",
            "roleId": role_id,
            "runner": "StubRunner",
            "exitCode": 0,
            "resultStatus": result_status
        }),
    )?;
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
        append_run_event(
            &tx,
            project_id,
            task_id,
            &run_id,
            "approval",
            "PlanApproval Pending",
            json!({
                "approvalId": approval_id,
                "approvalType": "PlanApproval",
                "status": "Pending"
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
    let settings = effective_settings(conn, project_id)?;
    // 멀티 리뷰어 role이면 아직 실행되지 않은 다음 connection을 run에 고정(pin)한다.
    let pinned_connection_id =
        pick_pending_role_connection(conn, project_id, task_id, role_id, &settings)?;
    let worktree_setup = resolve_worktree_setup_config(root, settings.worktree_setup.as_ref())?;
    let role_policy = resolve_role_policy(root, &settings.role_policies, role_id);

    let run_id = new_id();
    let timestamp = now();
    let artifact_dir = format!(".helm/artifacts/runs/{run_id}");
    validate_relative_artifact_path(&artifact_dir)?;
    let artifact_path = root.join(&artifact_dir);
    fs::create_dir_all(&artifact_path)
        .map_err(|err| CommandError::io("실행 산출물 폴더를 만들지 못했습니다.", err))?;

    // epic 게이트(계획 검토/코드 리뷰)는 한 task가 아니라 epic 전체를 검토한다. 약한 검증
    // 모델이 상단 ## Description(단일 task)에 앵커링해 형제 변경을 오탐하지 않도록, 게이트
    // run에서는 Description 자체를 epic 전체 계획의 합집합으로 교체한다.
    let context_task = epic_gate_context_task(conn, project_id, &task, role_id)?;
    let mut context_pack = build_context_pack_markdown(
        root,
        &context_task,
        &worktree,
        role_id,
        worktree_setup.as_ref(),
        Some(&role_policy),
    )?;
    context_pack.push_str(&build_upstream_dossiers_markdown(
        conn, root, project_id, task_id, role_id,
    ));
    let context_manifest = build_context_manifest(
        root,
        &task,
        &worktree,
        role_id,
        worktree_setup.as_ref(),
        Some(&role_policy),
    )?;
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
    if let Some(setup) = worktree_setup.as_ref() {
        fs::write(
            artifact_path.join("worktree-setup.json"),
            serde_json::to_string_pretty(setup).map_err(|err| {
                CommandError::io("worktree setup config를 만들지 못했습니다.", err)
            })?,
        )
        .map_err(|err| CommandError::io("worktree setup config를 저장하지 못했습니다.", err))?;
    }
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
    write_role_dossier(
        &artifact_path,
        role_id,
        &queued_role_dossier(role_id, "Host Run Queued"),
    )?;
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
    let inserted = tx
        .execute(
            "INSERT INTO agent_runs (
           id, project_id, task_id, role_id, status, artifact_dir, summary_path, result_path,
           stdout_log_path, stderr_log_path, exit_code, result_status, started_at, finished_at,
           lifecycle_phase, attempt, created_at, updated_at, connection_id
         )
         SELECT ?1, ?2, ?3, ?4, 'Queued', ?5, ?6, ?7, ?8, ?9, NULL, NULL, NULL, NULL,
                'queued', 1, ?10, ?10, ?11
          WHERE NOT EXISTS (
            SELECT 1 FROM agent_runs
             WHERE project_id = ?2
               AND task_id = ?3
               AND status IN ('Queued', 'Running')
          )",
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
                timestamp,
                pinned_connection_id
            ],
        )
        .map_err(|err| CommandError::database("실행 컨텍스트를 저장하지 못했습니다.", err))?;
    if inserted == 0 {
        return Err(CommandError::validation(
            "이미 준비 중이거나 실행 중인 role run이 있습니다.",
        ));
    }
    append_run_event(
        &tx,
        project_id,
        task_id,
        &run_id,
        "status",
        "Queued",
        json!({
            "status": "Queued",
            "roleId": role_id,
            "artifactDir": artifact_dir,
            "worktreePath": worktree.worktree_path.clone()
        }),
    )?;
    append_run_event(
        &tx,
        project_id,
        task_id,
        &run_id,
        "artifact",
        "Context Pack created",
        json!({
            "path": format!("{artifact_dir}/context-pack.md"),
            "artifact": "context-pack.md",
            "roleId": role_id,
            "reads": [
                "Task description",
                "Task external refs",
                "Git changed files",
                "Recent commits",
                "Role contract",
                "Role policy",
                "Worktree setup config"
            ]
        }),
    )?;
    append_run_event(
        &tx,
        project_id,
        task_id,
        &run_id,
        "artifact",
        "Summary and structured result placeholders created",
        json!({
            "summaryPath": format!("{artifact_dir}/summary.md"),
            "resultPath": format!("{artifact_dir}/structured-result.json"),
            "schemaPath": format!("{artifact_dir}/structured-result.schema.json"),
            "dossierPath": format!("{artifact_dir}/{}", role_dossier_artifact_name(role_id))
        }),
    )?;
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
    // epic 게이트(계획 검토/코드 리뷰)는 anchor task에서 형제가 모두 끝난 뒤 1회만 실행한다.
    // 미충족이면 ValidationFailed로 돌려 auto-handoff가 조용히 건너뛰고, supervisor reconcile이
    // 배리어가 충족되는 시점에 anchor를 집어 게이트를 띄운다.
    if !epic_gate_ready(conn, project_id, &task, role_id)? {
        return Err(CommandError::validation(
            "epic 게이트 대기: 형제 task가 모두 끝난 뒤 anchor task에서 실행됩니다.",
        ));
    }
    ensure_task_worktree(conn, root, project_id, task_id)?;
    prepare_role_context(conn, root, project_id, task_id, role_id)
}

pub fn reconcile_next_role_gap(
    conn: &mut Connection,
    root: &Path,
    project_id: &str,
) -> CommandResult<Option<AgentRunSummary>> {
    for task in list_tasks(conn, project_id)? {
        if !matches!(
            task.status.as_str(),
            "Ready" | "PlanVerification" | "CodeReview" | "Testing"
        ) {
            continue;
        }
        let Some(role_id) = next_role_for_task_status(&task.status) else {
            continue;
        };
        // epic 게이트는 anchor에서 형제가 모두 끝난 뒤에만 띄운다. anchor가 아니거나
        // 배리어 미충족이면 건너뛰고 계속 스캔해 anchor를 찾는다.
        if !epic_gate_ready(conn, project_id, &task, role_id)? {
            continue;
        }
        // 리뷰 진행 승인 전에는 코드 리뷰어를 자동 큐잉하지 않는다(승인 게이트).
        if role_id == "code_reviewer"
            && !has_review_approval(conn, project_id, &task.id, "Approved")?
        {
            continue;
        }
        if has_active_run(conn, project_id, &task.id)? {
            continue;
        }
        if has_role_run(conn, project_id, &task.id, role_id)? {
            continue;
        }
        return prepare_next_role_context(conn, root, project_id, &task.id).map(Some);
    }
    Ok(None)
}

pub fn claim_host_run(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    runner_payload: Value,
    event_sink: &mut Option<&mut dyn FnMut(&RunEventSummary)>,
) -> CommandResult<AgentRunSummary> {
    let run = get_agent_run(conn, run_id)?;
    if run.project_id != project_id {
        return Err(CommandError::validation(
            "대상 실행 기록을 찾을 수 없습니다.",
        ));
    }
    if run.status != "Queued" {
        return Err(CommandError::new(
            "RunAlreadyClaimed",
            "Queued run이 이미 다른 worker에 의해 claim되었습니다.",
        ));
    }

    let started_at = now();
    let (provider, connection_id, model) = runner_payload_metadata(&runner_payload);
    let changed = conn
        .execute(
            "UPDATE agent_runs
             SET status = 'Running',
                 lifecycle_phase = 'running',
                 provider = ?2,
                 connection_id = ?3,
                 model = ?4,
                 started_at = COALESCE(started_at, ?1),
                 claimed_at = COALESCE(claimed_at, ?1),
                 heartbeat_at = ?1,
                 updated_at = ?1
             WHERE id = ?5 AND project_id = ?6 AND status = 'Queued'",
            params![
                started_at,
                provider,
                connection_id,
                model,
                run_id,
                project_id
            ],
        )
        .map_err(|err| CommandError::database("host run claim을 저장하지 못했습니다.", err))?;
    if changed == 0 {
        return Err(CommandError::new(
            "RunAlreadyClaimed",
            "Queued run이 이미 다른 worker에 의해 claim되었습니다.",
        ));
    }

    insert_audit(
        conn,
        project_id,
        "AgentRun",
        Some(run_id),
        "agent_run.claimed",
        json!({
            "runId": run_id,
            "taskId": run.task_id,
            "roleId": run.role_id,
            "runner": runner_payload.clone()
        }),
    )?;
    if run.role_id == "coder" {
        let task = get_task(conn, &run.task_id)?;
        if task.status == "Ready" {
            conn.execute(
                "UPDATE tasks
                 SET status = 'Coding', status_reason = ?1, updated_at = ?2, last_transition_at = ?2
                 WHERE id = ?3 AND project_id = ?4",
                params!["구현자 실행 중", started_at, task.id, project_id],
            )
            .map_err(|err| {
                CommandError::database("태스크 실행 상태를 저장하지 못했습니다.", err)
            })?;
            insert_audit(
                conn,
                project_id,
                "Task",
                Some(&task.id),
                "task.status_changed",
                json!({
                    "taskId": task.id,
                    "from": task.status,
                    "to": "Coding",
                    "runId": run_id,
                    "reason": "coder host run claimed",
                    "source": "host_runner"
                }),
            )?;
        }
    }
    append_and_emit_run_event(
        conn,
        project_id,
        &run.task_id,
        run_id,
        "status",
        "Running",
        json!({
            "status": "Running",
            "roleId": run.role_id,
            "claim": "app-worker",
            "runner": runner_payload
        }),
        event_sink,
    )?;

    get_agent_run(conn, run_id)
}

fn runner_payload_metadata(payload: &Value) -> (Option<String>, Option<String>, Option<String>) {
    (
        string_payload_field(payload, "provider"),
        string_payload_field(payload, "connectionId")
            .or_else(|| string_payload_field(payload, "connection_id")),
        string_payload_field(payload, "model"),
    )
}

fn string_payload_field(payload: &Value, key: &str) -> Option<String> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

pub fn run_host_role(
    conn: &mut Connection,
    root: &Path,
    project_id: &str,
    run_id: &str,
    cancellation: Arc<AtomicBool>,
    mut event_sink: Option<&mut dyn FnMut(&RunEventSummary)>,
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
    if run.repair_request_id.is_some() {
        validate_repair_run_state(conn, project_id, &run)?;
    } else {
        validate_role_run_state(conn, project_id, &task, &run.role_id)?;
    }
    let worktree = get_task_worktree(conn, project_id, &run.task_id)?.ok_or_else(|| {
        CommandError::validation("host run 실행 전에 태스크 worktree를 먼저 준비해주세요.")
    })?;
    let settings = effective_settings(conn, project_id)?;
    let placeholders = host_runner_placeholders(root, &worktree, &run);
    let runner_command = resolve_host_runner_command(
        &settings,
        &run.role_id,
        run.connection_id.as_deref(),
        &placeholders,
    )?;
    let command_args =
        resolve_command_args(Path::new(&worktree.worktree_path), &runner_command.args);
    let timeout_seconds = runner_command.timeout_seconds;
    if command_args.is_empty() {
        return Err(CommandError::validation(
            "role preset에 실행 command가 설정되어 있지 않습니다.",
        ));
    }

    let run = claim_host_run(
        conn,
        project_id,
        run_id,
        json!({
            "runner": "HelmHostRunner",
            "provider": runner_command.provider.clone(),
            "connectionId": runner_command.connection_id.clone(),
            "model": runner_command.model.clone(),
            "adapter": runner_adapter_label(runner_command.runner_adapter)
        }),
        &mut event_sink,
    )?;

    let artifact_path = root.join(&run.artifact_dir);
    write_runner_request(
        &artifact_path,
        &worktree.worktree_path,
        &command_args,
        &runner_command,
    )?;
    append_and_emit_run_event(
        conn,
        project_id,
        &run.task_id,
        run_id,
        "system",
        "Runner request captured",
        json!({
            "runner": "HelmHostRunner",
            "provider": runner_command.provider.clone(),
            "connectionId": runner_command.connection_id.clone(),
            "model": runner_command.model.clone(),
            "adapter": runner_adapter_label(runner_command.runner_adapter),
            "worktreePath": worktree.worktree_path.clone(),
            "artifactDir": run.artifact_dir.clone(),
            "path": format!("{}/runner-request.json", run.artifact_dir),
            "envKeys": runner_command.env.iter().map(|(key, _)| key).collect::<Vec<_>>(),
            "reads": [
                "context-pack.md",
                "context-pack.json",
                "structured-result.schema.json",
                "worktree git state"
            ]
        }),
        &mut event_sink,
    )?;
    let command_started_at = now();
    let command_started_instant = Instant::now();
    let command_output = match runner_command.runner_adapter {
        RunnerAdapterKind::Process => {
            let mut command = Command::new(&command_args[0]);
            command
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
                    "HELM_ROLE_DOSSIER_PATH",
                    artifact_path
                        .join(role_dossier_artifact_name(&run.role_id))
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
                .env(
                    "HELM_MODEL",
                    runner_command.model.clone().unwrap_or_default(),
                )
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
                );
            apply_connection_env(&mut command, &runner_command.env);
            let child = spawn_detached_host_child(&mut command, &artifact_path)?;
            let host_pid = child.id();
            // 재시작 후 재연결을 위해 PID를 즉시 저장한다(wait 진입 전).
            conn.execute(
                "UPDATE agent_runs SET host_pid = ?1, updated_at = ?2 WHERE id = ?3",
                params![host_pid, now(), run_id],
            )
            .map_err(|err| CommandError::database("host run PID를 저장하지 못했습니다.", err))?;
            append_and_emit_run_event(
                conn,
                project_id,
                &run.task_id,
                run_id,
                "system",
                "Host child detached",
                json!({ "pid": host_pid }),
                &mut event_sink,
            )?;
            wait_host_child(
                child,
                &artifact_path,
                timeout_seconds,
                cancellation,
                |stream, chunk| {
                    let text = String::from_utf8_lossy(chunk).to_string();
                    let _ = append_and_emit_run_event(
                        conn,
                        project_id,
                        &run.task_id,
                        run_id,
                        stream,
                        &text,
                        json!({
                            "stream": stream,
                            "bytes": chunk.len()
                        }),
                        &mut event_sink,
                    );
                },
            )?
        }
        RunnerAdapterKind::CodexAppServer => run_codex_app_server_role(
            conn,
            project_id,
            &run,
            &worktree.worktree_path,
            &artifact_path,
            &command_args,
            &runner_command,
            timeout_seconds,
            cancellation,
            &mut event_sink,
        )?,
    };
    let command_duration_ms = command_started_instant
        .elapsed()
        .as_millis()
        .min(i64::MAX as u128) as i64;
    finalize_host_run(
        conn,
        project_id,
        &task,
        &run,
        &worktree,
        &artifact_path,
        root,
        &command_args,
        &command_started_at,
        command_duration_ms,
        &command_output,
        event_sink,
    )
}

/// host run 종료 후 산출물(structured-result.json 등)을 읽어 final status를 계산하고
/// DB/audit/태스크 전이/Obsidian 문서를 영속화한다. 일반 실행(run_host_role)과
/// 재시작 후 재연결(reattach_host_run) 양쪽에서 공유한다.
fn finalize_host_run(
    conn: &mut Connection,
    project_id: &str,
    task: &TaskSummary,
    run: &AgentRunSummary,
    worktree: &TaskWorktreeSummary,
    artifact_path: &Path,
    root: &Path,
    command_args: &[String],
    command_started_at: &str,
    command_duration_ms: i64,
    command_output: &HostCommandOutput,
    mut event_sink: Option<&mut dyn FnMut(&RunEventSummary)>,
) -> CommandResult<AgentRunSummary> {
    let run_id = run.id.as_str();
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
    append_and_emit_run_event(
        conn,
        project_id,
        &run.task_id,
        run_id,
        "artifact",
        "Execution artifacts collected",
        json!({
            "stdoutPath": format!("{}/stdout.log", run.artifact_dir),
            "stderrPath": format!("{}/stderr.log", run.artifact_dir),
            "dossierPath": format!("{}/{}", run.artifact_dir, role_dossier_artifact_name(&run.role_id)),
            "changedFilesPath": format!("{}/changed-files.json", run.artifact_dir),
            "diffPath": format!("{}/diff.patch", run.artifact_dir),
            "changedFileCount": changed_files.len(),
            "diffExitCode": diff_output.status.code()
        }),
        &mut event_sink,
    )?;

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
    let dossier_ok = role_dossier_is_present(&artifact_path, &run.role_id);
    let has_blocking_gate = result_value
        .as_ref()
        .is_some_and(structured_result_has_blocking_gate);
    let diff_consistency =
        diff_consistency_check(&run.role_id, result_value.as_ref(), &changed_files);
    let exit_code = command_output.exit_code;
    let final_status = if command_output.canceled {
        write_fallback_result(&artifact_path, &run.role_id, exit_code)?;
        "Canceled"
    } else if command_output.timed_out {
        write_fallback_result(&artifact_path, &run.role_id, exit_code)?;
        "TimedOut"
    } else if !schema_ok {
        write_fallback_result(&artifact_path, &run.role_id, exit_code)?;
        "NeedsInspection"
    } else if !dossier_ok {
        write_role_dossier(
            &artifact_path,
            &run.role_id,
            &format!(
                "{}\n\n## 계약 위반\n\n- `{}` 파일이 비어 있거나 생성되지 않았습니다.\n- Helm은 역할별 md 산출물을 handoff source of truth로 요구합니다.\n",
                role_dossier_heading(&run.role_id),
                role_dossier_artifact_name(&run.role_id)
            ),
        )?;
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
    let lifecycle_phase = lifecycle_phase_for_run_status(final_status);
    let failure_kind = failure_kind_for_run_result(
        final_status,
        command_output.timed_out,
        command_output.canceled,
        !schema_ok,
        has_blocking_gate,
        diff_consistency.is_some(),
        exit_code,
    )
    .map(str::to_string);
    let failure_reason = failure_reason_for_run_result(
        final_status,
        command_output.timed_out,
        command_output.canceled,
        !schema_ok,
        has_blocking_gate,
        diff_consistency.is_some(),
        exit_code,
    );

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
                command_args,
                cwd: &worktree.worktree_path,
                exit_code,
                timed_out: command_output.timed_out,
                canceled: command_output.canceled,
                stdout_path: Some("stdout.log"),
                stderr_path: Some("stderr.log"),
                changed_files_path: Some("changed-files.json"),
                diff_path: Some("diff.patch"),
                duration_ms: Some(command_duration_ms),
                started_at: command_started_at,
                finished_at: Some(&command_finished_at),
            },
        )?;
        tx.execute(
            "UPDATE agent_runs
             SET status = ?1,
                 host_pid = NULL,
                 exit_code = ?2,
                 result_status = ?3,
                 finished_at = ?4,
                 lifecycle_phase = ?5,
                 heartbeat_at = ?4,
                 failure_kind = ?6,
                 failure_reason = ?7,
                 updated_at = ?4
             WHERE id = ?8",
            params![
                final_status,
                exit_code,
                result_status,
                finished_at,
                lifecycle_phase,
                failure_kind,
                failure_reason,
                run_id
            ],
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
                "resultStatus": result_status.clone(),
                "changedFiles": &changed_files,
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
            if let Some(repair_request_id) = run.repair_request_id.as_deref() {
                resolve_repair_request_after_success(
                    &tx,
                    project_id,
                    repair_request_id,
                    run_id,
                    &finished_at,
                )?;
            }
            apply_successful_role_result(&tx, project_id, task, &run.role_id, run_id)?;
        } else if run.role_id == "coder" {
            // 구현자 run 종료 처리. 세 갈래다:
            // 1) "실행은 끝났지만 자동 판정 근거가 부족한" NeedsInspection(결과 파일/역할 산출물
            //    누락, coder 자가 보고 미통과 등 — blocking gate도 diff 불일치도 없는 경우)은
            //    리뷰 단계(PlanVerification)로 보내 검토자/사람이 산출물을 판단하게 한다.
            // 2) blocking gate·diff 불일치 같은 실제 결함이나 실행 실패(Failed/TimedOut/Canceled)는
            //    Blocked로 보내 사람이 확인하게 한다. Ready로 두면 has_role_run 가드 때문에 재실행도
            //    다음 단계 전이도 막혀 "준비됨"에서 멈춰 마치 정상 대기처럼 보인다. Blocked는
            //    auto-handoff 대상이 아니라 사람이 보고 직접 repair/판단하게 멈춘다.
            let inspection_only = final_status == "NeedsInspection"
                && !has_blocking_gate
                && diff_consistency.is_none();
            let (next_status, reason) = if inspection_only {
                (
                    "PlanVerification",
                    format!("구현자 실행 점검 필요: {final_status} (리뷰 단계로 전달)"),
                )
            } else {
                (
                    "Blocked",
                    format!("구현자 실행 점검 필요: {final_status} (확인 필요)"),
                )
            };
            let changed = tx
                .execute(
                    "UPDATE tasks
                     SET status = ?1, status_reason = ?2, updated_at = ?3, last_transition_at = ?3
                     WHERE id = ?4 AND project_id = ?5 AND status = 'Coding'",
                    params![next_status, reason, finished_at, run.task_id, project_id],
                )
                .map_err(|err| {
                    CommandError::database("태스크 실행 상태를 저장하지 못했습니다.", err)
                })?;
            if changed > 0 {
                insert_audit(
                    &tx,
                    project_id,
                    "Task",
                    Some(&run.task_id),
                    "task.status_changed",
                    json!({
                        "taskId": run.task_id,
                        "from": "Coding",
                        "to": next_status,
                        "runId": run_id,
                        "reason": format!("coder host run ended with {final_status}"),
                        "source": "host_runner"
                    }),
                )?;
            }
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

    // 회고 후보 캡처(best-effort): run이 끝날 때 산출물에서 lesson 후보를 pending으로 쌓는다.
    // 실패해도 run finalize를 막지 않는다.
    match capture_role_retrospective(
        conn,
        project_id,
        &run.task_id,
        run_id,
        &run.role_id,
        final_status,
        artifact_path,
        root,
    ) {
        Ok(RetroCapture::Pending) => {
            let _ = append_and_emit_run_event(
                conn,
                project_id,
                &run.task_id,
                run_id,
                "system",
                "회고 후보가 등록되었습니다(승인 대기).",
                json!({ "type": "retrospective.captured", "roleId": run.role_id }),
                &mut event_sink,
            );
        }
        Ok(RetroCapture::AutoApplied) => {
            let _ = append_and_emit_run_event(
                conn,
                project_id,
                &run.task_id,
                run_id,
                "system",
                "고신뢰 회고 경험칙이 자동 적용되었습니다.",
                json!({ "type": "retrospective.auto_applied", "roleId": run.role_id }),
                &mut event_sink,
            );
        }
        Ok(RetroCapture::Skipped) => {}
        Err(err) => {
            eprintln!("retrospective capture failed: {}", err.message);
        }
    }

    let summary_text = fs::read_to_string(artifact_path.join("summary.md")).unwrap_or_default();
    let role_dossier_text =
        fs::read_to_string(artifact_path.join(role_dossier_artifact_name(&run.role_id)))
            .unwrap_or_default();
    match write_obsidian_run_artifact(
        conn,
        project_id,
        task,
        run,
        final_status,
        result_status.as_deref(),
        changed_files.len(),
        &finished_at,
        &summary_text,
        Some(&role_dossier_text),
    ) {
        Ok(Some(path)) => {
            append_and_emit_run_event(
                conn,
                project_id,
                &run.task_id,
                run_id,
                "artifact",
                "Obsidian run document saved",
                json!({ "obsidianArtifactPath": path }),
                &mut event_sink,
            )?;
        }
        Ok(None) => {}
        Err(error) => {
            append_and_emit_run_event(
                conn,
                project_id,
                &run.task_id,
                run_id,
                "system",
                "Obsidian run document failed",
                json!({ "error": error.message }),
                &mut event_sink,
            )?;
        }
    }

    append_and_emit_run_event(
        conn,
        project_id,
        &run.task_id,
        run_id,
        "result",
        final_status,
        json!({
            "status": final_status,
            "exitCode": exit_code,
            "resultStatus": result_status.clone(),
            "changedFiles": &changed_files
        }),
        &mut event_sink,
    )?;

    get_agent_run(conn, run_id)
}

/// Helm 재시작 후 살아남은 detached host run에 재연결한다. 자식을 새로 spawn하지 않고
/// 저장된 PID가 끝날 때까지 로그를 tail하며 기다린 뒤, run_host_role와 동일한 finalize를 탄다.
pub fn reattach_host_run(
    conn: &mut Connection,
    root: &Path,
    project_id: &str,
    run_id: &str,
    cancellation: Arc<AtomicBool>,
    mut event_sink: Option<&mut dyn FnMut(&RunEventSummary)>,
) -> CommandResult<AgentRunSummary> {
    let run = get_agent_run(conn, run_id)?;
    if run.project_id != project_id {
        return Err(CommandError::validation(
            "대상 실행 기록을 찾을 수 없습니다.",
        ));
    }
    if run.status != "Running" {
        return Err(CommandError::validation(
            "Running 상태의 host run만 재연결할 수 있습니다.",
        ));
    }
    let host_pid: Option<i64> = conn
        .query_row(
            "SELECT host_pid FROM agent_runs WHERE id = ?1",
            params![run_id],
            |row| row.get(0),
        )
        .map_err(|err| CommandError::database("host PID를 읽지 못했습니다.", err))?;
    let host_pid =
        host_pid.ok_or_else(|| CommandError::validation("재연결할 host PID가 없습니다."))? as u32;

    let task = get_task(conn, &run.task_id)?;
    let worktree = get_task_worktree(conn, project_id, &run.task_id)?
        .ok_or_else(|| CommandError::validation("host run worktree를 찾을 수 없습니다."))?;
    let settings = effective_settings(conn, project_id)?;
    let placeholders = host_runner_placeholders(root, &worktree, &run);
    let runner_command = resolve_host_runner_command(
        &settings,
        &run.role_id,
        run.connection_id.as_deref(),
        &placeholders,
    )?;
    let command_args =
        resolve_command_args(Path::new(&worktree.worktree_path), &runner_command.args);
    let timeout_seconds = runner_command.timeout_seconds;
    let artifact_path = root.join(&run.artifact_dir);

    append_and_emit_run_event(
        conn,
        project_id,
        &run.task_id,
        run_id,
        "system",
        "Reattached to detached host run",
        json!({ "pid": host_pid }),
        &mut event_sink,
    )?;

    let command_started_at = run.claimed_at.clone().unwrap_or_else(now);
    // ponytail: duration은 재연결 시점부터 측정한다(원래 시작 시각 파싱 생략). evidence상 참고용.
    let started_instant = Instant::now();

    let raw_output = wait_detached_pid(
        host_pid,
        &artifact_path,
        timeout_seconds,
        cancellation,
        |stream, chunk| {
            let text = String::from_utf8_lossy(chunk).to_string();
            let _ = append_and_emit_run_event(
                conn,
                project_id,
                &run.task_id,
                run_id,
                stream,
                &text,
                json!({
                    "stream": stream,
                    "bytes": chunk.len()
                }),
                &mut event_sink,
            );
        },
    )?;

    // 재연결 경로는 실제 exit code를 모른다. structured-result.json 계약을 source of truth로
    // 삼아 보정한다. ponytail: non-zero 종료인데 schema-valid pass 결과를 남긴 러너는
    // success로 보일 수 있음 — 정확히 하려면 러너가 exit code 파일을 남기게 한다.
    let result_valid = fs::read_to_string(artifact_path.join("structured-result.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .is_some_and(|value| validate_structured_result(&value));
    let exit_code = if !raw_output.canceled && !raw_output.timed_out && result_valid {
        0
    } else {
        -1
    };
    let command_output = HostCommandOutput {
        exit_code,
        ..raw_output
    };
    let command_duration_ms = started_instant.elapsed().as_millis().min(i64::MAX as u128) as i64;

    finalize_host_run(
        conn,
        project_id,
        &task,
        &run,
        &worktree,
        &artifact_path,
        root,
        &command_args,
        &command_started_at,
        command_duration_ms,
        &command_output,
        event_sink,
    )
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
    write_fallback_result(&artifact_path, &run.role_id, -1)?;

    let finished_at = now();
    conn.execute(
        "UPDATE agent_runs
         SET status = 'NeedsInspection',
             exit_code = -1,
             result_status = 'needs_changes',
             lifecycle_phase = 'failed',
             failure_kind = 'launch_failed',
             failure_reason = ?4,
             finished_at = ?1,
             updated_at = ?1
         WHERE id = ?2 AND project_id = ?3",
        params![finished_at, run_id, project_id, message],
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
    append_run_event(
        conn,
        project_id,
        &run.task_id,
        run_id,
        "stderr",
        message,
        json!({
            "stream": "stderr",
            "source": "launch"
        }),
    )?;
    append_run_event(
        conn,
        project_id,
        &run.task_id,
        run_id,
        "result",
        "NeedsInspection",
        json!({
            "status": "NeedsInspection",
            "exitCode": -1,
            "resultStatus": "needs_changes"
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

pub fn prepare_repair_context(
    conn: &mut Connection,
    root: &Path,
    project_id: &str,
    repair_request_id: &str,
) -> CommandResult<AgentRunSummary> {
    let repair = get_repair_request_record(conn, project_id, repair_request_id)?;
    if repair.status != "Open" {
        return Err(CommandError::validation(
            "이미 닫힌 repair request는 실행 준비를 만들 수 없습니다.",
        ));
    }
    if has_active_run(conn, project_id, &repair.task_id)? {
        return Err(CommandError::validation(
            "이미 준비 중이거나 실행 중인 role run이 있습니다.",
        ));
    }

    let attempts = repair_attempt_count(conn, project_id, repair_request_id)?;
    if attempts >= REPAIR_FAILURE_LIMIT {
        return Err(CommandError::validation(
            "repair 반복 실패 limit에 도달했습니다. manual handoff로 원인을 확인해주세요.",
        ));
    }

    let task = get_task(conn, &repair.task_id)?;
    if task.project_id != project_id {
        return Err(CommandError::validation("대상 태스크를 찾을 수 없습니다."));
    }
    let worktree = ensure_task_worktree(conn, root, project_id, &repair.task_id)?;
    let gate = get_gate_result_record(conn, project_id, repair.gate_result_id.as_deref())?;
    let role_id = repair_role_for_gate(gate.as_ref().map(|item| item.gate.as_str()), &task);
    let settings = effective_settings(conn, project_id)?;
    let worktree_setup = resolve_worktree_setup_config(root, settings.worktree_setup.as_ref())?;
    let role_policy = resolve_role_policy(root, &settings.role_policies, role_id);
    let previous_run = repair
        .run_id
        .as_ref()
        .and_then(|run_id| get_agent_run(conn, run_id).ok());
    let previous_summary = previous_run
        .as_ref()
        .map(|run| read_run_summary_for_context(root, run))
        .unwrap_or_else(|| "이전 실행 summary를 찾지 못했습니다.".to_string());

    let run_id = new_id();
    let timestamp = now();
    let artifact_dir = format!(".helm/artifacts/runs/{run_id}");
    validate_relative_artifact_path(&artifact_dir)?;
    let artifact_path = root.join(&artifact_dir);
    fs::create_dir_all(&artifact_path)
        .map_err(|err| CommandError::io("repair 산출물 폴더를 만들지 못했습니다.", err))?;

    let mut context_pack = build_context_pack_markdown(
        root,
        &task,
        &worktree,
        role_id,
        worktree_setup.as_ref(),
        Some(&role_policy),
    )?;
    context_pack.push_str(&repair_context_markdown(
        &repair,
        gate.as_ref(),
        previous_run.as_ref(),
        &previous_summary,
    ));
    let mut context_manifest = build_context_manifest(
        root,
        &task,
        &worktree,
        role_id,
        worktree_setup.as_ref(),
        Some(&role_policy),
    )?;
    if let Some(object) = context_manifest.as_object_mut() {
        object.insert(
            "repair".to_string(),
            json!({
                "repairRequestId": repair.id,
                "sourceRunId": repair.run_id,
                "gateResultId": repair.gate_result_id,
                "gate": gate.as_ref().map(|item| item.gate.clone()),
                "gateStatus": gate.as_ref().map(|item| item.status.clone()),
                "summary": repair.summary,
                "requiredAction": repair.required_action,
                "affectedFiles": repair.affected_files,
                "attempt": attempts + 1,
                "allowedScope": repair_allowed_scope(&repair.affected_files),
                "disallowedScope": repair_disallowed_scope()
            }),
        );
    }
    let placeholder_result = json!({
        "schemaVersion": 1,
        "status": "needs_changes",
        "summary": "Repair Context Pack이 준비되었고 host runner 실행을 기다리고 있습니다.",
        "changedFiles": [],
        "risks": ["아직 targeted repair runner가 실행되지 않았습니다."],
        "nextActions": ["repair 실행"],
        "gateResult": null
    });

    fs::write(artifact_path.join("context-pack.md"), context_pack)
        .map_err(|err| CommandError::io("Repair Context Pack을 저장하지 못했습니다.", err))?;
    fs::write(
        artifact_path.join("context-pack.json"),
        serde_json::to_string_pretty(&context_manifest).map_err(|err| {
            CommandError::io("Repair Context Pack manifest를 만들지 못했습니다.", err)
        })?,
    )
    .map_err(|err| CommandError::io("Repair Context Pack manifest를 저장하지 못했습니다.", err))?;
    if let Some(setup) = worktree_setup.as_ref() {
        fs::write(
            artifact_path.join("worktree-setup.json"),
            serde_json::to_string_pretty(setup).map_err(|err| {
                CommandError::io("worktree setup config를 만들지 못했습니다.", err)
            })?,
        )
        .map_err(|err| CommandError::io("worktree setup config를 저장하지 못했습니다.", err))?;
    }
    fs::write(
        artifact_path.join("structured-result.schema.json"),
        include_str!("../schemas/structured-result.schema.json"),
    )
    .map_err(|err| CommandError::io("structured result schema를 저장하지 못했습니다.", err))?;
    fs::write(
        artifact_path.join("summary.md"),
        "# Targeted Repair Queued\n\nRepair Context Pack이 준비되었고 실제 host runner 실행 전입니다.\n",
    )
    .map_err(|err| CommandError::io("repair 실행 요약을 저장하지 못했습니다.", err))?;
    write_role_dossier(
        &artifact_path,
        role_id,
        &queued_role_dossier(role_id, "Targeted Repair Queued"),
    )?;
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
        .map_err(|err| CommandError::database("repair context를 저장하지 못했습니다.", err))?;
    tx.execute(
        "INSERT INTO agent_runs (
           id, project_id, task_id, role_id, status, artifact_dir, summary_path, result_path,
           stdout_log_path, stderr_log_path, repair_request_id, exit_code, result_status,
           started_at, finished_at, lifecycle_phase, attempt, created_at, updated_at
         )
         VALUES (?1, ?2, ?3, ?4, 'Queued', ?5, ?6, ?7, ?8, ?9, ?10, NULL, NULL,
                 NULL, NULL, 'queued', ?11, ?12, ?12)",
        params![
            run_id,
            project_id,
            repair.task_id,
            role_id,
            artifact_dir,
            "summary.md",
            "structured-result.json",
            "stdout.log",
            "stderr.log",
            repair.id,
            attempts + 1,
            timestamp
        ],
    )
    .map_err(|err| CommandError::database("repair context를 저장하지 못했습니다.", err))?;
    append_run_event(
        &tx,
        project_id,
        &repair.task_id,
        &run_id,
        "status",
        "Queued",
        json!({
            "status": "Queued",
            "roleId": role_id,
            "artifactDir": artifact_dir,
            "repairRequestId": repair.id,
            "attempt": attempts + 1,
            "worktreePath": worktree.worktree_path.clone()
        }),
    )?;
    append_run_event(
        &tx,
        project_id,
        &repair.task_id,
        &run_id,
        "system",
        "Repair Context Pack created",
        json!({
            "repairRequestId": repair.id,
            "sourceRunId": repair.run_id,
            "gateResultId": repair.gate_result_id,
            "affectedFiles": repair.affected_files,
            "requiredAction": repair.required_action,
            "allowedScope": repair_allowed_scope(&repair.affected_files),
            "disallowedScope": repair_disallowed_scope()
        }),
    )?;
    append_run_event(
        &tx,
        project_id,
        &repair.task_id,
        &run_id,
        "artifact",
        "Repair summary and structured result placeholders created",
        json!({
            "summaryPath": format!("{artifact_dir}/summary.md"),
            "resultPath": format!("{artifact_dir}/structured-result.json"),
            "schemaPath": format!("{artifact_dir}/structured-result.schema.json"),
            "dossierPath": format!("{artifact_dir}/{}", role_dossier_artifact_name(role_id))
        }),
    )?;
    tx.execute(
        "UPDATE repair_requests SET updated_at = ?1 WHERE id = ?2 AND project_id = ?3",
        params![timestamp, repair.id, project_id],
    )
    .map_err(|err| CommandError::database("repair request를 갱신하지 못했습니다.", err))?;
    insert_audit(
        &tx,
        project_id,
        "RepairRequest",
        Some(&repair.id),
        "repair.context_prepared",
        json!({
            "repairRequestId": repair.id,
            "runId": run_id,
            "taskId": repair.task_id,
            "roleId": role_id,
            "attempt": attempts + 1
        }),
    )?;
    tx.commit()
        .map_err(|err| CommandError::database("repair context를 저장하지 못했습니다.", err))?;
    get_agent_run(conn, &run_id)
}

pub fn list_agent_runs(
    conn: &Connection,
    project_id: &str,
    task_id: &str,
) -> CommandResult<Vec<AgentRunSummary>> {
    let mut stmt = conn
        .prepare(
            "SELECT id, project_id, task_id, role_id, status, artifact_dir, summary_path, result_path,
                    stdout_log_path, stderr_log_path, repair_request_id, provider, connection_id, model,
                    exit_code, result_status, started_at, finished_at,
                    lifecycle_phase, claimed_at, heartbeat_at, failure_kind, failure_reason, attempt,
                    (SELECT approvals.id
                       FROM approvals
                      WHERE approvals.project_id = agent_runs.project_id
                        AND approvals.entity_type = 'AgentRun'
                        AND approvals.entity_id = agent_runs.id
                        AND approvals.approval_type = 'RunApproval'
                        AND approvals.status = 'Pending'
                      ORDER BY approvals.created_at DESC
                      LIMIT 1),
                    (SELECT run_events.kind
                       FROM run_events
                      WHERE run_events.run_id = agent_runs.id
                        AND run_events.kind NOT IN ('stdout', 'stderr')
                      ORDER BY run_events.seq DESC
                      LIMIT 1),
                    (SELECT run_events.message
                       FROM run_events
                      WHERE run_events.run_id = agent_runs.id
                        AND run_events.kind NOT IN ('stdout', 'stderr')
                      ORDER BY run_events.seq DESC
                      LIMIT 1),
                    (SELECT run_events.created_at
                       FROM run_events
                      WHERE run_events.run_id = agent_runs.id
                        AND run_events.kind NOT IN ('stdout', 'stderr')
                      ORDER BY run_events.seq DESC
                      LIMIT 1),
                    created_at, updated_at,
                    (SELECT COUNT(*) FROM run_events
                       WHERE run_events.run_id = agent_runs.id
                         AND run_events.kind NOT IN ('stdout', 'stderr'))
             FROM agent_runs WHERE project_id = ?1 AND task_id = ?2 ORDER BY created_at DESC",
        )
        .map_err(|err| CommandError::database("실행 기록을 읽지 못했습니다.", err))?;
    let rows = stmt
        .query_map(params![project_id, task_id], map_agent_run)
        .map_err(|err| CommandError::database("실행 기록을 읽지 못했습니다.", err))?;
    collect_rows(rows, "실행 기록을 읽지 못했습니다.")
}

pub fn list_project_runs(
    conn: &Connection,
    project_id: &str,
    limit: i64,
) -> CommandResult<Vec<AgentRunSummary>> {
    ensure_project_exists(conn, project_id)?;
    let bounded_limit = limit.clamp(1, 500);
    let mut stmt = conn
        .prepare(
            "SELECT id, project_id, task_id, role_id, status, artifact_dir, summary_path, result_path,
                    stdout_log_path, stderr_log_path, repair_request_id, provider, connection_id, model,
                    exit_code, result_status, started_at, finished_at,
                    lifecycle_phase, claimed_at, heartbeat_at, failure_kind, failure_reason, attempt,
                    (SELECT approvals.id
                       FROM approvals
                      WHERE approvals.project_id = agent_runs.project_id
                        AND approvals.entity_type = 'AgentRun'
                        AND approvals.entity_id = agent_runs.id
                        AND approvals.approval_type = 'RunApproval'
                        AND approvals.status = 'Pending'
                      ORDER BY approvals.created_at DESC
                      LIMIT 1),
                    (SELECT run_events.kind
                       FROM run_events
                      WHERE run_events.run_id = agent_runs.id
                        AND run_events.kind NOT IN ('stdout', 'stderr')
                      ORDER BY run_events.seq DESC
                      LIMIT 1),
                    (SELECT run_events.message
                       FROM run_events
                      WHERE run_events.run_id = agent_runs.id
                        AND run_events.kind NOT IN ('stdout', 'stderr')
                      ORDER BY run_events.seq DESC
                      LIMIT 1),
                    (SELECT run_events.created_at
                       FROM run_events
                      WHERE run_events.run_id = agent_runs.id
                        AND run_events.kind NOT IN ('stdout', 'stderr')
                      ORDER BY run_events.seq DESC
                      LIMIT 1),
                    created_at, updated_at,
                    (SELECT COUNT(*) FROM run_events
                       WHERE run_events.run_id = agent_runs.id
                         AND run_events.kind NOT IN ('stdout', 'stderr'))
             FROM agent_runs
             WHERE project_id = ?1
             ORDER BY created_at DESC
             LIMIT ?2",
        )
        .map_err(|err| CommandError::database("프로젝트 실행 기록을 읽지 못했습니다.", err))?;
    let rows = stmt
        .query_map(params![project_id, bounded_limit], map_agent_run)
        .map_err(|err| CommandError::database("프로젝트 실행 기록을 읽지 못했습니다.", err))?;
    collect_rows(rows, "프로젝트 실행 기록을 읽지 못했습니다.")
}

pub fn list_agent_sessions(
    conn: &Connection,
    project_id: &str,
    limit: i64,
) -> CommandResult<Vec<AgentSessionSummary>> {
    ensure_project_exists(conn, project_id)?;
    let bounded_limit = limit.clamp(1, 500);
    let mut stmt = conn
        .prepare(
            "SELECT
                agent_runs.id,
                agent_runs.project_id,
                agent_runs.task_id,
                agent_runs.id,
                COALESCE(NULLIF(tasks.title, ''), agent_runs.role_id || ' session'),
                agent_runs.status,
                agent_runs.provider,
                agent_runs.connection_id,
                agent_runs.model,
                agent_runs.role_id,
                tasks.status,
                task_worktrees.branch_name,
                task_worktrees.worktree_path,
                COALESCE(
                  (SELECT run_events.created_at
                     FROM run_events
                    WHERE run_events.run_id = agent_runs.id
                      AND run_events.kind NOT IN ('stdout', 'stderr')
                    ORDER BY run_events.seq DESC
                    LIMIT 1),
                  agent_runs.heartbeat_at,
                  agent_runs.finished_at,
                  agent_runs.started_at,
                  agent_runs.updated_at,
                  agent_runs.created_at
                ),
                CASE
                  WHEN EXISTS (
                    SELECT 1 FROM approvals
                     WHERE approvals.project_id = agent_runs.project_id
                       AND approvals.entity_type = 'AgentRun'
                       AND approvals.entity_id = agent_runs.id
                       AND approvals.approval_type = 'RunApproval'
                       AND approvals.status = 'Pending'
                  ) THEN 'approval'
                  WHEN agent_runs.status IN ('Queued', 'Prepared') THEN 'start'
                  WHEN agent_runs.status IN ('Running', 'NeedsInput') THEN 'watch'
                  WHEN agent_runs.status IN ('Succeeded', 'Completed') THEN 'review'
                  WHEN agent_runs.status IN ('Failed', 'Cancelled') THEN 'retry'
                  ELSE 'open'
                END,
                NULL,
                (SELECT COUNT(*) FROM run_events WHERE run_events.run_id = agent_runs.id),
                agent_runs.created_at,
                agent_runs.updated_at
             FROM agent_runs
             LEFT JOIN tasks ON tasks.id = agent_runs.task_id AND tasks.project_id = agent_runs.project_id
             LEFT JOIN task_worktrees
               ON task_worktrees.task_id = agent_runs.task_id
              AND task_worktrees.project_id = agent_runs.project_id
              AND task_worktrees.status = 'Active'
             WHERE agent_runs.project_id = ?1
             ORDER BY COALESCE(
                (SELECT run_events.created_at
                   FROM run_events
                  WHERE run_events.run_id = agent_runs.id
                    AND run_events.kind NOT IN ('stdout', 'stderr')
                  ORDER BY run_events.seq DESC
                  LIMIT 1),
                agent_runs.heartbeat_at,
                agent_runs.finished_at,
                agent_runs.started_at,
                agent_runs.updated_at,
                agent_runs.created_at
             ) DESC
             LIMIT ?2",
        )
        .map_err(|err| CommandError::database("세션 요약을 읽지 못했습니다.", err))?;
    let rows = stmt
        .query_map(params![project_id, bounded_limit], map_agent_session)
        .map_err(|err| CommandError::database("세션 요약을 읽지 못했습니다.", err))?;
    collect_rows(rows, "세션 요약을 읽지 못했습니다.")
}

pub fn task_graph_path(root: &Path) -> PathBuf {
    root.join(".helm").join("tasks.md")
}

pub fn read_task_graph(root: &Path) -> CommandResult<Option<String>> {
    let path = task_graph_path(root);
    if !path.exists() {
        return Ok(None);
    }
    fs::read_to_string(&path)
        .map(Some)
        .map_err(|err| CommandError::io("tasks.md를 읽지 못했습니다.", err))
}

pub fn check_task_graph_conflict(root: &Path) -> CommandResult<TaskGraphConflictSummary> {
    let path = task_graph_path(root);
    if !path.exists() {
        return Ok(TaskGraphConflictSummary {
            path: path.to_string_lossy().to_string(),
            exists: false,
            conflict: false,
            reason: None,
            modified_at: None,
        });
    }

    let content = fs::read_to_string(&path)
        .map_err(|err| CommandError::io("tasks.md를 읽지 못했습니다.", err))?;
    let modified_at = file_modified_at(&path);
    let (stored_hash, body) = split_task_graph_hash(&content);
    let conflict = match stored_hash.as_deref() {
        Some(expected) => expected != stable_hash_hex(body.as_bytes()),
        None => true,
    };
    let reason = if conflict {
        Some(match stored_hash {
            Some(_) => "tasks.md가 Helm export 이후 외부에서 수정되었습니다.".to_string(),
            None => "tasks.md에 Helm export hash marker가 없습니다.".to_string(),
        })
    } else {
        None
    };

    Ok(TaskGraphConflictSummary {
        path: path.to_string_lossy().to_string(),
        exists: true,
        conflict,
        reason,
        modified_at,
    })
}

pub fn export_task_graph(
    conn: &Connection,
    root: &Path,
    project_id: &str,
    force: bool,
) -> CommandResult<TaskGraphExportSummary> {
    let before = check_task_graph_conflict(root)?;
    if before.conflict && !force {
        return Err(CommandError::validation(
            "tasks.md가 외부에서 수정되었습니다. 내용을 확인한 뒤 강제로 재생성해주세요.",
        ));
    }

    let (body, task_count) = render_task_graph(conn, root, project_id)?;
    let hash = stable_hash_hex(body.as_bytes());
    let content = format!("<!-- helm-task-graph-hash: {hash} -->\n{body}");
    let path = task_graph_path(root);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| CommandError::io(".helm 폴더를 만들지 못했습니다.", err))?;
    }
    fs::write(&path, &content)
        .map_err(|err| CommandError::io("tasks.md를 저장하지 못했습니다.", err))?;

    Ok(TaskGraphExportSummary {
        path: path.to_string_lossy().to_string(),
        content,
        task_count,
        written_at: now(),
        conflict: check_task_graph_conflict(root)?,
    })
}

pub fn coordination_export_path(root: &Path) -> PathBuf {
    root.join(".helm").join("coordination")
}

pub fn export_coordination_snapshot(
    conn: &Connection,
    root: &Path,
    project_id: &str,
) -> CommandResult<CoordinationExportSummary> {
    let exported_at = now();
    let project = get_project(conn, project_id)?;
    let settings = effective_settings(conn, project_id)?;
    let tasks = list_tasks(conn, project_id)?;
    let mut runs = Vec::new();
    for task in &tasks {
        runs.extend(list_agent_runs(conn, project_id, &task.id)?);
    }
    runs.sort_by(|left, right| {
        left.created_at
            .cmp(&right.created_at)
            .then_with(|| left.id.cmp(&right.id))
    });
    let messages = list_coordination_events(conn, project_id)?;
    let db_schema_version = conn
        .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap_or(SUPPORTED_SCHEMA_VERSION);
    let export_dir = coordination_export_path(root);
    let tasks_dir = export_dir.join("tasks");
    let runs_dir = export_dir.join("runs");
    let messages_dir = export_dir.join("messages");
    clear_coordination_managed_paths(&export_dir)?;
    fs::create_dir_all(&tasks_dir)
        .map_err(|err| CommandError::io("coordination tasks 폴더를 만들지 못했습니다.", err))?;
    fs::create_dir_all(&runs_dir)
        .map_err(|err| CommandError::io("coordination runs 폴더를 만들지 못했습니다.", err))?;
    fs::create_dir_all(&messages_dir)
        .map_err(|err| CommandError::io("coordination messages 폴더를 만들지 못했습니다.", err))?;

    let mut files = Vec::new();
    let agents = json!({
        "schemaVersion": 1,
        "projectId": project_id,
        "aiConnections": settings.ai_connections,
        "roleAssignments": settings.role_assignments,
        "rolePolicies": settings.role_policies,
        "conductorConfig": settings.conductor_config
    });
    files.push(write_coordination_json(
        &export_dir,
        "agents.json",
        &agents,
    )?);

    for task in &tasks {
        files.push(write_coordination_json(
            &export_dir,
            &format!("tasks/{}.json", task.id),
            task,
        )?);
    }
    for run in &runs {
        files.push(write_coordination_json(
            &export_dir,
            &format!("runs/{}.json", run.id),
            run,
        )?);
    }
    for event in &messages {
        files.push(write_coordination_json(
            &export_dir,
            &format!("messages/{}.json", event.id),
            event,
        )?);
    }

    files.sort_by(|left, right| left.path.cmp(&right.path));
    let export_content_hash = coordination_content_hash(&files);
    let manifest = CoordinationManifest {
        schema_version: 1,
        exported_at: &exported_at,
        project_id,
        project_name: &project.name,
        db_schema_version,
        source_db_relative_path: ".helm/helm.sqlite",
        counts: CoordinationCounts {
            tasks: tasks.len(),
            runs: runs.len(),
            messages: messages.len(),
            files: files.len() + 1,
        },
        files: &files,
        warnings: &[] as &[String],
        export_content_hash: &export_content_hash,
    };
    let manifest_file = write_coordination_json(&export_dir, "manifest.json", &manifest)?;

    Ok(CoordinationExportSummary {
        path: export_dir.to_string_lossy().to_string(),
        manifest_path: manifest_file.absolute_path,
        schema_version: 1,
        task_count: tasks.len(),
        run_count: runs.len(),
        message_count: messages.len(),
        file_count: files.len() + 1,
        export_content_hash,
        warnings: Vec::new(),
        written_at: exported_at,
    })
}

fn clear_coordination_managed_paths(export_dir: &Path) -> CommandResult<()> {
    for relative in ["tasks", "runs", "messages"] {
        let path = export_dir.join(relative);
        if path.exists() {
            fs::remove_dir_all(&path).map_err(|err| {
                CommandError::io("coordination export 이전 파일을 정리하지 못했습니다.", err)
            })?;
        }
    }
    for relative in ["agents.json", "manifest.json"] {
        let path = export_dir.join(relative);
        if path.exists() {
            fs::remove_file(&path).map_err(|err| {
                CommandError::io("coordination export 이전 파일을 정리하지 못했습니다.", err)
            })?;
        }
    }
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CoordinationManifest<'a> {
    schema_version: i64,
    exported_at: &'a str,
    project_id: &'a str,
    project_name: &'a str,
    db_schema_version: i64,
    source_db_relative_path: &'a str,
    counts: CoordinationCounts,
    files: &'a [CoordinationFileRecord],
    warnings: &'a [String],
    export_content_hash: &'a str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CoordinationCounts {
    tasks: usize,
    runs: usize,
    messages: usize,
    files: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CoordinationFileRecord {
    path: String,
    absolute_path: String,
    size_bytes: usize,
    content_hash: String,
}

fn list_coordination_events(
    conn: &Connection,
    project_id: &str,
) -> CommandResult<Vec<RunEventSummary>> {
    let mut stmt = conn
        .prepare(
            "SELECT id, project_id, task_id, run_id, seq, kind, message, payload_json, created_at
             FROM run_events
             WHERE project_id = ?1
               AND kind IN ('status', 'approval', 'result', 'artifact', 'system')
             ORDER BY run_id ASC, seq ASC, id ASC",
        )
        .map_err(|err| CommandError::database("coordination events를 읽지 못했습니다.", err))?;
    let rows = stmt
        .query_map(params![project_id], map_run_event)
        .map_err(|err| CommandError::database("coordination events를 읽지 못했습니다.", err))?;
    collect_rows(rows, "coordination events를 읽지 못했습니다.")
}

fn write_coordination_json<T: Serialize>(
    export_dir: &Path,
    relative_path: &str,
    value: &T,
) -> CommandResult<CoordinationFileRecord> {
    let path = export_dir.join(relative_path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| {
            CommandError::io("coordination export 폴더를 만들지 못했습니다.", err)
        })?;
    }
    let mut content = serde_json::to_string_pretty(value).map_err(|err| {
        CommandError::with_details(
            "SerializationFailed",
            "coordination JSON을 만들지 못했습니다.",
            err,
        )
    })?;
    content.push('\n');
    let tmp_path = path.with_extension(format!(
        "{}tmp",
        path.extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| format!("{ext}."))
            .unwrap_or_default()
    ));
    fs::write(&tmp_path, content.as_bytes())
        .map_err(|err| CommandError::io("coordination export 임시 파일을 쓰지 못했습니다.", err))?;
    fs::rename(&tmp_path, &path)
        .map_err(|err| CommandError::io("coordination export 파일을 교체하지 못했습니다.", err))?;
    Ok(CoordinationFileRecord {
        path: relative_path.to_string(),
        absolute_path: path.to_string_lossy().to_string(),
        size_bytes: content.len(),
        content_hash: stable_hash_hex(content.as_bytes()),
    })
}

fn coordination_content_hash(files: &[CoordinationFileRecord]) -> String {
    let mut content = String::new();
    for file in files {
        content.push_str(&file.path);
        content.push('\0');
        content.push_str(&file.content_hash);
        content.push('\n');
    }
    stable_hash_hex(content.as_bytes())
}

fn render_task_graph(
    conn: &Connection,
    root: &Path,
    project_id: &str,
) -> CommandResult<(String, usize)> {
    let project = get_project(conn, project_id)?;
    let tasks = list_tasks(conn, project_id)?;
    let counts = task_counts(&tasks);
    let mut out = String::new();

    out.push_str("<!-- helm-task-graph-version: 1 -->\n");
    out.push_str("<!-- generated-by: Helm Desktop -->\n\n");
    out.push_str("# Helm Task Graph\n\n");
    out.push_str("This file is an export-only mirror of Helm's local DB. ");
    out.push_str("Edit Helm state in the app; manual edits here are treated as a conflict before overwrite.\n\n");
    out.push_str("## Project\n\n");
    out.push_str(&format!("- Name: {}\n", markdown_inline(&project.name)));
    out.push_str(&format!(
        "- Root: `{}`\n",
        inline_code(root.to_string_lossy())
    ));
    if let Some(base_branch) = project.base_branch.as_ref() {
        out.push_str(&format!("- Base branch: `{}`\n", inline_code(base_branch)));
    }
    out.push_str(&format!("- Total tasks: {}\n", counts.total));
    out.push_str(&format!("- Done tasks: {}\n\n", counts.done));

    out.push_str("## Board Summary\n\n");
    if tasks.is_empty() {
        out.push_str("- No tasks yet. Approve a Plan Document in Helm to materialize tasks.\n\n");
    } else {
        for status in TASK_STATUS_ORDER {
            let count = counts.by_status.get(*status).copied().unwrap_or(0);
            out.push_str(&format!("- {}: {}\n", status, count));
        }
        out.push('\n');
    }

    out.push_str("## Tasks\n\n");
    if tasks.is_empty() {
        out.push_str("_No tasks._\n");
        return Ok((out, 0));
    }

    for (index, task) in tasks.iter().enumerate() {
        let runs = list_agent_runs(conn, project_id, &task.id)?;
        let worktree = get_task_worktree(conn, project_id, &task.id)?;
        let active_run = preferred_task_graph_run(&runs);
        let latest_blocker = runs.iter().find(|run| is_retryable_run_status(&run.status));

        out.push_str(&format!(
            "### {}. {}\n\n",
            index + 1,
            markdown_inline(&task.title)
        ));
        out.push_str(&format!("- Task id: `{}`\n", inline_code(&task.id)));
        out.push_str(&format!("- Status: `{}`\n", inline_code(&task.status)));
        if let Some(reason) = task
            .status_reason
            .as_ref()
            .filter(|value| !value.trim().is_empty())
        {
            out.push_str(&format!("- Status reason: {}\n", markdown_inline(reason)));
        }
        out.push_str(&format!(
            "- Next action: {}\n",
            markdown_inline(&next_action_for_task_graph(
                task,
                active_run,
                worktree.as_ref()
            ))
        ));
        out.push_str(&format!(
            "- Active role/run: {}\n",
            markdown_inline(&active_run_summary(active_run))
        ));
        out.push_str(&format!(
            "- Latest blocker: {}\n",
            markdown_inline(&latest_blocker_summary(conn, project_id, latest_blocker)?)
        ));
        out.push_str(&format!(
            "- Worktree: {}\n",
            markdown_inline(&worktree_summary(worktree.as_ref()))
        ));
        out.push_str("- Artifacts:\n");
        if let Some(run) = active_run {
            out.push_str(&format!(
                "  - artifact dir: `{}`\n",
                inline_code(&run.artifact_dir)
            ));
            out.push_str(&format!(
                "  - summary: `{}`\n",
                inline_code(&run.summary_path)
            ));
            out.push_str(&format!(
                "  - result: `{}`\n",
                inline_code(&run.result_path)
            ));
        } else {
            out.push_str("  - none\n");
        }
        out.push_str("- Source refs:\n");
        if task.external_refs.is_empty() {
            out.push_str("  - none\n");
        } else {
            for reference in &task.external_refs {
                out.push_str(&format!(
                    "  - {}: `{}`\n",
                    markdown_inline(&reference.ref_type),
                    inline_code(&reference.ref_value)
                ));
            }
        }
        out.push('\n');
    }

    Ok((out, tasks.len()))
}

fn preferred_task_graph_run(runs: &[AgentRunSummary]) -> Option<&AgentRunSummary> {
    runs.iter()
        .find(|run| run.status == "Running" || run.status == "Queued")
        .or_else(|| runs.first())
}

fn latest_blocker_summary(
    conn: &Connection,
    project_id: &str,
    run: Option<&AgentRunSummary>,
) -> CommandResult<String> {
    let Some(run) = run else {
        return Ok("none".to_string());
    };
    let evidence = latest_run_evidence(conn, project_id, run)?;
    let label = if run.status == "TimedOut" {
        "시간 초과"
    } else if has_worktree_conflict(&evidence) {
        "Worktree 경로 충돌"
    } else if has_auth_problem(&evidence) {
        "Runner 인증 필요"
    } else if run.status == "NeedsInspection" && has_schema_problem(&evidence) {
        "결과 스키마 점검 필요"
    } else if run.status == "NeedsInspection" {
        "Gate 점검 필요"
    } else if run.status == "Canceled" {
        "실행 취소됨"
    } else {
        "실행 실패"
    };
    if evidence.is_empty() {
        Ok(format!(
            "{} · {} {}",
            label,
            role_label(&run.role_id),
            run_status_summary(run)
        ))
    } else {
        Ok(format!(
            "{} · {} {} · {}",
            label,
            role_label(&run.role_id),
            run_status_summary(run),
            evidence
        ))
    }
}

fn latest_run_evidence(
    conn: &Connection,
    project_id: &str,
    run: &AgentRunSummary,
) -> CommandResult<String> {
    let events = list_run_events(conn, project_id, &run.id)?;
    let message = events
        .iter()
        .rev()
        .find(|event| event.kind != "status" && !event.message.trim().is_empty())
        .map(|event| compact_line(&event.message))
        .unwrap_or_default();
    if !message.is_empty() {
        return Ok(message);
    }
    if let Some(reason) = run.failure_reason.as_ref() {
        return Ok(compact_line(reason));
    }
    if let Some(kind) = run.failure_kind.as_ref() {
        return Ok(kind.clone());
    }
    Ok(run
        .result_status
        .as_ref()
        .map(|status| format!("structured result status: {status}"))
        .unwrap_or_default())
}

fn active_run_summary(run: Option<&AgentRunSummary>) -> String {
    match run {
        Some(run) => format!("{} · {}", role_label(&run.role_id), run_status_summary(run)),
        None => "none".to_string(),
    }
}

fn run_status_summary(run: &AgentRunSummary) -> String {
    let mut parts = vec![run.status.as_str()];
    if let Some(phase) = run.lifecycle_phase.as_deref() {
        parts.push(phase);
    }
    if let Some(kind) = run.failure_kind.as_deref() {
        parts.push(kind);
    } else if let Some(result_status) = run.result_status.as_deref() {
        parts.push(result_status);
    }
    parts.join(" · ")
}

fn worktree_summary(worktree: Option<&TaskWorktreeSummary>) -> String {
    match worktree {
        Some(worktree) => format!("{} · {}", worktree.branch_name, worktree.worktree_path),
        None => "none".to_string(),
    }
}

fn next_action_for_task_graph(
    task: &TaskSummary,
    active_run: Option<&AgentRunSummary>,
    worktree: Option<&TaskWorktreeSummary>,
) -> String {
    if let Some(run) = active_run {
        if run.status == "Running" {
            return "명시 report/structured-result 도착까지 Running 유지".to_string();
        }
        if run.status == "Queued" {
            return "host 실행".to_string();
        }
        if is_retryable_run_status(&run.status) {
            return "retry 준비 또는 blocker 확인".to_string();
        }
    }

    if matches!(role_for_task_status(&task.status), Some(_)) && worktree.is_none() {
        return "worktree 준비".to_string();
    }

    match task.status.as_str() {
        "Planned" => "Planner 준비".to_string(),
        "Ready" => "Coder 준비".to_string(),
        "Coding" => "Coder 실행/준비 확인".to_string(),
        "PlanVerification" => "계획 검토 준비".to_string(),
        "CodeReview" => "코드 리뷰 준비".to_string(),
        "Testing" => "테스트 준비".to_string(),
        "MergeWaiting" => "merge decision 확인".to_string(),
        "Merged" => "완료 처리 확인".to_string(),
        "Done" => "none".to_string(),
        "Blocked" => "blocker 확인 또는 계획 수정".to_string(),
        _ => "상태 확인".to_string(),
    }
}

fn role_for_task_status(status: &str) -> Option<&'static str> {
    match status {
        "Planned" | "Blocked" => Some("planner"),
        "Ready" | "Coding" => Some("coder"),
        "PlanVerification" => Some("plan_verifier"),
        "CodeReview" => Some("code_reviewer"),
        "Testing" => Some("tester"),
        _ => None,
    }
}

fn role_label(role_id: &str) -> &'static str {
    match role_id {
        "planner" => "설계자",
        "coder" => "구현자",
        "plan_verifier" => "계획 검토자",
        "code_reviewer" => "코드 리뷰어",
        "tester" => "테스트 담당자",
        _ => "알 수 없는 역할",
    }
}

fn is_retryable_run_status(status: &str) -> bool {
    matches!(
        status,
        "Failed" | "TimedOut" | "NeedsInspection" | "Canceled"
    )
}

struct RepairRequestRecord {
    id: String,
    task_id: String,
    run_id: Option<String>,
    gate_result_id: Option<String>,
    status: String,
    severity: String,
    summary: String,
    required_action: String,
    affected_files: Value,
}

struct GateResultRecord {
    gate: String,
    status: String,
    blocking: bool,
    blockers: Value,
    suggested_next: Option<Value>,
}

fn get_repair_request_record(
    conn: &Connection,
    project_id: &str,
    repair_request_id: &str,
) -> CommandResult<RepairRequestRecord> {
    conn.query_row(
        "SELECT id, task_id, run_id, gate_result_id, status, severity, summary,
                required_action, affected_files_json
         FROM repair_requests
         WHERE id = ?1 AND project_id = ?2",
        params![repair_request_id, project_id],
        |row| {
            let affected_files_raw: String = row.get(8)?;
            Ok(RepairRequestRecord {
                id: row.get(0)?,
                task_id: row.get(1)?,
                run_id: row.get(2)?,
                gate_result_id: row.get(3)?,
                status: row.get(4)?,
                severity: row.get(5)?,
                summary: row.get(6)?,
                required_action: row.get(7)?,
                affected_files: serde_json::from_str(&affected_files_raw).unwrap_or(Value::Null),
            })
        },
    )
    .map_err(|err| {
        CommandError::with_details(
            "ValidationFailed",
            "대상 repair request를 찾을 수 없습니다.",
            err,
        )
    })
}

fn get_gate_result_record(
    conn: &Connection,
    project_id: &str,
    gate_result_id: Option<&str>,
) -> CommandResult<Option<GateResultRecord>> {
    let Some(gate_result_id) = gate_result_id else {
        return Ok(None);
    };
    conn.query_row(
        "SELECT gate, status, blocking, blockers_json, suggested_next_json
         FROM gate_results
         WHERE id = ?1 AND project_id = ?2",
        params![gate_result_id, project_id],
        |row| {
            let blockers_raw: String = row.get(3)?;
            let suggested_next_raw: Option<String> = row.get(4)?;
            Ok(GateResultRecord {
                gate: row.get(0)?,
                status: row.get(1)?,
                blocking: row.get::<_, i64>(2)? == 1,
                blockers: serde_json::from_str(&blockers_raw).unwrap_or(Value::Null),
                suggested_next: suggested_next_raw
                    .and_then(|raw| serde_json::from_str::<Value>(&raw).ok()),
            })
        },
    )
    .optional()
    .map_err(|err| CommandError::database("gate result를 읽지 못했습니다.", err))
}

fn repair_attempt_count(
    conn: &Connection,
    project_id: &str,
    repair_request_id: &str,
) -> CommandResult<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM agent_runs WHERE project_id = ?1 AND repair_request_id = ?2",
        params![project_id, repair_request_id],
        |row| row.get(0),
    )
    .map_err(|err| CommandError::database("repair attempt를 확인하지 못했습니다.", err))
}

fn repair_role_for_gate(gate: Option<&str>, task: &TaskSummary) -> &'static str {
    // 게이트가 있으면 그 단계의 결함이므로 coder가 고친다 — coder 결함으로 Blocked가 된
    // 태스크도 마찬가지다(Blocked → planner로 보내면 재설계로 오라우팅된다). 게이트가 없는
    // 순수 재계획 상황(Planned/Blocked)에서만 planner로 보낸다.
    if gate.is_none() && matches!(task.status.as_str(), "Planned" | "Blocked") {
        return "planner";
    }
    "coder"
}

fn validate_repair_run_state(
    conn: &Connection,
    project_id: &str,
    run: &AgentRunSummary,
) -> CommandResult<()> {
    let Some(repair_request_id) = run.repair_request_id.as_deref() else {
        return Ok(());
    };
    let repair = get_repair_request_record(conn, project_id, repair_request_id)?;
    if repair.status != "Open" {
        return Err(CommandError::validation(
            "닫힌 repair request에 연결된 실행은 시작할 수 없습니다.",
        ));
    }
    if repair.task_id != run.task_id {
        return Err(CommandError::validation(
            "repair request와 실행 태스크가 일치하지 않습니다.",
        ));
    }
    Ok(())
}

fn resolve_repair_request_after_success(
    conn: &Connection,
    project_id: &str,
    repair_request_id: &str,
    run_id: &str,
    timestamp: &str,
) -> CommandResult<()> {
    conn.execute(
        "UPDATE repair_requests
         SET status = 'Resolved', updated_at = ?1
         WHERE id = ?2 AND project_id = ?3 AND status = 'Open'",
        params![timestamp, repair_request_id, project_id],
    )
    .map_err(|err| {
        CommandError::database("repair request를 해결 상태로 저장하지 못했습니다.", err)
    })?;
    insert_audit(
        conn,
        project_id,
        "RepairRequest",
        Some(repair_request_id),
        "repair.resolved",
        json!({
            "repairRequestId": repair_request_id,
            "runId": run_id,
            "reason": "repair run passed"
        }),
    )?;
    Ok(())
}

fn lifecycle_phase_for_run_status(status: &str) -> &'static str {
    match status {
        "Queued" => "queued",
        "Running" => "running",
        "Succeeded" => "completed",
        "Canceled" => "canceled",
        "Failed" | "TimedOut" => "failed",
        "NeedsInspection" => "blocked",
        _ => "unknown",
    }
}

fn failure_kind_for_run_result(
    final_status: &str,
    timed_out: bool,
    canceled: bool,
    schema_invalid: bool,
    has_blocking_gate: bool,
    diff_mismatch: bool,
    exit_code: i32,
) -> Option<&'static str> {
    if final_status == "Succeeded" {
        return None;
    }
    if canceled {
        return Some("canceled");
    }
    if timed_out {
        return Some("timeout");
    }
    if schema_invalid {
        return Some("schema_invalid");
    }
    if diff_mismatch {
        return Some("diff_mismatch");
    }
    if has_blocking_gate {
        return Some("blocking_gate");
    }
    if exit_code != 0 {
        return Some("exit_failed");
    }
    Some("needs_inspection")
}

fn failure_reason_for_run_result(
    final_status: &str,
    timed_out: bool,
    canceled: bool,
    schema_invalid: bool,
    has_blocking_gate: bool,
    diff_mismatch: bool,
    exit_code: i32,
) -> Option<String> {
    failure_kind_for_run_result(
        final_status,
        timed_out,
        canceled,
        schema_invalid,
        has_blocking_gate,
        diff_mismatch,
        exit_code,
    )
    .map(|kind| match kind {
        "canceled" => "Host runner was canceled.".to_string(),
        "timeout" => "Host runner exceeded its configured timeout.".to_string(),
        "schema_invalid" => {
            "structured-result.json was missing or did not match the contract.".to_string()
        }
        "diff_mismatch" => {
            "Runner-reported changed files did not match the actual git diff.".to_string()
        }
        "blocking_gate" => "A structured gate result reported blocking issues.".to_string(),
        "exit_failed" => format!("Host runner exited with code {exit_code}."),
        _ => "Run requires manual inspection before continuing.".to_string(),
    })
}

fn has_worktree_conflict(message: &str) -> bool {
    let lower = message.to_lowercase();
    lower.contains("worktree")
        && (message.contains("이미 존재")
            || lower.contains("already exists")
            || lower.contains("path exists"))
}

fn has_auth_problem(message: &str) -> bool {
    let lower = message.to_lowercase();
    lower.contains("auth")
        || lower.contains("login")
        || lower.contains("unauthorized")
        || lower.contains("api key")
        || message.contains("로그인")
        || message.contains("인증")
        || message.contains("토큰")
}

fn has_schema_problem(message: &str) -> bool {
    let lower = message.to_lowercase();
    lower.contains("schema")
        || lower.contains("structured-result")
        || lower.contains("structured result")
        || message.contains("스키마")
}

fn markdown_inline(value: &str) -> String {
    let compact = compact_line(value);
    compact.replace('[', "\\[").replace(']', "\\]")
}

fn inline_code(value: impl AsRef<str>) -> String {
    value.as_ref().replace('`', "'")
}

fn compact_line(value: &str) -> String {
    let compact = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.chars().count() > 180 {
        format!("{}...", compact.chars().take(177).collect::<String>())
    } else {
        compact
    }
}

fn split_task_graph_hash(content: &str) -> (Option<String>, &str) {
    let Some((first_line, rest)) = content.split_once('\n') else {
        return (None, content);
    };
    let hash = first_line
        .strip_prefix("<!-- helm-task-graph-hash: ")
        .and_then(|value| value.strip_suffix(" -->"))
        .map(str::to_string);
    match hash {
        Some(hash) => (Some(hash), rest),
        None => (None, content),
    }
}

fn stable_hash_hex(bytes: &[u8]) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn file_modified_at(path: &Path) -> Option<String> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    let date: DateTime<Utc> = modified.into();
    Some(date.to_rfc3339())
}

pub fn next_queued_agent_run(
    conn: &Connection,
    project_id: &str,
) -> CommandResult<Option<AgentRunSummary>> {
    conn.query_row(
        "SELECT id, project_id, task_id, role_id, status, artifact_dir, summary_path, result_path,
                stdout_log_path, stderr_log_path, repair_request_id, provider, connection_id, model,
                exit_code, result_status, started_at, finished_at,
                lifecycle_phase, claimed_at, heartbeat_at, failure_kind, failure_reason, attempt,
                (SELECT approvals.id
                   FROM approvals
                  WHERE approvals.project_id = agent_runs.project_id
                    AND approvals.entity_type = 'AgentRun'
                    AND approvals.entity_id = agent_runs.id
                    AND approvals.approval_type = 'RunApproval'
                    AND approvals.status = 'Pending'
                  ORDER BY approvals.created_at DESC
                  LIMIT 1),
                (SELECT run_events.kind
                   FROM run_events
                  WHERE run_events.run_id = agent_runs.id
                    AND run_events.kind NOT IN ('stdout', 'stderr')
                  ORDER BY run_events.seq DESC
                  LIMIT 1),
                (SELECT run_events.message
                   FROM run_events
                  WHERE run_events.run_id = agent_runs.id
                    AND run_events.kind NOT IN ('stdout', 'stderr')
                  ORDER BY run_events.seq DESC
                  LIMIT 1),
                (SELECT run_events.created_at
                   FROM run_events
                  WHERE run_events.run_id = agent_runs.id
                    AND run_events.kind NOT IN ('stdout', 'stderr')
                  ORDER BY run_events.seq DESC
                  LIMIT 1),
                created_at, updated_at,
                (SELECT COUNT(*) FROM run_events
                   WHERE run_events.run_id = agent_runs.id
                     AND run_events.kind NOT IN ('stdout', 'stderr'))
         FROM agent_runs
         WHERE project_id = ?1 AND status = 'Queued'
         ORDER BY created_at ASC
         LIMIT 1",
        params![project_id],
        map_agent_run,
    )
    .optional()
    .map_err(|err| CommandError::database("대기 중인 실행을 읽지 못했습니다.", err))
}

pub fn count_running_agent_runs(conn: &Connection, project_id: &str) -> CommandResult<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM agent_runs WHERE project_id = ?1 AND status = 'Running'",
        params![project_id],
        |row| row.get(0),
    )
    .map_err(|err| CommandError::database("실행 중인 role run 수를 확인하지 못했습니다.", err))
}

/// 현재 Running인 run들이 점유 중인 worktree 경로 목록.
/// in-place(current_branch) run은 모두 프로젝트 root를 가리키므로 경로가 겹쳐
/// 자연히 직렬로 묶이고, 서로 다른 worktree를 가진 run만 병렬 dispatch된다.
pub fn running_run_worktree_paths(
    conn: &Connection,
    project_id: &str,
) -> CommandResult<Vec<String>> {
    let mut stmt = conn
        .prepare(
            "SELECT tw.worktree_path
               FROM agent_runs ar
               JOIN task_worktrees tw
                 ON tw.project_id = ar.project_id AND tw.task_id = ar.task_id
              WHERE ar.project_id = ?1 AND ar.status = 'Running'",
        )
        .map_err(|err| CommandError::database("실행 중인 worktree를 조회하지 못했습니다.", err))?;
    let rows = stmt
        .query_map(params![project_id], |row| row.get::<_, String>(0))
        .map_err(|err| CommandError::database("실행 중인 worktree를 조회하지 못했습니다.", err))?;
    collect_rows(rows, "실행 중인 worktree를 조회하지 못했습니다.")
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
                stdout_log_path, stderr_log_path, repair_request_id, provider, connection_id, model,
                exit_code, result_status, started_at, finished_at,
                lifecycle_phase, claimed_at, heartbeat_at, failure_kind, failure_reason, attempt,
                (SELECT approvals.id
                   FROM approvals
                  WHERE approvals.project_id = agent_runs.project_id
                    AND approvals.entity_type = 'AgentRun'
                    AND approvals.entity_id = agent_runs.id
                    AND approvals.approval_type = 'RunApproval'
                    AND approvals.status = 'Pending'
                  ORDER BY approvals.created_at DESC
                  LIMIT 1),
                (SELECT run_events.kind
                   FROM run_events
                  WHERE run_events.run_id = agent_runs.id
                    AND run_events.kind NOT IN ('stdout', 'stderr')
                  ORDER BY run_events.seq DESC
                  LIMIT 1),
                (SELECT run_events.message
                   FROM run_events
                  WHERE run_events.run_id = agent_runs.id
                    AND run_events.kind NOT IN ('stdout', 'stderr')
                  ORDER BY run_events.seq DESC
                  LIMIT 1),
                (SELECT run_events.created_at
                   FROM run_events
                  WHERE run_events.run_id = agent_runs.id
                    AND run_events.kind NOT IN ('stdout', 'stderr')
                  ORDER BY run_events.seq DESC
                  LIMIT 1),
                created_at, updated_at,
                (SELECT COUNT(*) FROM run_events
                   WHERE run_events.run_id = agent_runs.id
                     AND run_events.kind NOT IN ('stdout', 'stderr'))
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

fn map_conversation_message(row: &rusqlite::Row<'_>) -> rusqlite::Result<ConversationMessage> {
    Ok(ConversationMessage {
        id: row.get(0)?,
        project_id: row.get(1)?,
        seq: row.get(2)?,
        role: row.get(3)?,
        content: row.get(4)?,
        source_run_id: row.get(5)?,
        created_at: row.get(6)?,
    })
}

/// 한 프로젝트의 오케스트레이터/계획자/작업자 대화 메시지를 시간순(append-only)으로 읽는다.
pub fn list_conversation_messages(
    conn: &Connection,
    project_id: &str,
) -> CommandResult<Vec<ConversationMessage>> {
    let mut stmt = conn
        .prepare(
            "SELECT id, project_id, seq, role, content, source_run_id, created_at
             FROM conversation_messages WHERE project_id = ?1 ORDER BY seq ASC",
        )
        .map_err(|err| CommandError::database("대화 메시지를 읽지 못했습니다.", err))?;
    let rows = stmt
        .query_map(params![project_id], map_conversation_message)
        .map_err(|err| CommandError::database("대화 메시지를 읽지 못했습니다.", err))?;
    collect_rows(rows, "대화 메시지를 읽지 못했습니다.")
}

/// 대화 메시지를 스레드 끝에 덧붙인다. source_run_id가 이미 기록된 run이면(중복 폴링)
/// INSERT OR IGNORE로 건너뛰고 None을 돌려준다.
pub fn append_conversation_message(
    conn: &Connection,
    project_id: &str,
    role: &str,
    content: &str,
    source_run_id: Option<&str>,
) -> CommandResult<Option<ConversationMessage>> {
    let id = new_id();
    let created_at = now();
    let seq: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(seq), 0) + 1 FROM conversation_messages WHERE project_id = ?1",
            params![project_id],
            |row| row.get(0),
        )
        .map_err(|err| CommandError::database("대화 메시지를 기록하지 못했습니다.", err))?;
    let changed = conn
        .execute(
            "INSERT OR IGNORE INTO conversation_messages
               (id, project_id, seq, role, content, source_run_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, project_id, seq, role, content, source_run_id, created_at],
        )
        .map_err(|err| CommandError::database("대화 메시지를 기록하지 못했습니다.", err))?;
    if changed == 0 {
        return Ok(None);
    }
    Ok(Some(ConversationMessage {
        id,
        project_id: project_id.to_string(),
        seq,
        role: role.to_string(),
        content: content.to_string(),
        source_run_id: source_run_id.map(|value| value.to_string()),
        created_at,
    }))
}

pub fn list_run_events(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
) -> CommandResult<Vec<RunEventSummary>> {
    let run = get_agent_run(conn, run_id)?;
    if run.project_id != project_id {
        return Err(CommandError::validation(
            "대상 실행 기록을 찾을 수 없습니다.",
        ));
    }

    let mut stmt = conn
        .prepare(
            "SELECT id, project_id, task_id, run_id, seq, kind, message, payload_json, created_at
             FROM run_events WHERE project_id = ?1 AND run_id = ?2 ORDER BY seq ASC",
        )
        .map_err(|err| CommandError::database("실행 이벤트를 읽지 못했습니다.", err))?;
    let rows = stmt
        .query_map(params![project_id, run_id], map_run_event)
        .map_err(|err| CommandError::database("실행 이벤트를 읽지 못했습니다.", err))?;
    collect_rows(rows, "실행 이벤트를 읽지 못했습니다.")
}

pub fn append_system_run_event(
    conn: &Connection,
    project_id: &str,
    task_id: &str,
    run_id: &str,
    message: &str,
    payload: Value,
) -> CommandResult<RunEventSummary> {
    append_run_event(
        conn, project_id, task_id, run_id, "system", message, payload,
    )
}

/// Helm 재시작 시 'Running'으로 남은 host run을 정리한다.
/// - 저장된 host_pid가 아직 살아있으면(detached로 생존) 상태를 그대로 두고 run_id를 반환한다
///   → 호출부가 reattach_host_run으로 재연결한다.
/// - PID가 없거나 죽었으면 기존처럼 NeedsInspection(orphaned)으로 표시한다.
pub fn reconcile_interrupted_runs(
    conn: &Connection,
    project_id: &str,
) -> CommandResult<Vec<String>> {
    let running: Vec<(String, Option<i64>)> = {
        let mut stmt = conn
            .prepare(
                "SELECT id, host_pid FROM agent_runs WHERE project_id = ?1 AND status = 'Running'",
            )
            .map_err(|err| CommandError::database("중단된 실행을 조회하지 못했습니다.", err))?;
        let rows = stmt
            .query_map(params![project_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<i64>>(1)?))
            })
            .map_err(|err| CommandError::database("중단된 실행을 조회하지 못했습니다.", err))?;
        collect_rows(rows, "중단된 실행을 조회하지 못했습니다.")?
    };

    let mut reattach = Vec::new();
    let mut orphaned = Vec::new();
    for (id, pid) in running {
        match pid {
            Some(pid) if host_pid_is_alive(pid as u32) => reattach.push(id),
            _ => orphaned.push(id),
        }
    }

    let timestamp = now();
    for id in &orphaned {
        conn.execute(
            "UPDATE agent_runs
             SET status = 'NeedsInspection',
                 result_status = COALESCE(result_status, 'needs_changes'),
                 lifecycle_phase = 'orphaned',
                 failure_kind = 'orphaned_after_restart',
                 failure_reason = 'Helm app restarted before the host run finished.',
                 finished_at = COALESCE(finished_at, ?1),
                 host_pid = NULL,
                 updated_at = ?1
             WHERE id = ?2",
            params![timestamp, id],
        )
        .map_err(|err| CommandError::database("중단된 실행 상태를 정리하지 못했습니다.", err))?;
    }
    let expired_approvals = conn
        .execute(
            "UPDATE approvals
             SET status = 'Expired',
                 decision_reason = 'Helm app restarted before the host run finished.',
                 decided_at = ?1,
                 updated_at = ?1
             WHERE project_id = ?2
               AND entity_type = 'AgentRun'
               AND approval_type = 'RunApproval'
               AND status = 'Pending'
               AND entity_id IN (
                   SELECT id FROM agent_runs
                    WHERE project_id = ?2
                      AND status = 'NeedsInspection'
                      AND lifecycle_phase = 'orphaned'
                      AND failure_kind = 'orphaned_after_restart'
               )",
            params![timestamp, project_id],
        )
        .map_err(|err| CommandError::database("중단된 실행 승인을 정리하지 못했습니다.", err))?;

    if !orphaned.is_empty() || !reattach.is_empty() || expired_approvals > 0 {
        insert_audit(
            conn,
            project_id,
            "AgentRun",
            None,
            "agent_run.reconciled",
            json!({
                "from": "Running",
                "orphanedCount": orphaned.len(),
                "reattachedCount": reattach.len(),
                "expiredRunApprovals": expired_approvals,
                "reason": "Helm app restarted; live host runs reattached, dead ones marked for inspection"
            }),
        )?;
    }

    Ok(reattach)
}

/// 세션 중 reaper가 살아있는 run을 죽이지 않도록 두는 여유 시간(초).
/// healthy run은 자신의 role timeout(deadline)에서 스스로 종료되므로, 마지막 활동이
/// timeout + 이 grace 보다 오래 멈춘 Running run은 finalize에 도달하지 못한 좀비로 본다.
const STALE_RUN_GRACE_SECONDS: i64 = 120;

/// 앱이 떠 있는 동안 host run thread가 finalize에 도달하지 못하고 죽거나 hang하면
/// agent_runs row가 'Running'으로 영구히 남아 `count_running_agent_runs`가 큐 워커의
/// 동시 한도를 영구 점유한다(시작 시에만 도는 `reconcile_interrupted_runs`로는 못 잡는다).
/// 마지막 활동(heartbeat, 없으면 started_at)이 role timeout + grace 보다 오래 멈췄고
/// 살아있는 host_pid도 없는 Running run을 좀비로 보고 NeedsInspection으로 회수한다.
/// NeedsInspection은 retry 가능 상태라 사용자가 재시도 버튼으로 다시 돌릴 수 있다.
pub fn reap_stale_running_runs(conn: &Connection, project_id: &str) -> CommandResult<Vec<String>> {
    let candidates: Vec<(String, String, Option<String>, Option<String>, Option<i64>)> = {
        let mut stmt = conn
            .prepare(
                "SELECT id, role_id, heartbeat_at, started_at, host_pid
                   FROM agent_runs
                  WHERE project_id = ?1 AND status = 'Running'",
            )
            .map_err(|err| CommandError::database("실행 상태를 조회하지 못했습니다.", err))?;
        let rows = stmt
            .query_map(params![project_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<i64>>(4)?,
                ))
            })
            .map_err(|err| CommandError::database("실행 상태를 조회하지 못했습니다.", err))?;
        collect_rows(rows, "실행 상태를 조회하지 못했습니다.")?
    };
    if candidates.is_empty() {
        return Ok(Vec::new());
    }

    let settings = effective_settings(conn, project_id)?;
    let now_dt = Utc::now();
    let timestamp = now();
    let mut reaped = Vec::new();
    for (id, role_id, heartbeat_at, started_at, host_pid) in candidates {
        // host_pid가 살아있으면(Process 어댑터의 detached run 등) 진짜 실행 중일 수 있으니 둔다.
        if let Some(pid) = host_pid {
            if host_pid_is_alive(pid as u32) {
                continue;
            }
        }
        let Some(last_seen) = heartbeat_at.or(started_at) else {
            continue; // 시간 정보가 없으면 함부로 회수하지 않는다.
        };
        let Ok(last_dt) = DateTime::parse_from_rfc3339(&last_seen) else {
            continue;
        };
        let idle_secs = (now_dt - last_dt.with_timezone(&Utc)).num_seconds();
        let timeout = role_timeout_seconds(&settings.role_presets, &role_id) as i64;
        if idle_secs <= timeout + STALE_RUN_GRACE_SECONDS {
            continue; // 아직 자기 deadline 안. 살아있을 수 있으니 둔다.
        }
        conn.execute(
            "UPDATE agent_runs
                SET status = 'NeedsInspection',
                    result_status = COALESCE(result_status, 'needs_changes'),
                    lifecycle_phase = 'orphaned',
                    failure_kind = 'orphaned_stale_heartbeat',
                    failure_reason = 'Host run thread stopped before finishing (stale heartbeat past timeout).',
                    finished_at = COALESCE(finished_at, ?1),
                    host_pid = NULL,
                    updated_at = ?1
              WHERE id = ?2 AND status = 'Running'",
            params![timestamp, id],
        )
        .map_err(|err| CommandError::database("좀비 실행 상태를 정리하지 못했습니다.", err))?;
        reaped.push(id);
    }

    if !reaped.is_empty() {
        insert_audit(
            conn,
            project_id,
            "AgentRun",
            None,
            "agent_run.reaped_stale",
            json!({
                "reapedCount": reaped.len(),
                "reason": "Running run idle past role timeout with no live host process"
            }),
        )?;
    }
    Ok(reaped)
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
             lifecycle_phase = 'blocked',
             failure_kind = 'persistence_failed',
             failure_reason = ?4,
             finished_at = COALESCE(finished_at, ?1),
             updated_at = ?1
         WHERE id = ?2 AND project_id = ?3",
        params![timestamp, run_id, project_id, error.message.as_str()],
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
            | "plan.md"
            | "pr-dossier.md"
            | "plan-verification.md"
            | "review-report.md"
            | "test-report.md"
            | "role-dossier.md"
            | "stdout.log"
            | "stderr.log"
            | "context-pack.md"
            | "context-pack.json"
            | "context-manifest.json"
            | "runner-request.json"
            | "git-before.txt"
            | "git-after.txt"
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
                 FROM approvals
                 WHERE project_id = ?1
                   AND status = ?2
                   AND NOT (
                       status = 'Pending'
                       AND entity_type = 'AgentRun'
                       AND approval_type = 'RunApproval'
                       AND entity_id IN (
                           SELECT id FROM agent_runs
                            WHERE project_id = ?1
                              AND status = 'NeedsInspection'
                              AND lifecycle_phase = 'orphaned'
                              AND failure_kind = 'orphaned_after_restart'
                       )
                   )
                 ORDER BY requested_at DESC",
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
             FROM approvals
             WHERE project_id = ?1
               AND NOT (
                   status = 'Pending'
                   AND entity_type = 'AgentRun'
                   AND approval_type = 'RunApproval'
                   AND entity_id IN (
                       SELECT id FROM agent_runs
                        WHERE project_id = ?1
                          AND status = 'NeedsInspection'
                          AND lifecycle_phase = 'orphaned'
                          AND failure_kind = 'orphaned_after_restart'
                   )
               )
             ORDER BY requested_at DESC",
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
    let next_task_status = match approval.approval_type.as_str() {
        "PlanApproval" => Some(if decision == "Approved" {
            "Ready"
        } else {
            "Blocked"
        }),
        // 리뷰 진행 승인: 승인 시 CodeReview 유지(approve_approval이 PR 생성+리뷰어 실행),
        // 반려 시 Blocked로 보내 사용자 결정을 기다린다.
        "ReviewApproval" if decision == "Rejected" => Some("Blocked"),
        _ => None,
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
    // 회고 학습 승인: approval과 회고 상태를 같은 트랜잭션에서 함께 전환한다(비원자성 방지).
    // 파일(.lessons.md) 재생성은 파생 캐시라 command 계층에서 best-effort로 수행한다.
    if approval.approval_type == "RoleLesson" {
        let lesson_status = if decision == "Approved" {
            "active"
        } else {
            "disabled"
        };
        tx.execute(
            "UPDATE role_retrospectives SET status = ?1, updated_at = ?2 \
             WHERE id = ?3 AND project_id = ?4",
            params![lesson_status, timestamp, approval.entity_id, project_id],
        )
        .map_err(|err| CommandError::database("회고 상태를 저장하지 못했습니다.", err))?;
    }
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
                "reason": format!("{} {}", approval.approval_type, if decision == "Approved" { "approved" } else { "rejected" }),
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
        repair_request_id: row.get(10)?,
        provider: row.get(11)?,
        connection_id: row.get(12)?,
        model: row.get(13)?,
        exit_code: row.get(14)?,
        result_status: row.get(15)?,
        started_at: row.get(16)?,
        finished_at: row.get(17)?,
        lifecycle_phase: row.get(18)?,
        claimed_at: row.get(19)?,
        heartbeat_at: row.get(20)?,
        failure_kind: row.get(21)?,
        failure_reason: row.get(22)?,
        attempt: row.get(23)?,
        pending_run_approval_id: row.get(24)?,
        latest_event_kind: row.get(25)?,
        latest_event_message: row.get(26)?,
        latest_event_at: row.get(27)?,
        created_at: row.get(28)?,
        updated_at: row.get(29)?,
        event_count: row.get(30)?,
    })
}

fn map_agent_session(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentSessionSummary> {
    Ok(AgentSessionSummary {
        id: row.get(0)?,
        project_id: row.get(1)?,
        task_id: row.get(2)?,
        source_run_id: row.get(3)?,
        title: row.get(4)?,
        status: row.get(5)?,
        provider: row.get(6)?,
        connection_id: row.get(7)?,
        model: row.get(8)?,
        role_id: row.get(9)?,
        task_status: row.get(10)?,
        branch: row.get(11)?,
        worktree_path: row.get(12)?,
        last_signal_at: row.get(13)?,
        next_action: row.get(14)?,
        changed_file_count: row.get(15)?,
        event_count: row.get(16)?,
        created_at: row.get(17)?,
        updated_at: row.get(18)?,
    })
}

fn map_run_event(row: &rusqlite::Row<'_>) -> rusqlite::Result<RunEventSummary> {
    let payload_raw: String = row.get(7)?;
    Ok(RunEventSummary {
        id: row.get(0)?,
        project_id: row.get(1)?,
        task_id: row.get(2)?,
        run_id: row.get(3)?,
        seq: row.get(4)?,
        kind: row.get(5)?,
        message: row.get(6)?,
        payload: serde_json::from_str(&payload_raw).unwrap_or(Value::Null),
        created_at: row.get(8)?,
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

struct PlanningSessionRow {
    id: String,
    project_id: String,
    title: String,
    goal_text: String,
    status: String,
    jira_ref: Option<String>,
    jira_state: String,
    current_draft_id: Option<String>,
    created_at: String,
    updated_at: String,
}

struct PlanDraftValidationStats {
    validation: Value,
    task_count: i64,
    task_graph_count: i64,
    barrier_count: i64,
    verification_gate_count: i64,
}

struct PlanTaskCardContract {
    id: String,
    owned_files: BTreeSet<String>,
    shared_files: BTreeSet<String>,
    has_generated_file_policy: bool,
    has_report_contract: bool,
    uses_deep_contract: bool,
}

fn planning_session_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PlanningSessionRow> {
    Ok(PlanningSessionRow {
        id: row.get(0)?,
        project_id: row.get(1)?,
        title: row.get(2)?,
        goal_text: row.get(3)?,
        status: row.get(4)?,
        jira_ref: row.get(5)?,
        jira_state: row.get(6)?,
        current_draft_id: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

fn hydrate_planning_session_summary(
    conn: &Connection,
    row: PlanningSessionRow,
) -> CommandResult<PlanningSessionSummary> {
    let current_draft = row
        .current_draft_id
        .as_deref()
        .map(|draft_id| get_plan_draft_revision(conn, draft_id))
        .transpose()?;
    let current_approval = row
        .current_draft_id
        .as_deref()
        .map(|draft_id| get_planning_approval_by_draft(conn, &row.project_id, draft_id))
        .transpose()?
        .flatten();
    let materialization = get_latest_materialization_for_session(conn, &row.project_id, &row.id)?;
    let message_count = planning_message_count(conn, &row.id)?;
    Ok(PlanningSessionSummary {
        id: row.id,
        project_id: row.project_id,
        title: row.title,
        goal_text: row.goal_text,
        status: row.status,
        jira_ref: row.jira_ref,
        jira_state: row.jira_state,
        current_draft_id: row.current_draft_id,
        current_draft,
        current_approval,
        materialization,
        message_count,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

fn planning_message_count(conn: &Connection, session_id: &str) -> CommandResult<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM planning_messages WHERE session_id = ?1",
        params![session_id],
        |row| row.get(0),
    )
    .map_err(|err| CommandError::database("계획 메시지 수를 읽지 못했습니다.", err))
}

fn list_planning_messages(
    conn: &Connection,
    project_id: &str,
    session_id: &str,
) -> CommandResult<Vec<PlanningMessageSummary>> {
    let mut stmt = conn
        .prepare(
            "SELECT id, project_id, session_id, role, content, draft_revision_id, created_at
             FROM planning_messages
             WHERE project_id = ?1 AND session_id = ?2
             ORDER BY created_at ASC",
        )
        .map_err(|err| CommandError::database("계획 메시지를 읽지 못했습니다.", err))?;
    let rows = stmt
        .query_map(params![project_id, session_id], |row| {
            Ok(PlanningMessageSummary {
                id: row.get(0)?,
                project_id: row.get(1)?,
                session_id: row.get(2)?,
                role: row.get(3)?,
                content: row.get(4)?,
                draft_revision_id: row.get(5)?,
                created_at: row.get(6)?,
            })
        })
        .map_err(|err| CommandError::database("계획 메시지를 읽지 못했습니다.", err))?;
    collect_rows(rows, "계획 메시지를 읽지 못했습니다.")
}

fn get_plan_draft_revision(
    conn: &Connection,
    draft_id: &str,
) -> CommandResult<PlanDraftRevisionSummary> {
    let row = conn
        .query_row(
            "SELECT id, project_id, session_id, revision, title, summary, plan_markdown,
                    artifact_path, content_hash, draft_json, validation_json, task_count,
                    task_graph_count, barrier_count, verification_gate_count, created_at
             FROM plan_draft_revisions
             WHERE id = ?1",
            params![draft_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, String>(10)?,
                    row.get::<_, i64>(11)?,
                    row.get::<_, i64>(12)?,
                    row.get::<_, i64>(13)?,
                    row.get::<_, i64>(14)?,
                    row.get::<_, String>(15)?,
                ))
            },
        )
        .map_err(|err| {
            CommandError::with_details(
                "ValidationFailed",
                "대상 Plan Document를 찾을 수 없습니다.",
                err,
            )
        })?;
    let draft_json = serde_json::from_str(&row.9).map_err(|err| {
        CommandError::with_details(
            "ValidationFailed",
            "Plan Document JSON을 읽지 못했습니다.",
            err,
        )
    })?;
    let validation = serde_json::from_str(&row.10).map_err(|err| {
        CommandError::with_details(
            "ValidationFailed",
            "Plan Document 검증 정보를 읽지 못했습니다.",
            err,
        )
    })?;
    Ok(PlanDraftRevisionSummary {
        id: row.0,
        project_id: row.1,
        session_id: row.2,
        revision: row.3,
        title: row.4,
        summary: row.5,
        plan_markdown: row.6,
        artifact_path: row.7,
        content_hash: row.8,
        draft_json,
        validation,
        task_count: row.11,
        task_graph_count: row.12,
        barrier_count: row.13,
        verification_gate_count: row.14,
        created_at: row.15,
    })
}

fn get_planning_approval_by_draft(
    conn: &Connection,
    project_id: &str,
    draft_id: &str,
) -> CommandResult<Option<PlanningApprovalSummary>> {
    conn.query_row(
        "SELECT id, project_id, session_id, draft_id, status, requested_reason,
                decision_reason, requested_at, decided_at, created_at, updated_at
         FROM planning_approvals
         WHERE project_id = ?1 AND draft_id = ?2",
        params![project_id, draft_id],
        map_planning_approval,
    )
    .optional()
    .map_err(|err| CommandError::database("계획 승인 요청을 읽지 못했습니다.", err))
}

fn get_planning_approval_required(
    conn: &Connection,
    project_id: &str,
    draft_id: &str,
) -> CommandResult<PlanningApprovalSummary> {
    get_planning_approval_by_draft(conn, project_id, draft_id)?
        .ok_or_else(|| CommandError::validation("대상 Plan Document 승인 요청을 찾을 수 없습니다."))
}

fn map_planning_approval(row: &rusqlite::Row<'_>) -> rusqlite::Result<PlanningApprovalSummary> {
    Ok(PlanningApprovalSummary {
        id: row.get(0)?,
        project_id: row.get(1)?,
        session_id: row.get(2)?,
        draft_id: row.get(3)?,
        status: row.get(4)?,
        requested_reason: row.get(5)?,
        decision_reason: row.get(6)?,
        requested_at: row.get(7)?,
        decided_at: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

fn decide_plan_draft(
    conn: &mut Connection,
    project_id: &str,
    draft_id: &str,
    input: DecidePlanDraftInput,
    decision: &str,
) -> CommandResult<PlanningSessionDetail> {
    if decision != "Approved" && decision != "Rejected" {
        return Err(CommandError::validation(
            "지원하지 않는 계획 승인 결정입니다.",
        ));
    }
    let draft = get_plan_draft_revision(conn, draft_id)?;
    if draft.project_id != project_id {
        return Err(CommandError::validation(
            "대상 Plan Document를 찾을 수 없습니다.",
        ));
    }
    let approval = get_planning_approval_required(conn, project_id, draft_id)?;
    if approval.status == decision {
        return get_planning_session(conn, project_id, &draft.session_id);
    }
    if approval.status != "Pending" {
        return Err(CommandError::validation(
            "이미 결정된 Plan Document 승인 요청입니다.",
        ));
    }

    let reason = input
        .reason
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(if decision == "Approved" {
            "Plan Document approved"
        } else {
            "Plan Document rejected"
        })
        .to_string();
    let timestamp = now();
    let tx = conn
        .transaction()
        .map_err(|err| CommandError::database("계획 승인 결정을 저장하지 못했습니다.", err))?;
    tx.execute(
        "UPDATE planning_approvals
         SET status = ?1, decision_reason = ?2, decided_at = ?3, updated_at = ?3
         WHERE id = ?4 AND project_id = ?5 AND status = 'Pending'",
        params![decision, reason, timestamp, approval.id, project_id],
    )
    .map_err(|err| CommandError::database("계획 승인 결정을 저장하지 못했습니다.", err))?;
    if decision == "Rejected" {
        tx.execute(
            "UPDATE planning_sessions
             SET status = 'Drafting', updated_at = ?1
             WHERE id = ?2 AND project_id = ?3 AND current_draft_id = ?4",
            params![timestamp, draft.session_id, project_id, draft_id],
        )
        .map_err(|err| CommandError::database("계획 세션 상태를 저장하지 못했습니다.", err))?;
    }
    insert_audit(
        &tx,
        project_id,
        "PlanDraftRevision",
        Some(draft_id),
        if decision == "Approved" {
            "plan_draft.approved"
        } else {
            "plan_draft.rejected"
        },
        json!({
            "sessionId": draft.session_id,
            "draftId": draft_id,
            "approvalId": approval.id,
            "decision": decision,
            "reason": reason
        }),
    )?;
    tx.commit()
        .map_err(|err| CommandError::database("계획 승인 결정을 저장하지 못했습니다.", err))?;
    get_planning_session(conn, project_id, &draft.session_id)
}

fn ensure_plan_draft_approved(
    conn: &Connection,
    project_id: &str,
    draft_id: &str,
) -> CommandResult<()> {
    let approval = get_planning_approval_required(conn, project_id, draft_id)?;
    if approval.status == "Approved" {
        return Ok(());
    }
    Err(CommandError::new(
        "PlanDraftApprovalRequired",
        "Plan Document 승인 후 Task로 변환할 수 있습니다.",
    ))
}

fn ensure_materialization_tasks_exist(
    conn: &Connection,
    materialization: &PlanningMaterializationSummary,
) -> CommandResult<()> {
    if materialization.task_ids.is_empty() {
        return Err(CommandError::new(
            "MaterializationBroken",
            "계획 materialization에 연결된 Task 목록이 비어 있습니다.",
        ));
    }
    for task_id in &materialization.task_ids {
        let exists: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM tasks WHERE id = ?1 AND project_id = ?2",
                params![task_id, materialization.project_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|err| {
                CommandError::database("계획 materialization Task 상태를 확인하지 못했습니다.", err)
            })?;
        if exists.is_none() {
            return Err(CommandError::with_details(
                "MaterializationBroken",
                "계획 materialization에 연결된 Task를 찾을 수 없습니다.",
                task_id,
            ));
        }
    }
    Ok(())
}

fn get_materialization(
    conn: &Connection,
    project_id: &str,
    materialization_id: &str,
) -> CommandResult<PlanningMaterializationSummary> {
    let materialization = get_materialization_where(
        conn,
        "id = ?1 AND project_id = ?2",
        params![materialization_id, project_id],
    )?
    .ok_or_else(|| {
        CommandError::validation("대상 계획 materialization 결과를 찾을 수 없습니다.")
    })?;
    Ok(materialization)
}

fn get_materialization_by_draft(
    conn: &Connection,
    project_id: &str,
    draft_id: &str,
) -> CommandResult<Option<PlanningMaterializationSummary>> {
    get_materialization_where(
        conn,
        "draft_id = ?1 AND project_id = ?2",
        params![draft_id, project_id],
    )
}

fn get_latest_materialization_for_session(
    conn: &Connection,
    project_id: &str,
    session_id: &str,
) -> CommandResult<Option<PlanningMaterializationSummary>> {
    get_materialization_where(
        conn,
        "session_id = ?1 AND project_id = ?2 ORDER BY created_at DESC LIMIT 1",
        params![session_id, project_id],
    )
}

fn get_materialization_where<P>(
    conn: &Connection,
    where_clause: &str,
    params: P,
) -> CommandResult<Option<PlanningMaterializationSummary>>
where
    P: rusqlite::Params,
{
    let sql = format!(
        "SELECT id, project_id, session_id, draft_id, status, task_ids_json, created_at, updated_at
         FROM planning_materializations
         WHERE {where_clause}"
    );
    let row = conn
        .query_row(&sql, params, |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
            ))
        })
        .optional()
        .map_err(|err| CommandError::database("계획 materialization을 읽지 못했습니다.", err))?;
    row.map(|row| {
        let task_ids = serde_json::from_str(&row.5).map_err(|err| {
            CommandError::with_details(
                "ValidationFailed",
                "계획 materialization Task 목록을 읽지 못했습니다.",
                err,
            )
        })?;
        Ok(PlanningMaterializationSummary {
            id: row.0,
            project_id: row.1,
            session_id: row.2,
            draft_id: row.3,
            status: row.4,
            task_ids,
            created_at: row.6,
            updated_at: row.7,
        })
    })
    .transpose()
}

fn next_plan_draft_revision(conn: &Connection, session_id: &str) -> CommandResult<i64> {
    conn.query_row(
        "SELECT COALESCE(MAX(revision), 0) + 1 FROM plan_draft_revisions WHERE session_id = ?1",
        params![session_id],
        |row| row.get(0),
    )
    .map_err(|err| CommandError::database("Plan Document revision 번호를 만들지 못했습니다.", err))
}

fn validate_plan_draft_json(draft: &Value) -> CommandResult<PlanDraftValidationStats> {
    let mut errors = Vec::new();
    if !draft.is_object() {
        errors.push("Plan Document는 JSON object여야 합니다.".to_string());
    }
    if plan_string_field(draft, &["title"]).is_none() {
        errors.push("title이 필요합니다.".to_string());
    }
    if plan_string_field(draft, &["summary"]).is_none() {
        errors.push("summary가 필요합니다.".to_string());
    }
    let task_count = plan_draft_task_values(draft).len() as i64;
    if task_count == 0 {
        errors.push("tasks 배열에 최소 1개 Task가 필요합니다.".to_string());
    }

    let Some(executable_plan) = plan_field(draft, &["executablePlan", "executable_plan"]) else {
        errors.push("executablePlan이 필요합니다.".to_string());
        return plan_validation_result(errors, 0, 0, 0, 0);
    };
    if !executable_plan.is_object() {
        errors.push("executablePlan은 JSON object여야 합니다.".to_string());
    }
    let task_graph_count = plan_array_len(executable_plan, &["taskGraph", "task_graph"]);
    let task_card_count = plan_array_len(executable_plan, &["taskCards", "task_cards"]);
    let ownership_count = plan_array_len(executable_plan, &["ownershipMap", "ownership_map"]);
    let barrier_count = plan_array_len(executable_plan, &["barriers"]);
    let verification_gate_count = plan_array_len(
        executable_plan,
        &["verificationGates", "verification_gates"],
    );

    if task_graph_count == 0 {
        errors.push("executablePlan.taskGraph에 최소 1개 node가 필요합니다.".to_string());
    }
    if task_card_count == 0 {
        errors.push("executablePlan.taskCards에 최소 1개 card가 필요합니다.".to_string());
    }
    if ownership_count == 0 {
        errors.push("executablePlan.ownershipMap에 최소 1개 owner가 필요합니다.".to_string());
    }
    if !plan_has_array(executable_plan, &["barriers"]) {
        errors.push("executablePlan.barriers 배열이 필요합니다.".to_string());
    }
    if verification_gate_count == 0 {
        errors.push("executablePlan.verificationGates에 최소 1개 gate가 필요합니다.".to_string());
    }
    validate_executable_plan_contract(executable_plan, &mut errors);

    plan_validation_result(
        errors,
        task_count,
        task_graph_count,
        barrier_count,
        verification_gate_count,
    )
}

fn validate_executable_plan_contract(executable_plan: &Value, errors: &mut Vec<String>) {
    let graph_nodes = plan_array_values(executable_plan, &["taskGraph", "task_graph"]);
    let mut graph_ids = BTreeSet::new();
    let mut dependencies: HashMap<String, BTreeSet<String>> = HashMap::new();
    for (index, node) in graph_nodes.iter().enumerate() {
        let Some(id) = plan_string_field(node, &["id", "taskId", "task_id"]) else {
            errors.push(format!(
                "executablePlan.taskGraph[{index}].id가 필요합니다."
            ));
            continue;
        };
        if !graph_ids.insert(id.clone()) {
            errors.push(format!("executablePlan.taskGraph id `{id}`가 중복됩니다."));
        }
        let depends_on = plan_string_list(node, &["dependsOn", "depends_on", "dependencies"])
            .into_iter()
            .collect::<BTreeSet<_>>();
        if depends_on.contains(&id) {
            errors.push(format!(
                "executablePlan.taskGraph `{id}`가 자기 자신에 의존합니다."
            ));
        }
        dependencies.insert(id, depends_on);
    }
    for (id, depends_on) in &dependencies {
        for dependency in depends_on {
            if !graph_ids.contains(dependency) {
                errors.push(format!(
                    "executablePlan.taskGraph `{id}`의 dependsOn `{dependency}`를 찾을 수 없습니다."
                ));
            }
        }
    }

    let task_cards = plan_array_values(executable_plan, &["taskCards", "task_cards"]);
    let mut card_ids = BTreeSet::new();
    let mut cards = Vec::new();
    let mut uses_deep_contract = false;
    for (index, card) in task_cards.iter().enumerate() {
        let Some(id) = plan_string_field(card, &["id", "taskId", "task_id"]) else {
            errors.push(format!(
                "executablePlan.taskCards[{index}].id가 필요합니다."
            ));
            continue;
        };
        if !card_ids.insert(id.clone()) {
            errors.push(format!("executablePlan.taskCards id `{id}`가 중복됩니다."));
        }
        if !graph_ids.is_empty() && !graph_ids.contains(&id) {
            errors.push(format!(
                "executablePlan.taskCards `{id}`에 대응하는 taskGraph node가 없습니다."
            ));
        }

        let has_ownership_fields = plan_has_field(card, &["ownedFiles", "owned_files"])
            || plan_has_field(
                card,
                &[
                    "sharedFiles",
                    "shared_files",
                    "readOnlyFiles",
                    "read_only_files",
                ],
            )
            || plan_has_field(card, &["generatedFiles", "generated_files"]);
        let has_report_contract = plan_string_field(
            card,
            &[
                "reportContract",
                "report_contract",
                "reportFormat",
                "report_format",
            ],
        )
        .is_some();
        let has_generated_file_policy = plan_string_field(
            card,
            &[
                "generatedFilePolicy",
                "generated_file_policy",
                "generatedPolicy",
                "generated_policy",
            ],
        )
        .is_some();
        let card_uses_deep_contract =
            has_ownership_fields || has_report_contract || has_generated_file_policy;
        uses_deep_contract |= card_uses_deep_contract;

        let owned_files = plan_file_set(
            card,
            &["ownedFiles", "owned_files"],
            "ownedFiles",
            &id,
            errors,
        );
        let shared_files = plan_file_set(
            card,
            &[
                "sharedFiles",
                "shared_files",
                "readOnlyFiles",
                "read_only_files",
            ],
            "sharedFiles",
            &id,
            errors,
        );
        let _generated_files = plan_file_set(
            card,
            &["generatedFiles", "generated_files"],
            "generatedFiles",
            &id,
            errors,
        );
        cards.push(PlanTaskCardContract {
            id,
            owned_files,
            shared_files,
            has_generated_file_policy,
            has_report_contract,
            uses_deep_contract: card_uses_deep_contract,
        });
    }

    if uses_deep_contract {
        for card in &cards {
            if !card.has_report_contract {
                errors.push(format!(
                    "executablePlan.taskCards `{}`에는 reportContract 또는 reportFormat이 필요합니다.",
                    card.id
                ));
            }
            if !card.has_generated_file_policy {
                errors.push(format!(
                    "executablePlan.taskCards `{}`에는 generatedFilePolicy가 필요합니다.",
                    card.id
                ));
            }
        }
    }
    for graph_id in &graph_ids {
        if !card_ids.contains(graph_id) {
            errors.push(format!(
                "executablePlan.taskGraph `{graph_id}`에 대응하는 taskCard가 없습니다."
            ));
        }
    }
    for i in 0..cards.len() {
        for j in (i + 1)..cards.len() {
            let left = &cards[i];
            let right = &cards[j];
            if !left.uses_deep_contract && !right.uses_deep_contract {
                continue;
            }
            if !task_cards_are_parallel(&left.id, &right.id, &dependencies) {
                continue;
            }
            if let Some(path) = first_set_intersection(&left.owned_files, &right.owned_files) {
                errors.push(format!(
                    "parallel taskCards `{}`와 `{}`의 ownedFiles가 겹칩니다: {path}",
                    left.id, right.id
                ));
            }
            if let Some(path) = first_set_intersection(&left.shared_files, &right.owned_files) {
                errors.push(format!(
                    "taskCards `{}`의 sharedFiles가 병렬 task `{}`의 ownedFiles와 겹칩니다: {path}",
                    left.id, right.id
                ));
            }
            if let Some(path) = first_set_intersection(&right.shared_files, &left.owned_files) {
                errors.push(format!(
                    "taskCards `{}`의 sharedFiles가 병렬 task `{}`의 ownedFiles와 겹칩니다: {path}",
                    right.id, left.id
                ));
            }
        }
    }
}

fn plan_file_set(
    value: &Value,
    keys: &[&str],
    field_name: &str,
    card_id: &str,
    errors: &mut Vec<String>,
) -> BTreeSet<String> {
    let mut files = BTreeSet::new();
    for path in plan_string_list(value, keys) {
        if path.starts_with('/') || path.split('/').any(|part| part == "..") {
            errors.push(format!(
                "executablePlan.taskCards `{card_id}`의 {field_name} 경로는 repo-relative여야 합니다: {path}"
            ));
            continue;
        }
        files.insert(path);
    }
    files
}

fn task_cards_are_parallel(
    left: &str,
    right: &str,
    dependencies: &HashMap<String, BTreeSet<String>>,
) -> bool {
    let mut seen = BTreeSet::new();
    if has_dependency_path(left, right, dependencies, &mut seen) {
        return false;
    }
    seen.clear();
    !has_dependency_path(right, left, dependencies, &mut seen)
}

fn has_dependency_path(
    task_id: &str,
    dependency_id: &str,
    dependencies: &HashMap<String, BTreeSet<String>>,
    seen: &mut BTreeSet<String>,
) -> bool {
    if !seen.insert(task_id.to_string()) {
        return false;
    }
    let Some(depends_on) = dependencies.get(task_id) else {
        return false;
    };
    if depends_on.contains(dependency_id) {
        return true;
    }
    depends_on
        .iter()
        .any(|dependency| has_dependency_path(dependency, dependency_id, dependencies, seen))
}

fn first_set_intersection(left: &BTreeSet<String>, right: &BTreeSet<String>) -> Option<String> {
    left.intersection(right).next().cloned()
}

fn plan_validation_result(
    errors: Vec<String>,
    task_count: i64,
    task_graph_count: i64,
    barrier_count: i64,
    verification_gate_count: i64,
) -> CommandResult<PlanDraftValidationStats> {
    if !errors.is_empty() {
        return Err(CommandError::with_details(
            "ValidationFailed",
            "Plan Document executablePlan 검증에 실패했습니다.",
            errors.join("\n"),
        ));
    }
    Ok(PlanDraftValidationStats {
        validation: json!({
            "status": "valid",
            "checkedAt": now(),
            "errors": []
        }),
        task_count,
        task_graph_count,
        barrier_count,
        verification_gate_count,
    })
}

fn plan_field<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    let object = value.as_object()?;
    keys.iter().find_map(|key| object.get(*key))
}

fn plan_has_array(value: &Value, keys: &[&str]) -> bool {
    plan_field(value, keys).is_some_and(Value::is_array)
}

fn plan_has_field(value: &Value, keys: &[&str]) -> bool {
    plan_field(value, keys).is_some()
}

fn plan_array_values<'a>(value: &'a Value, keys: &[&str]) -> Vec<&'a Value> {
    plan_field(value, keys)
        .and_then(Value::as_array)
        .map(|items| items.iter().collect())
        .unwrap_or_default()
}

fn plan_array_len(value: &Value, keys: &[&str]) -> i64 {
    plan_field(value, keys)
        .and_then(Value::as_array)
        .map(|items| items.len() as i64)
        .unwrap_or(0)
}

fn plan_string_field(value: &Value, keys: &[&str]) -> Option<String> {
    plan_field(value, keys)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn plan_string_list(value: &Value, keys: &[&str]) -> Vec<String> {
    plan_field(value, keys)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn plan_draft_task_values(value: &Value) -> Vec<&Value> {
    if let Some(tasks) = plan_field(value, &["tasks"]).and_then(Value::as_array) {
        return tasks.iter().collect();
    }
    plan_field(value, &["epics"])
        .and_then(Value::as_array)
        .map(|epics| {
            epics
                .iter()
                .filter_map(|epic| plan_field(epic, &["tasks"]).and_then(Value::as_array))
                .flat_map(|tasks| tasks.iter())
                .collect()
        })
        .unwrap_or_default()
}

fn task_description_from_plan_draft(
    session: &PlanningSessionSummary,
    draft: &PlanDraftRevisionSummary,
    task: &Value,
) -> String {
    let mut lines = vec![
        draft.summary.clone(),
        String::new(),
        "Planning Goal".to_string(),
        session.goal_text.clone(),
        String::new(),
        "Description".to_string(),
        plan_string_field(task, &["description"])
            .unwrap_or_else(|| "planner가 제안한 실행 Task입니다.".to_string()),
    ];

    if let Some(copy_changes) = plan_field(task, &["copyChanges", "copy_changes"])
        .and_then(Value::as_array)
        .filter(|items| !items.is_empty())
    {
        lines.push(String::new());
        lines.push("Proposed Copy".to_string());
        for change in copy_changes {
            let location = plan_string_field(change, &["location", "target", "where"])
                .unwrap_or_else(|| "대상 UI 문구".to_string());
            lines.push(format!("- Location: {location}"));
            if let Some(current) = plan_string_field(change, &["currentText", "current_text"]) {
                lines.push(format!("  Current: {current}"));
            }
            if let Some(proposed) = plan_string_field(change, &["proposedText", "proposed_text"]) {
                lines.push(format!("  Proposed: {proposed}"));
            }
            if let Some(reason) = plan_string_field(change, &["reason", "why"]) {
                lines.push(format!("  Reason: {reason}"));
            }
        }
    }

    push_plan_section(
        &mut lines,
        "Subtasks",
        plan_string_list(task, &["subtasks", "subTasks", "sub_tasks"]),
    );
    push_plan_section(
        &mut lines,
        "Acceptance Criteria",
        plan_string_list(task, &["acceptanceCriteria", "acceptance_criteria"]),
    );
    push_plan_section(&mut lines, "Risks", plan_string_list(task, &["risks"]));
    push_plan_section(
        &mut lines,
        "Test Plan",
        plan_string_list(task, &["testPlan", "test_plan"]),
    );
    lines.push(String::new());
    lines.push(format!("Planner draft revision: {}", draft.revision));
    lines.join("\n")
}

fn push_plan_section(lines: &mut Vec<String>, title: &str, items: Vec<String>) {
    if items.is_empty() {
        return;
    }
    lines.push(String::new());
    lines.push(title.to_string());
    lines.extend(items.into_iter().map(|item| format!("- {item}")));
}

fn insert_planning_task_refs(
    conn: &Connection,
    project_id: &str,
    task_id: &str,
    session: &PlanningSessionSummary,
    draft: &PlanDraftRevisionSummary,
    draft_task: &Value,
) -> CommandResult<()> {
    let timestamp = now();
    if let Some(jira_ref) = session.jira_ref.as_deref() {
        conn.execute(
            "INSERT INTO task_external_refs (id, project_id, task_id, ref_type, ref_value, ref_title, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 'Jira reference', ?6)",
            params![
                new_id(),
                project_id,
                task_id,
                ref_type_for_jira_ref(jira_ref),
                jira_ref,
                timestamp
            ],
        )
        .map_err(|err| CommandError::database("계획 Task 외부 참조를 저장하지 못했습니다.", err))?;
    }
    let refs = [
        ("PlainText", session.goal_text.as_str(), "Planning goal"),
        (
            "PlainText",
            draft.id.as_str(),
            "Plan Document draft revision",
        ),
    ];
    for (ref_type, ref_value, ref_title) in refs {
        conn.execute(
            "INSERT INTO task_external_refs (id, project_id, task_id, ref_type, ref_value, ref_title, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                new_id(),
                project_id,
                task_id,
                ref_type,
                ref_value,
                ref_title,
                timestamp
            ],
        )
        .map_err(|err| CommandError::database("계획 Task 외부 참조를 저장하지 못했습니다.", err))?;
    }
    if let Some(task_key) = plan_string_field(draft_task, &["id", "taskId", "task_id"]) {
        conn.execute(
            "INSERT INTO task_external_refs (id, project_id, task_id, ref_type, ref_value, ref_title, created_at)
             VALUES (?1, ?2, ?3, 'PlainText', ?4, 'Executable plan task key', ?5)",
            params![new_id(), project_id, task_id, task_key, timestamp],
        )
        .map_err(|err| CommandError::database("계획 Task 외부 참조를 저장하지 못했습니다.", err))?;
    }
    Ok(())
}

fn ref_type_for_jira_ref(value: &str) -> &'static str {
    if value.contains("browse/") || value.starts_with("http") {
        "Url"
    } else {
        "JiraTask"
    }
}

fn validate_planning_jira_state(value: &str) -> CommandResult<()> {
    match value {
        "Linked" | "Missing" | "AlreadyTracked" => Ok(()),
        _ => Err(CommandError::validation(
            "계획 세션 Jira 상태 값이 올바르지 않습니다.",
        )),
    }
}

fn planning_title_from_goal(goal: &str) -> String {
    let trimmed = goal.trim();
    if trimmed.chars().count() <= 42 {
        return trimmed.to_string();
    }
    format!("{}...", trimmed.chars().take(42).collect::<String>())
}

fn planning_draft_artifact_path(session_id: &str, revision: i64) -> String {
    format!(".helm/planning/{session_id}/draft-v{revision}.md")
}

fn configured_obsidian_artifact_base_path(
    vault_path: &str,
    configured_path: Option<&str>,
) -> Option<PathBuf> {
    let configured = configured_path
        .map(str::trim)
        .filter(|path| !path.is_empty());
    match configured {
        Some(path) => {
            let candidate = PathBuf::from(path);
            if candidate.is_absolute() {
                Some(candidate)
            } else {
                Some(Path::new(vault_path).join(candidate))
            }
        }
        None => None,
    }
}

fn path_relative_to_base(path: &Path, base: &Path) -> String {
    path.strip_prefix(base)
        .unwrap_or(path)
        .to_string_lossy()
        .to_string()
}

fn write_obsidian_plan_artifact(
    conn: &Connection,
    project_id: &str,
    session_id: &str,
    revision: i64,
    title: &str,
    timestamp: &str,
    helm_artifact_path: &str,
    content_hash: &str,
    plan_markdown: &str,
) -> CommandResult<Option<String>> {
    let settings = effective_settings(conn, project_id)?;
    let Some(vault_path) = settings
        .obsidian_vault_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
    else {
        return Ok(None);
    };
    let project = get_project(conn, project_id)?;
    let date = timestamp.split('T').next().unwrap_or("unknown-date");
    let session_short = session_id.chars().take(8).collect::<String>();
    let file_name = format!(
        "{}-{}-{}-draft-v{}.md",
        date,
        slug_for_path(title),
        session_short,
        revision
    );
    let relative_path = PathBuf::from("projects")
        .join(slug_for_path(&project.name))
        .join("desktop")
        .join("plans")
        .join(&file_name);
    let configured_base = configured_obsidian_artifact_base_path(
        vault_path,
        settings.obsidian_artifact_path.as_deref(),
    );
    let path = configured_base
        .as_ref()
        .map(|base| {
            base.join(slug_for_path(&project.name))
                .join("desktop")
                .join("plans")
                .join(&file_name)
        })
        .unwrap_or_else(|| Path::new(vault_path).join(&relative_path));
    let parent = path.parent().ok_or_else(|| {
        CommandError::validation("Obsidian Plan Document 경로가 올바르지 않습니다.")
    })?;
    fs::create_dir_all(parent)
        .map_err(|err| CommandError::io("Obsidian Plan Document 폴더를 만들지 못했습니다.", err))?;
    let content = format!(
        "---\n\
         date: {timestamp}\n\
         project: {}\n\
         app: desktop\n\
         title: {}\n\
         status: draft\n\
         helmSessionId: {session_id}\n\
         helmDraftRevision: {revision}\n\
         helmArtifactPath: {helm_artifact_path}\n\
         contentHash: {content_hash}\n\
         ---\n\n\
         {plan_markdown}\n",
        project.name,
        title.replace('\n', " ")
    );
    let tmp_path = path.with_extension("md.tmp");
    fs::write(&tmp_path, content)
        .map_err(|err| CommandError::io("Obsidian Plan Document를 저장하지 못했습니다.", err))?;
    fs::rename(&tmp_path, &path)
        .map_err(|err| CommandError::io("Obsidian Plan Document를 교체하지 못했습니다.", err))?;
    Ok(Some(
        configured_base
            .as_ref()
            .map(|base| path_relative_to_base(&path, base))
            .unwrap_or_else(|| relative_path.to_string_lossy().to_string()),
    ))
}

fn write_obsidian_run_artifact(
    conn: &Connection,
    project_id: &str,
    task: &TaskSummary,
    run: &AgentRunSummary,
    final_status: &str,
    result_status: Option<&str>,
    changed_file_count: usize,
    finished_at: &str,
    summary: &str,
    role_dossier: Option<&str>,
) -> CommandResult<Option<String>> {
    let settings = effective_settings(conn, project_id)?;
    let Some(vault_path) = settings
        .obsidian_vault_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
    else {
        return Ok(None);
    };
    let project = get_project(conn, project_id)?;
    let date = finished_at.split('T').next().unwrap_or("unknown-date");
    let run_short = run.id.chars().take(8).collect::<String>();
    let file_name = format!(
        "{}-{}-{}-{}.md",
        date,
        slug_for_path(&task.title),
        run_short,
        slug_for_path(&run.role_id)
    );
    let relative_path = PathBuf::from("projects")
        .join(slug_for_path(&project.name))
        .join("desktop")
        .join("sessions")
        .join(&file_name);
    let configured_base = configured_obsidian_artifact_base_path(
        vault_path,
        settings.obsidian_artifact_path.as_deref(),
    );
    let path = configured_base
        .as_ref()
        .map(|base| {
            base.join(slug_for_path(&project.name))
                .join("desktop")
                .join("sessions")
                .join(&file_name)
        })
        .unwrap_or_else(|| Path::new(vault_path).join(&relative_path));
    let parent = path
        .parent()
        .ok_or_else(|| CommandError::validation("Obsidian 실행 문서 경로가 올바르지 않습니다."))?;
    fs::create_dir_all(parent)
        .map_err(|err| CommandError::io("Obsidian 실행 문서 폴더를 만들지 못했습니다.", err))?;
    let summary = if summary.trim().is_empty() {
        "_요약 없음_"
    } else {
        summary.trim()
    };
    let role_dossier = role_dossier
        .map(str::trim)
        .filter(|content| !content.is_empty())
        .unwrap_or("_역할별 md 산출물 없음_");
    let content = format!(
        "---\n\
         date: {finished_at}\n\
         project: {}\n\
         app: desktop\n\
         title: {}\n\
         status: {final_status}\n\
         resultStatus: {}\n\
         helmTaskId: {}\n\
         helmRunId: {}\n\
         roleId: {}\n\
         helmArtifactPath: {}\n\
         changedFileCount: {changed_file_count}\n\
         ---\n\n\
         # {}\n\n\
         ## 실행 요약\n\n\
         {summary}\n\n\
         ## 역할별 산출물\n\n\
         {role_dossier}\n",
        project.name,
        task.title.replace('\n', " "),
        result_status.unwrap_or("-"),
        task.id,
        run.id,
        run.role_id,
        run.artifact_dir,
        task.title
    );
    let tmp_path = path.with_extension("md.tmp");
    fs::write(&tmp_path, content)
        .map_err(|err| CommandError::io("Obsidian 실행 문서를 저장하지 못했습니다.", err))?;
    fs::rename(&tmp_path, &path)
        .map_err(|err| CommandError::io("Obsidian 실행 문서를 교체하지 못했습니다.", err))?;
    Ok(Some(
        configured_base
            .as_ref()
            .map(|base| path_relative_to_base(&path, base))
            .unwrap_or_else(|| relative_path.to_string_lossy().to_string()),
    ))
}

fn slug_for_path(value: &str) -> String {
    let mut slug = String::new();
    let mut previous_dash = false;
    for ch in value.trim().chars() {
        if ch.is_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
            previous_dash = false;
        } else if !previous_dash && !slug.is_empty() {
            slug.push('-');
            previous_dash = true;
        }
        if slug.chars().count() >= 48 {
            break;
        }
    }
    let trimmed = slug.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "plan".to_string()
    } else {
        trimmed
    }
}

fn write_planning_artifact(root: &Path, relative_path: &str, content: &str) -> CommandResult<()> {
    validate_relative_artifact_path(relative_path)?;
    let path = root.join(relative_path);
    let parent = path.parent().ok_or_else(|| {
        CommandError::validation("Plan Document artifact 경로가 올바르지 않습니다.")
    })?;
    fs::create_dir_all(parent)
        .map_err(|err| CommandError::io("Plan Document artifact 폴더를 만들지 못했습니다.", err))?;
    let tmp_path = path.with_extension("md.tmp");
    fs::write(&tmp_path, content)
        .map_err(|err| CommandError::io("Plan Document artifact를 저장하지 못했습니다.", err))?;
    fs::rename(&tmp_path, &path)
        .map_err(|err| CommandError::io("Plan Document artifact를 교체하지 못했습니다.", err))?;
    Ok(())
}

fn stable_content_hash(content: &str) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in content.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("fnv1a64:{hash:016x}")
}

fn plan_markdown_from_draft_json(draft: &Value, goal_text: &str) -> String {
    let title = plan_string_field(draft, &["title"]).unwrap_or_else(|| "Plan Document".to_string());
    let summary = plan_string_field(draft, &["summary"]).unwrap_or_default();
    let mut lines = vec![
        format!("# {title}"),
        String::new(),
        summary,
        String::new(),
        "## Goal".to_string(),
        goal_text.to_string(),
        String::new(),
        "## Tasks".to_string(),
    ];
    for (index, task) in plan_draft_task_values(draft).iter().enumerate() {
        let task_title =
            plan_string_field(task, &["title"]).unwrap_or_else(|| format!("Task {}", index + 1));
        lines.push(format!("{}. {}", index + 1, task_title));
    }
    lines.join("\n")
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

pub fn get_task(conn: &Connection, id: &str) -> CommandResult<TaskSummary> {
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

/// The merge PR opened for a task, if one was already created. Returns (url, number).
/// PRs are stored as a `ref_type='Url'` external ref titled `PullRequest #<n>`.
pub fn find_pr_ref(conn: &Connection, task_id: &str) -> CommandResult<Option<(String, i64)>> {
    let row = conn
        .query_row(
            "SELECT ref_value, ref_title FROM task_external_refs
             WHERE task_id = ?1 AND ref_type = 'Url' AND ref_title LIKE 'PullRequest %'
             ORDER BY created_at DESC LIMIT 1",
            params![task_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|err| CommandError::database("PR 참조를 읽지 못했습니다.", err))?;
    Ok(row.and_then(|(url, title)| {
        title
            .trim_start_matches("PullRequest #")
            .trim()
            .parse::<i64>()
            .ok()
            .map(|number| (url, number))
    }))
}

/// MergeWaiting 상태이면서 PR 참조가 달린 (task_id, pr_number) 목록.
/// 외부 머지 감지 폴링이 GitHub와 대조할 후보다.
pub fn tasks_awaiting_merge_with_pr(
    conn: &Connection,
    project_id: &str,
) -> CommandResult<Vec<(String, i64)>> {
    let mut stmt = conn
        .prepare(
            "SELECT t.id, r.ref_title FROM tasks t
             JOIN task_external_refs r ON r.task_id = t.id
             WHERE t.project_id = ?1 AND t.status = 'MergeWaiting'
               AND r.ref_type = 'Url' AND r.ref_title LIKE 'PullRequest %'",
        )
        .map_err(|err| CommandError::database("머지 대기 태스크를 조회하지 못했습니다.", err))?;
    let rows = stmt
        .query_map(params![project_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|err| CommandError::database("머지 대기 태스크를 조회하지 못했습니다.", err))?;
    let mut out = Vec::new();
    for row in rows {
        let (task_id, title) =
            row.map_err(|err| CommandError::database("머지 대기 태스크를 조회하지 못했습니다.", err))?;
        if let Ok(number) = title.trim_start_matches("PullRequest #").trim().parse::<i64>() {
            out.push((task_id, number));
        }
    }
    Ok(out)
}

pub fn insert_pr_ref(
    conn: &Connection,
    project_id: &str,
    task_id: &str,
    url: &str,
    number: i64,
) -> CommandResult<()> {
    conn.execute(
        "INSERT INTO task_external_refs (id, project_id, task_id, ref_type, ref_value, ref_title, created_at)
         VALUES (?1, ?2, ?3, 'Url', ?4, ?5, ?6)",
        params![
            new_id(),
            project_id,
            task_id,
            url,
            format!("PullRequest #{number}"),
            now()
        ],
    )
    .map_err(|err| CommandError::database("PR 참조를 저장하지 못했습니다.", err))?;
    Ok(())
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

fn append_run_event(
    conn: &Connection,
    project_id: &str,
    task_id: &str,
    run_id: &str,
    kind: &str,
    message: &str,
    payload: Value,
) -> CommandResult<RunEventSummary> {
    if !matches!(
        kind,
        "status" | "stdout" | "stderr" | "artifact" | "result" | "approval" | "system"
    ) {
        return Err(CommandError::validation(
            "허용되지 않은 실행 이벤트 종류입니다.",
        ));
    }

    let seq: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(seq), 0) + 1 FROM run_events WHERE run_id = ?1",
            params![run_id],
            |row| row.get(0),
        )
        .map_err(|err| CommandError::database("실행 이벤트 순서를 만들지 못했습니다.", err))?;
    let id = new_id();
    let timestamp = now();
    conn.execute(
        "INSERT INTO run_events (
           id, project_id, task_id, run_id, seq, kind, message, payload_json, created_at
         )
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            id,
            project_id,
            task_id,
            run_id,
            seq,
            kind,
            message,
            payload.to_string(),
            timestamp
        ],
    )
    .map_err(|err| CommandError::database("실행 이벤트를 저장하지 못했습니다.", err))?;
    conn.execute(
        "UPDATE agent_runs
         SET heartbeat_at = ?1, updated_at = ?1
         WHERE id = ?2 AND project_id = ?3 AND status = 'Running'",
        params![timestamp, run_id, project_id],
    )
    .map_err(|err| CommandError::database("실행 heartbeat를 저장하지 못했습니다.", err))?;

    Ok(RunEventSummary {
        id,
        project_id: project_id.to_string(),
        task_id: task_id.to_string(),
        run_id: run_id.to_string(),
        seq,
        kind: kind.to_string(),
        message: message.to_string(),
        payload,
        created_at: timestamp,
    })
}

fn append_and_emit_run_event(
    conn: &Connection,
    project_id: &str,
    task_id: &str,
    run_id: &str,
    kind: &str,
    message: &str,
    payload: Value,
    event_sink: &mut Option<&mut dyn FnMut(&RunEventSummary)>,
) -> CommandResult<RunEventSummary> {
    let event = append_run_event(conn, project_id, task_id, run_id, kind, message, payload)?;
    if let Some(sink) = event_sink.as_deref_mut() {
        sink(&event);
    }
    Ok(event)
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

/// 리뷰 단계 역할(코드 리뷰어)은 읽기 위주이므로 실행 승인 없이 진행시킨다.
fn is_review_role(role_id: &str) -> bool {
    matches!(role_id, "code_reviewer")
}

fn role_policy_role_ids() -> [&'static str; 5] {
    [
        "planner",
        "coder",
        "plan_verifier",
        "code_reviewer",
        "tester",
    ]
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
    let compact_id = task_id
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .collect::<String>();
    let short_id = compact_id
        .chars()
        .rev()
        .take(12)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<String>();
    let short_id = if short_id.is_empty() {
        task_id.chars().take(8).collect::<String>()
    } else {
        short_id
    };
    format!("{prefix}-{short_id}")
}

/// 태스크의 worktree 모드를 읽는다("current_branch" | "worktree").
fn task_worktree_mode(conn: &Connection, task_id: &str) -> CommandResult<String> {
    conn.query_row(
        "SELECT worktree_mode FROM tasks WHERE id = ?1",
        params![task_id],
        |row| row.get::<_, String>(0),
    )
    .map_err(|err| CommandError::database("태스크 worktree 모드를 읽지 못했습니다.", err))
}

/// in-place 작업을 직접 올리면 안 되는 보호 브랜치. ponytail: 고정 목록, 설정화는 필요해지면.
fn is_protected_branch(branch: &str) -> bool {
    matches!(branch, "main" | "master" | "develop")
}

/// current_branch 모드: 새 worktree 없이 프로젝트 root(현재 브랜치)를 가리키는 task_worktrees
/// 행을 등록한다. HEAD가 보호 브랜치면 그 위에서 새 feature 브랜치를 만들어 체크아웃한다.
fn register_inplace_worktree(
    conn: &mut Connection,
    root: &Path,
    project_id: &str,
    task: &TaskSummary,
) -> CommandResult<TaskWorktreeSummary> {
    let current = git::current_branch(root).ok_or_else(|| {
        CommandError::validation(
            "현재 체크아웃된 브랜치를 찾을 수 없습니다(detached HEAD). 워크트리 모드로 시작해주세요.",
        )
    })?;
    let base_branch = current.clone();
    let created_branch = is_protected_branch(&current);
    let branch_name = if created_branch {
        let slug = task_slug(&task.title, &task.id);
        let new_branch = unique_task_branch(root, &slug)?;
        git::create_and_checkout_branch(root, &new_branch)?;
        new_branch
    } else {
        current
    };

    let id = new_id();
    let timestamp = now();
    let root_text = root.to_string_lossy().to_string();
    let head_hash = git::head_hash(root);
    conn.execute(
        "INSERT INTO task_worktrees (
           id, project_id, task_id, branch_name, worktree_path, base_branch, head_hash,
           status, created_at, updated_at
         )
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'Active', ?8, ?8)",
        params![
            id,
            project_id,
            task.id,
            branch_name.as_str(),
            root_text.as_str(),
            base_branch.as_str(),
            head_hash,
            timestamp
        ],
    )
    .map_err(|err| CommandError::database("태스크 worktree를 저장하지 못했습니다.", err))?;
    insert_audit(
        conn,
        project_id,
        "Task",
        Some(&task.id),
        "task_worktree.inplace_registered",
        json!({
            "taskId": task.id,
            "worktreePath": root_text,
            "branchName": branch_name,
            "baseBranch": base_branch,
            "createdBranch": created_branch
        }),
    )?;
    get_task_worktree(conn, project_id, &task.id)?
        .ok_or_else(|| CommandError::validation("태스크 worktree를 찾을 수 없습니다."))
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

fn has_role_run(
    conn: &Connection,
    project_id: &str,
    task_id: &str,
    role_id: &str,
) -> CommandResult<bool> {
    let exists: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM agent_runs
             WHERE project_id = ?1 AND task_id = ?2 AND role_id = ?3
             LIMIT 1",
            params![project_id, task_id, role_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| CommandError::database("role 실행 이력을 확인하지 못했습니다.", err))?;
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
        (
            // 역할별 handoff dossier(plan.md/pr-dossier.md 등). finalize_host_run의 dossier
            // 게이트가 이 파일을 요구하므로 runner 명령 템플릿이 {dossierPath}로 참조할 수 있게 한다.
            "dossierPath".to_string(),
            artifact_dir
                .join(role_dossier_artifact_name(&run.role_id))
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
    env: Vec<(String, String)>,
    timeout_seconds: u64,
    provider: Option<String>,
    connection_id: Option<String>,
    model: Option<String>,
    runner_adapter: RunnerAdapterKind,
    approval_policy: Option<String>,
    sandbox: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RunnerAdapterKind {
    Process,
    CodexAppServer,
}

fn resolve_host_runner_command(
    settings: &EffectiveSettings,
    role_id: &str,
    pinned_connection_id: Option<&str>,
    placeholders: &HashMap<String, String>,
) -> CommandResult<ResolvedHostRunnerCommand> {
    if let Some(command) =
        role_assignment_command(settings, role_id, pinned_connection_id, placeholders)?
    {
        return Ok(command);
    }

    Ok(ResolvedHostRunnerCommand {
        args: role_command_args(&settings.role_presets, role_id, placeholders)?,
        env: Vec::new(),
        timeout_seconds: role_timeout_seconds(&settings.role_presets, role_id),
        provider: None,
        connection_id: None,
        model: None,
        runner_adapter: RunnerAdapterKind::Process,
        approval_policy: None,
        sandbox: None,
    })
}

// 연결의 commandArgs 템플릿이 {dossierPath}를 참조하지 않으면(과거 기본값/사용자 커스텀
// 템플릿, app-settings↔project_settings 드리프트 등), agent는 역할 dossier md를 쓰지 않아
// finalize의 dossier 게이트가 항상 막힌다. 해석된 명령 어디에도 dossier 경로가 없으면
// 마지막(프롬프트) 인자에 작성 지시를 보강한다.
// ponytail: 마지막 인자=프롬프트 가정(claude -p / codex exec -- / antigravity chat 모두 해당).
//           프롬프트가 마지막이 아닌 CLI를 쓰게 되면 그때 위치 지정 로직을 추가한다.
fn ensure_dossier_instruction(
    mut args: Vec<String>,
    placeholders: &HashMap<String, String>,
) -> Vec<String> {
    let Some(dossier_path) = placeholders.get("dossierPath") else {
        return args;
    };
    if args.iter().any(|arg| arg.contains(dossier_path.as_str())) {
        return args;
    }
    if let Some(last) = args.last_mut() {
        last.push_str(&format!(
            " Also write the role dossier markdown at {dossier_path}; Helm requires it as the role handoff record."
        ));
    }
    args
}

fn role_assignment_command(
    settings: &EffectiveSettings,
    role_id: &str,
    pinned_connection_id: Option<&str>,
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

    // 멀티 리뷰어처럼 run에 connection이 고정(pin)된 경우 해당 selection을 사용하고,
    // 그렇지 않으면 기존처럼 첫 번째 selection을 사용한다.
    let selection = match pinned_connection_id {
        Some(connection_id) => role_selection_for_connection(assignment, connection_id),
        None => first_role_selection(assignment),
    };
    let Some(selection) = selection else {
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
    let args = ensure_dossier_instruction(args, placeholders);
    let provider = connection
        .get("provider")
        .and_then(Value::as_str)
        .map(str::to_string);
    let runner_adapter = runner_adapter_kind(connection, provider.as_deref());
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
        args: inject_provider_options(
            args,
            provider.as_deref(),
            model.as_deref(),
            effort,
            placeholders,
        ),
        env: connection_env(connection),
        timeout_seconds: connection
            .get("timeoutSeconds")
            .and_then(Value::as_u64)
            .unwrap_or_else(|| role_timeout_seconds(&settings.role_presets, role_id))
            .clamp(1, 21600),
        provider,
        connection_id: Some(connection_id.to_string()),
        model,
        runner_adapter,
        approval_policy: optional_connection_string(connection, "approvalPolicy"),
        sandbox: optional_connection_string(connection, "sandbox"),
    }))
}

fn runner_adapter_kind(connection: &Value, provider: Option<&str>) -> RunnerAdapterKind {
    match connection
        .get("runnerAdapter")
        .and_then(Value::as_str)
        .unwrap_or("process")
    {
        "codex_app_server" if provider == Some("codex") => RunnerAdapterKind::CodexAppServer,
        _ => RunnerAdapterKind::Process,
    }
}

fn optional_connection_string(connection: &Value, key: &str) -> Option<String> {
    connection
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
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

fn apply_connection_env(command: &mut Command, env_overrides: &[(String, String)]) {
    for (key, value) in env_overrides {
        command.env(key, value);
    }
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

/// 특정 connection에 고정된(pinned) run을 위한 selection을 찾는다.
/// 일치하는 selection이 없으면 connectionId만 가진 최소 selection을 합성한다.
fn role_selection_for_connection(assignment: &Value, connection_id: &str) -> Option<Value> {
    assignment
        .get("selections")
        .and_then(Value::as_array)
        .and_then(|items| {
            items.iter().find(|item| {
                item.get("connectionId").and_then(Value::as_str) == Some(connection_id)
            })
        })
        .cloned()
        .or_else(|| Some(json!({ "connectionId": connection_id })))
}

/// 한 role에 배정된 connection id를 selections 순서대로 반환한다(legacy connectionIds 폴백 포함).
/// 멀티 리뷰어 순차 실행과 all_pass 집계의 기준 목록이 된다.
fn role_connection_ids(settings: &EffectiveSettings, role_id: &str) -> Vec<String> {
    let Some(assignment) = settings.role_assignments.as_array().and_then(|items| {
        items
            .iter()
            .find(|item| item.get("roleId").and_then(Value::as_str) == Some(role_id))
    }) else {
        return Vec::new();
    };
    if let Some(items) = assignment.get("selections").and_then(Value::as_array) {
        let ids: Vec<String> = items
            .iter()
            .filter_map(|item| item.get("connectionId").and_then(Value::as_str))
            .map(str::to_string)
            .collect();
        if !ids.is_empty() {
            return ids;
        }
    }
    assignment
        .get("connectionIds")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// 멀티 리뷰어(연결 2개 이상) role에서 아직 실행되지 않은 다음 connection을 고른다.
/// 단일 연결 role은 None을 반환해 기존 first_role_selection 동작을 그대로 유지한다.
fn pick_pending_role_connection(
    conn: &Connection,
    project_id: &str,
    task_id: &str,
    role_id: &str,
    settings: &EffectiveSettings,
) -> CommandResult<Option<String>> {
    let connection_ids = role_connection_ids(settings, role_id);
    if connection_ids.len() < 2 {
        return Ok(None);
    }
    let mut done: HashSet<String> = HashSet::new();
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT connection_id FROM agent_runs
             WHERE project_id = ?1 AND task_id = ?2 AND role_id = ?3
               AND connection_id IS NOT NULL",
        )
        .map_err(|err| CommandError::database("리뷰어 실행 이력을 확인하지 못했습니다.", err))?;
    let rows = stmt
        .query_map(params![project_id, task_id, role_id], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|err| CommandError::database("리뷰어 실행 이력을 확인하지 못했습니다.", err))?;
    for row in rows {
        done.insert(row.map_err(|err| {
            CommandError::database("리뷰어 실행 이력을 확인하지 못했습니다.", err)
        })?);
    }
    Ok(connection_ids.into_iter().find(|id| !done.contains(id)))
}

/// 한 role에서 통과(Succeeded·pass)한 서로 다른 connection 수를 센다. all_pass 집계용.
fn count_passed_role_connections(
    conn: &Connection,
    project_id: &str,
    task_id: &str,
    role_id: &str,
) -> CommandResult<usize> {
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(DISTINCT connection_id) FROM agent_runs
             WHERE project_id = ?1 AND task_id = ?2 AND role_id = ?3
               AND status = 'Succeeded' AND result_status = 'pass'
               AND connection_id IS NOT NULL",
            params![project_id, task_id, role_id],
            |row| row.get(0),
        )
        .map_err(|err| CommandError::database("리뷰어 통과 수를 확인하지 못했습니다.", err))?;
    Ok(count as usize)
}

/// code_reviewer selections 중 decider=true로 지정된 connectionId를 반환한다.
/// 지정된 결정권자가 없으면 None을 반환해 기존 all_pass 동작을 유지한다(opt-in).
fn decider_connection_id(settings: &EffectiveSettings, role_id: &str) -> Option<String> {
    let assignment = settings
        .role_assignments
        .as_array()?
        .iter()
        .find(|item| item.get("roleId").and_then(Value::as_str) == Some(role_id))?;
    assignment
        .get("selections")
        .and_then(Value::as_array)?
        .iter()
        .find(|item| item.get("decider").and_then(Value::as_bool) == Some(true))
        .and_then(|item| item.get("connectionId").and_then(Value::as_str))
        .map(str::to_string)
}

/// 특정 connection이 해당 role에서 통과(Succeeded·pass)했는지 본다. 결정권자 게이트용.
fn connection_passed_role(
    conn: &Connection,
    project_id: &str,
    task_id: &str,
    role_id: &str,
    connection_id: &str,
) -> CommandResult<bool> {
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM agent_runs
             WHERE project_id = ?1 AND task_id = ?2 AND role_id = ?3
               AND connection_id = ?4
               AND status = 'Succeeded' AND result_status = 'pass'",
            params![project_id, task_id, role_id, connection_id],
            |row| row.get(0),
        )
        .map_err(|err| CommandError::database("결정권자 통과 여부를 확인하지 못했습니다.", err))?;
    Ok(count > 0)
}

fn inject_provider_options(
    args: Vec<String>,
    provider: Option<&str>,
    model: Option<&str>,
    effort: Option<&str>,
    placeholders: &HashMap<String, String>,
) -> Vec<String> {
    let normalized_model = model.map(|value| normalized_provider_model(provider, value));
    let with_model = match (provider, normalized_model.as_deref()) {
        (Some("codex"), Some(model)) if !has_arg(&args, &["-m", "--model"]) => {
            insert_after_command(args, "exec", ["-m".to_string(), model.to_string()])
        }
        (Some("claude"), Some(model)) if !has_arg(&args, &["--model"]) => {
            insert_after_index(args, 0, ["--model".to_string(), model.to_string()])
        }
        (Some("gemini"), Some(model)) if !has_arg(&args, &["-m", "--model"]) => {
            insert_after_index(args, 0, ["--model".to_string(), model.to_string()])
        }
        _ => args,
    };

    let with_effort = match (provider, effort) {
        (Some("claude"), Some(effort)) if !has_arg(&with_model, &["--effort"]) => {
            insert_after_index(with_model, 0, ["--effort".to_string(), effort.to_string()])
        }
        _ => with_model,
    };

    let with_permissions = match provider {
        Some("claude")
            if !has_arg(&with_effort, &["--permission-mode"])
                && !has_arg(&with_effort, &["--dangerously-skip-permissions"]) =>
        {
            insert_after_index(
                with_effort,
                0,
                [
                    "--permission-mode".to_string(),
                    "bypassPermissions".to_string(),
                ],
            )
        }
        _ => with_effort,
    };

    match (provider, placeholders.get("artifactDir")) {
        (Some("claude"), Some(artifact_dir)) if !has_arg(&with_permissions, &["--add-dir"]) => {
            insert_after_index(
                with_permissions,
                0,
                ["--add-dir".to_string(), artifact_dir.to_string()],
            )
        }
        (Some("gemini"), Some(artifact_dir))
            if !has_arg(&with_permissions, &["--include-directories"]) =>
        {
            insert_after_index(
                with_permissions,
                0,
                [
                    "--include-directories".to_string(),
                    artifact_dir.to_string(),
                ],
            )
        }
        _ => with_permissions,
    }
}

fn normalized_provider_model(provider: Option<&str>, model: &str) -> String {
    if provider != Some("claude") {
        return model.to_string();
    }
    match model {
        "claude-sonnet-4.6" => "claude-sonnet-4-6".to_string(),
        "claude-opus-4.8" => "claude-opus-4-8".to_string(),
        _ => model.to_string(),
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

fn runner_adapter_label(kind: RunnerAdapterKind) -> &'static str {
    match kind {
        RunnerAdapterKind::Process => "process",
        RunnerAdapterKind::CodexAppServer => "codex_app_server",
    }
}

fn resolve_command_args(cwd: &Path, args: &[String]) -> Vec<String> {
    let Some(program) = args.first() else {
        return Vec::new();
    };
    let mut resolved = args.to_vec();
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
    command_search_dirs()
        .map(|dir| dir.join(program))
        .find(|candidate| candidate.is_file())
        .or_else(|| resolve_cli_binary_from_login_shell(program))
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

fn write_runner_request(
    artifact_path: &Path,
    cwd: &str,
    command_args: &[String],
    runner_command: &ResolvedHostRunnerCommand,
) -> CommandResult<()> {
    let setup_config_path = artifact_path.join("worktree-setup.json");
    let setup_config_path = setup_config_path
        .exists()
        .then(|| setup_config_path.to_string_lossy().to_string());
    fs::write(
        artifact_path.join("runner-request.json"),
        serde_json::to_string_pretty(&json!({
            "schemaVersion": 1,
            "adapter": runner_adapter_label(runner_command.runner_adapter),
            "provider": runner_command.provider,
            "connectionId": runner_command.connection_id,
            "model": runner_command.model,
            "approvalPolicy": runner_command.approval_policy,
            "sandbox": runner_command.sandbox,
            "envKeys": runner_command.env.iter().map(|(key, _)| key).collect::<Vec<_>>(),
            "setupConfigPath": setup_config_path,
            "command": command_args,
            "cwd": cwd
        }))
        .map_err(|err| CommandError::io("runner request를 만들지 못했습니다.", err))?,
    )
    .map_err(|err| CommandError::io("runner request를 저장하지 못했습니다.", err))
}

enum CodexAppServerOutput {
    StdoutLine(String),
    Stderr(Vec<u8>),
}

fn run_codex_app_server_role(
    conn: &mut Connection,
    project_id: &str,
    run: &AgentRunSummary,
    worktree_path: &str,
    artifact_path: &Path,
    command_args: &[String],
    runner_command: &ResolvedHostRunnerCommand,
    timeout_seconds: u64,
    cancellation: Arc<AtomicBool>,
    event_sink: &mut Option<&mut dyn FnMut(&RunEventSummary)>,
) -> CommandResult<HostCommandOutput> {
    let server_args = codex_app_server_command_args(command_args);
    let Some(program) = server_args.first() else {
        return Err(CommandError::validation(
            "Codex app-server command가 비어 있습니다.",
        ));
    };
    let mut command = Command::new(program);
    command
        .args(&server_args[1..])
        .current_dir(worktree_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_connection_env(&mut command, &runner_command.env);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // 새 프로세스 그룹으로 띄운다(자식 PID == PGID). codex app-server가 분리되어 살아남더라도
        // teardown/세션 삭제에서 그룹째 kill해 MCP 서브트리까지 함께 정리할 수 있다.
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|err| CommandError::io("Codex app-server를 실행하지 못했습니다.", err))?;
    // host_pid(=PGID)를 즉시 저장한다 → 세션 삭제/재시작 정리가 이 그룹을 찾아 종료할 수 있다.
    // finalize_host_run이 정상 종료 시 host_pid를 다시 NULL로 되돌린다.
    let host_pid = child.id();
    conn.execute(
        "UPDATE agent_runs SET host_pid = ?1, updated_at = ?2 WHERE id = ?3",
        params![host_pid, now(), run.id],
    )
    .map_err(|err| CommandError::database("Codex host run PID를 저장하지 못했습니다.", err))?;
    let mut stdin = child.stdin.take().ok_or_else(|| {
        CommandError::new("IoFailed", "Codex app-server stdin을 열지 못했습니다.")
    })?;
    let stdout = child.stdout.take().ok_or_else(|| {
        CommandError::new("IoFailed", "Codex app-server stdout을 열지 못했습니다.")
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        CommandError::new("IoFailed", "Codex app-server stderr를 열지 못했습니다.")
    })?;
    let (sender, receiver) = mpsc::channel();
    let stdout_reader = spawn_codex_json_line_reader(stdout, sender.clone());
    let stderr_reader = spawn_codex_stderr_reader(stderr, sender);
    let deadline = Instant::now() + Duration::from_secs(timeout_seconds);
    let mut stdout_log = Vec::new();
    let mut stderr_log = Vec::new();
    let mut next_id = 1_i64;

    let init_id = codex_rpc_send_request(
        &mut stdin,
        &mut next_id,
        "initialize",
        json!({
            "clientInfo": { "name": "Helm", "title": "Helm", "version": env!("CARGO_PKG_VERSION") },
            "capabilities": { "experimentalApi": true }
        }),
    )?;
    let _ = codex_rpc_wait_for_response(CodexRpcWait {
        conn,
        project_id,
        run,
        stdin: &mut stdin,
        child: &mut child,
        receiver: &receiver,
        stdout_log: &mut stdout_log,
        stderr_log: &mut stderr_log,
        event_sink,
        deadline,
        cancellation: cancellation.clone(),
        target_id: init_id,
    })?;
    codex_rpc_send_notification(&mut stdin, "initialized", json!({}))?;

    let thread_id = codex_rpc_send_request(
        &mut stdin,
        &mut next_id,
        "thread/start",
        codex_thread_start_params(worktree_path, runner_command),
    )?;
    let thread_response = codex_rpc_wait_for_response(CodexRpcWait {
        conn,
        project_id,
        run,
        stdin: &mut stdin,
        child: &mut child,
        receiver: &receiver,
        stdout_log: &mut stdout_log,
        stderr_log: &mut stderr_log,
        event_sink,
        deadline,
        cancellation: cancellation.clone(),
        target_id: thread_id,
    })?;
    let thread_id = thread_response
        .get("thread")
        .and_then(|value| value.get("id"))
        .and_then(Value::as_str)
        .ok_or_else(|| {
            CommandError::with_details(
                "RunnerFailed",
                "Codex app-server thread/start 응답에서 thread id를 찾지 못했습니다.",
                thread_response.to_string(),
            )
        })?
        .to_string();

    let prompt = codex_app_server_role_prompt(artifact_path, run);
    fs::write(artifact_path.join("codex-prompt.txt"), &prompt)
        .map_err(|err| CommandError::io("Codex prompt를 저장하지 못했습니다.", err))?;
    let turn_id = codex_rpc_send_request(
        &mut stdin,
        &mut next_id,
        "turn/start",
        codex_turn_start_params(&thread_id, &prompt, runner_command),
    )?;
    let _ = codex_rpc_wait_for_response(CodexRpcWait {
        conn,
        project_id,
        run,
        stdin: &mut stdin,
        child: &mut child,
        receiver: &receiver,
        stdout_log: &mut stdout_log,
        stderr_log: &mut stderr_log,
        event_sink,
        deadline,
        cancellation: cancellation.clone(),
        target_id: turn_id,
    })?;

    let mut turn_failed = false;
    loop {
        if cancellation.load(Ordering::SeqCst) {
            let _ = child.kill();
            break;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            break;
        }
        match codex_recv_message(&receiver, &mut child, deadline, cancellation.clone())? {
            Some(CodexAppServerOutput::Stderr(bytes)) => {
                stderr_log.extend_from_slice(&bytes);
                emit_host_output_event(conn, project_id, run, "stderr", &bytes, event_sink);
            }
            Some(CodexAppServerOutput::StdoutLine(line)) => {
                let outcome = codex_handle_rpc_line(CodexRpcLine {
                    conn,
                    project_id,
                    run,
                    stdin: &mut stdin,
                    line: &line,
                    stdout_log: &mut stdout_log,
                    stderr_log: &mut stderr_log,
                    event_sink,
                    deadline,
                    cancellation: cancellation.clone(),
                    target_id: None,
                })?;
                if let CodexRpcLineOutcome::TurnCompleted { failed } = outcome {
                    turn_failed = failed;
                    break;
                }
            }
            None => {}
        }
    }

    // codex app-server는 자기 MCP 서브트리(codegraph 등)를 거느린 채 분리되어 child.kill()(단일 PID)로는
    // 죽지 않을 수 있다. 살아남은 서버가 stdout/stderr 파이프 쓰기 끝을 쥐면 아래 reader join이 영구
    // 블록되어 finalize가 멈춘다(턴 완료 후에도 run이 Running으로 박제). stdin을 먼저 닫아 EOF를 알리고,
    // 프로세스 그룹째 KILL해 파이프를 확실히 닫는다 → reader가 EOF로 빠져나와 join이 풀린다.
    drop(stdin);
    #[cfg(unix)]
    kill_host_pid_group(child.id());
    let _ = child.kill();
    let _ = child.wait();
    let _ = stdout_reader.join();
    let _ = stderr_reader.join();
    while let Ok(message) = receiver.try_recv() {
        match message {
            CodexAppServerOutput::Stderr(bytes) => stderr_log.extend_from_slice(&bytes),
            CodexAppServerOutput::StdoutLine(line) => {
                stdout_log.extend_from_slice(line.as_bytes());
                stdout_log.push(b'\n');
            }
        }
    }

    let timed_out = Instant::now() >= deadline;
    let canceled = cancellation.load(Ordering::SeqCst);
    Ok(HostCommandOutput {
        stdout: stdout_log,
        stderr: stderr_log,
        exit_code: if turn_failed || timed_out || canceled {
            1
        } else {
            0
        },
        timed_out,
        canceled,
    })
}

fn codex_app_server_command_args(command_args: &[String]) -> Vec<String> {
    if command_args.iter().any(|arg| arg == "app-server") {
        return command_args.to_vec();
    }
    let cli = command_args
        .first()
        .cloned()
        .unwrap_or_else(|| "codex".to_string());
    vec![cli, "app-server".to_string()]
}

fn codex_thread_start_params(
    worktree_path: &str,
    runner_command: &ResolvedHostRunnerCommand,
) -> Value {
    let mut params = json!({
        "cwd": worktree_path,
        "ephemeral": true
    });
    if let Some(model) = runner_command.model.as_deref() {
        params["model"] = json!(model);
    }
    if let Some(policy) = runner_command.approval_policy.as_deref() {
        params["approvalPolicy"] = json!(policy);
    }
    if let Some(sandbox) = runner_command.sandbox.as_deref() {
        params["sandbox"] = json!(sandbox);
    }
    params
}

fn codex_turn_start_params(
    thread_id: &str,
    prompt: &str,
    runner_command: &ResolvedHostRunnerCommand,
) -> Value {
    let mut params = json!({
        "threadId": thread_id,
        "input": [{ "type": "text", "text": prompt }]
    });
    if let Some(model) = runner_command.model.as_deref() {
        params["model"] = json!(model);
    }
    if let Some(policy) = runner_command.approval_policy.as_deref() {
        params["approvalPolicy"] = json!(policy);
    }
    params
}

fn codex_app_server_role_prompt(artifact_path: &Path, run: &AgentRunSummary) -> String {
    let dossier_name = role_dossier_artifact_name(&run.role_id);
    format!(
        "Read {context_pack}, follow the role contract and any Role Policy section for {role_id}, then write {summary_path}, {result_path}, and {dossier_path} following {schema_path}.\n\nRules:\n- Work only inside the task worktree and approved task scope.\n- If {setup_path} exists, inspect it before changing files and run only relevant setup steps under the active approval policy.\n- Do not skip the structured-result.json file; Helm gates depend on it.\n- Do not skip the role dossier md file; Helm uses it as the productized handoff record for this role.\n- Keep the final chat answer brief because Helm reads the artifact files as source of truth.",
        context_pack = artifact_path.join("context-pack.md").to_string_lossy(),
        role_id = run.role_id,
        setup_path = artifact_path.join("worktree-setup.json").to_string_lossy(),
        summary_path = artifact_path.join("summary.md").to_string_lossy(),
        result_path = artifact_path.join("structured-result.json").to_string_lossy(),
        dossier_path = artifact_path.join(dossier_name).to_string_lossy(),
        schema_path = artifact_path
            .join("structured-result.schema.json")
            .to_string_lossy()
    )
}

fn spawn_codex_json_line_reader(
    stdout: std::process::ChildStdout,
    sender: mpsc::Sender<CodexAppServerOutput>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(line) => {
                    if sender.send(CodexAppServerOutput::StdoutLine(line)).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    })
}

fn spawn_codex_stderr_reader(
    mut stderr: std::process::ChildStderr,
    sender: mpsc::Sender<CodexAppServerOutput>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match stderr.read(&mut buffer) {
                Ok(0) => break,
                Ok(size) => {
                    if sender
                        .send(CodexAppServerOutput::Stderr(buffer[..size].to_vec()))
                        .is_err()
                    {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    })
}

fn codex_rpc_send_request(
    stdin: &mut std::process::ChildStdin,
    next_id: &mut i64,
    method: &str,
    params: Value,
) -> CommandResult<i64> {
    let id = *next_id;
    *next_id += 1;
    codex_rpc_write(
        stdin,
        json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }),
    )?;
    Ok(id)
}

fn codex_rpc_send_notification(
    stdin: &mut std::process::ChildStdin,
    method: &str,
    params: Value,
) -> CommandResult<()> {
    codex_rpc_write(
        stdin,
        json!({ "jsonrpc": "2.0", "method": method, "params": params }),
    )
}

fn codex_rpc_write(stdin: &mut std::process::ChildStdin, message: Value) -> CommandResult<()> {
    stdin
        .write_all(format!("{message}\n").as_bytes())
        .map_err(|err| CommandError::io("Codex app-server 요청을 쓰지 못했습니다.", err))?;
    stdin
        .flush()
        .map_err(|err| CommandError::io("Codex app-server 요청을 flush하지 못했습니다.", err))
}

struct CodexRpcWait<'a, 'b> {
    conn: &'a mut Connection,
    project_id: &'a str,
    run: &'a AgentRunSummary,
    stdin: &'a mut std::process::ChildStdin,
    child: &'a mut std::process::Child,
    receiver: &'a mpsc::Receiver<CodexAppServerOutput>,
    stdout_log: &'a mut Vec<u8>,
    stderr_log: &'a mut Vec<u8>,
    event_sink: &'a mut Option<&'b mut dyn FnMut(&RunEventSummary)>,
    deadline: Instant,
    cancellation: Arc<AtomicBool>,
    target_id: i64,
}

fn codex_rpc_wait_for_response(wait: CodexRpcWait<'_, '_>) -> CommandResult<Value> {
    loop {
        match codex_recv_message(
            wait.receiver,
            wait.child,
            wait.deadline,
            wait.cancellation.clone(),
        )? {
            Some(CodexAppServerOutput::Stderr(bytes)) => {
                wait.stderr_log.extend_from_slice(&bytes);
                emit_host_output_event(
                    wait.conn,
                    wait.project_id,
                    wait.run,
                    "stderr",
                    &bytes,
                    wait.event_sink,
                );
            }
            Some(CodexAppServerOutput::StdoutLine(line)) => {
                let outcome = codex_handle_rpc_line(CodexRpcLine {
                    conn: wait.conn,
                    project_id: wait.project_id,
                    run: wait.run,
                    stdin: wait.stdin,
                    line: &line,
                    stdout_log: wait.stdout_log,
                    stderr_log: wait.stderr_log,
                    event_sink: wait.event_sink,
                    deadline: wait.deadline,
                    cancellation: wait.cancellation.clone(),
                    target_id: Some(wait.target_id),
                })?;
                if let CodexRpcLineOutcome::Response(value) = outcome {
                    return Ok(value);
                }
            }
            None => {}
        }
    }
}

fn codex_recv_message(
    receiver: &mpsc::Receiver<CodexAppServerOutput>,
    child: &mut std::process::Child,
    deadline: Instant,
    cancellation: Arc<AtomicBool>,
) -> CommandResult<Option<CodexAppServerOutput>> {
    if cancellation.load(Ordering::SeqCst) {
        let _ = child.kill();
        return Err(CommandError::new(
            "Canceled",
            "Codex app-server 실행이 취소되었습니다.",
        ));
    }
    if Instant::now() >= deadline {
        let _ = child.kill();
        return Err(CommandError::new(
            "TimedOut",
            "Codex app-server 실행 시간이 초과되었습니다.",
        ));
    }
    if let Some(status) = child
        .try_wait()
        .map_err(|err| CommandError::io("Codex app-server 상태를 확인하지 못했습니다.", err))?
    {
        return Err(CommandError::with_details(
            "RunnerFailed",
            "Codex app-server가 예기치 않게 종료되었습니다.",
            format!("exit status: {status}"),
        ));
    }
    match receiver.recv_timeout(Duration::from_millis(100)) {
        Ok(message) => Ok(Some(message)),
        Err(mpsc::RecvTimeoutError::Timeout) => Ok(None),
        Err(mpsc::RecvTimeoutError::Disconnected) => Err(CommandError::new(
            "RunnerFailed",
            "Codex app-server 출력 스트림이 종료되었습니다.",
        )),
    }
}

struct CodexRpcLine<'a, 'b> {
    conn: &'a mut Connection,
    project_id: &'a str,
    run: &'a AgentRunSummary,
    stdin: &'a mut std::process::ChildStdin,
    line: &'a str,
    stdout_log: &'a mut Vec<u8>,
    stderr_log: &'a mut Vec<u8>,
    event_sink: &'a mut Option<&'b mut dyn FnMut(&RunEventSummary)>,
    deadline: Instant,
    cancellation: Arc<AtomicBool>,
    target_id: Option<i64>,
}

enum CodexRpcLineOutcome {
    Continue,
    Response(Value),
    TurnCompleted { failed: bool },
}

fn codex_handle_rpc_line(line: CodexRpcLine<'_, '_>) -> CommandResult<CodexRpcLineOutcome> {
    let value = serde_json::from_str::<Value>(line.line).map_err(|err| {
        CommandError::with_details(
            "RunnerFailed",
            "Codex app-server JSON-RPC 응답을 파싱하지 못했습니다.",
            format!("{err}: {}", line.line),
        )
    })?;
    let id = value.get("id").and_then(Value::as_i64);
    let method = value.get("method").and_then(Value::as_str);

    if let Some(target_id) = line.target_id {
        if id == Some(target_id) && value.get("method").is_none() {
            if let Some(error) = value.get("error") {
                return Err(CommandError::with_details(
                    "RunnerFailed",
                    "Codex app-server 요청이 실패했습니다.",
                    error.to_string(),
                ));
            }
            return Ok(CodexRpcLineOutcome::Response(
                value.get("result").cloned().unwrap_or(Value::Null),
            ));
        }
    }

    if id.is_some() && method.is_some() {
        let response = bridge_codex_server_request(
            line.conn,
            line.project_id,
            line.run,
            method.unwrap(),
            value.get("params").cloned().unwrap_or(Value::Null),
            line.deadline,
            line.cancellation.clone(),
            line.event_sink,
        )?;
        codex_rpc_write(
            line.stdin,
            json!({ "jsonrpc": "2.0", "id": id, "result": response }),
        )?;
        return Ok(CodexRpcLineOutcome::Continue);
    }

    if let Some(method) = method {
        return handle_codex_notification(
            line.conn,
            line.project_id,
            line.run,
            method,
            value.get("params").cloned().unwrap_or(Value::Null),
            line.stdout_log,
            line.stderr_log,
            line.event_sink,
        );
    }

    Ok(CodexRpcLineOutcome::Continue)
}

fn handle_codex_notification(
    conn: &Connection,
    project_id: &str,
    run: &AgentRunSummary,
    method: &str,
    params: Value,
    stdout_log: &mut Vec<u8>,
    stderr_log: &mut Vec<u8>,
    event_sink: &mut Option<&mut dyn FnMut(&RunEventSummary)>,
) -> CommandResult<CodexRpcLineOutcome> {
    match method {
        "item/agentMessage/delta"
        | "item/reasoning/textDelta"
        | "item/reasoning/summaryTextDelta"
        | "item/plan/delta" => {
            if let Some(delta) = params.get("delta").and_then(Value::as_str) {
                stdout_log.extend_from_slice(delta.as_bytes());
                emit_host_output_event(
                    conn,
                    project_id,
                    run,
                    "stdout",
                    delta.as_bytes(),
                    event_sink,
                );
            }
        }
        "item/commandExecution/outputDelta" => {
            if let Some(delta) = params.get("delta").and_then(Value::as_str) {
                stdout_log.extend_from_slice(delta.as_bytes());
                emit_host_output_event(
                    conn,
                    project_id,
                    run,
                    "stdout",
                    delta.as_bytes(),
                    event_sink,
                );
            }
        }
        "error" => {
            let text = params
                .get("error")
                .and_then(|value| value.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("Codex app-server error");
            stderr_log.extend_from_slice(text.as_bytes());
            stderr_log.push(b'\n');
            emit_host_output_event(conn, project_id, run, "stderr", text.as_bytes(), event_sink);
        }
        "turn/completed" => {
            let failed = params
                .get("turn")
                .and_then(|turn| turn.get("status"))
                .and_then(Value::as_str)
                .is_some_and(|status| !matches!(status, "completed" | "succeeded"));
            append_run_event(
                conn,
                project_id,
                &run.task_id,
                &run.id,
                "system",
                "Codex turn completed",
                json!({ "method": method, "params": params }),
            )?;
            return Ok(CodexRpcLineOutcome::TurnCompleted { failed });
        }
        "turn/started" | "item/started" | "item/completed" | "turn/plan/updated" => {
            append_run_event(
                conn,
                project_id,
                &run.task_id,
                &run.id,
                "system",
                &codex_notification_message(method, &params),
                json!({ "method": method, "params": params }),
            )?;
        }
        _ => {}
    }
    Ok(CodexRpcLineOutcome::Continue)
}

fn codex_notification_message(method: &str, params: &Value) -> String {
    if let Some(item_type) = params
        .get("item")
        .and_then(|item| item.get("type"))
        .and_then(Value::as_str)
    {
        return format!("Codex {method} {item_type}");
    }
    method.to_string()
}

fn emit_host_output_event(
    conn: &Connection,
    project_id: &str,
    run: &AgentRunSummary,
    stream: &str,
    chunk: &[u8],
    event_sink: &mut Option<&mut dyn FnMut(&RunEventSummary)>,
) {
    let text = String::from_utf8_lossy(chunk).to_string();
    let _ = append_and_emit_run_event(
        conn,
        project_id,
        &run.task_id,
        &run.id,
        stream,
        &text,
        json!({
            "stream": stream,
            "bytes": chunk.len()
        }),
        event_sink,
    );
}

fn bridge_codex_server_request(
    conn: &mut Connection,
    project_id: &str,
    run: &AgentRunSummary,
    method: &str,
    params: Value,
    deadline: Instant,
    cancellation: Arc<AtomicBool>,
    event_sink: &mut Option<&mut dyn FnMut(&RunEventSummary)>,
) -> CommandResult<Value> {
    if !matches!(
        method,
        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval"
    ) {
        return Ok(json!({ "decision": "decline" }));
    }
    // 리뷰 단계 역할은 승인 게이트 없이 진행한다(읽기 위주 리뷰).
    if is_review_role(&run.role_id) {
        append_and_emit_run_event(
            conn,
            project_id,
            &run.task_id,
            &run.id,
            "approval",
            "RunApproval AutoApproved (review role)",
            json!({
                "approvalType": "RunApproval",
                "status": "AutoApproved",
                "roleId": run.role_id,
                "rpcMethod": method,
                "params": params
            }),
            event_sink,
        )?;
        return Ok(json!({ "decision": "accept" }));
    }
    let approval = create_run_approval(
        conn,
        project_id,
        &run.task_id,
        &run.id,
        &codex_approval_reason(method, &params),
    )?;
    append_and_emit_run_event(
        conn,
        project_id,
        &run.task_id,
        &run.id,
        "approval",
        "RunApproval Pending",
        json!({
            "approvalId": approval.id,
            "approvalType": "RunApproval",
            "status": "Pending",
            "rpcMethod": method,
            "params": params
        }),
        event_sink,
    )?;

    loop {
        if cancellation.load(Ordering::SeqCst) || Instant::now() >= deadline {
            return Ok(json!({ "decision": "cancel" }));
        }
        let current = get_approval(conn, &approval.id)?;
        match current.status.as_str() {
            "Approved" => return Ok(json!({ "decision": "accept" })),
            "Rejected" | "Expired" => return Ok(json!({ "decision": "decline" })),
            _ => std::thread::sleep(Duration::from_millis(500)),
        }
    }
}

fn codex_approval_reason(method: &str, params: &Value) -> String {
    match method {
        "item/commandExecution/requestApproval" => {
            let command = params
                .get("command")
                .and_then(Value::as_str)
                .or_else(|| {
                    params
                        .get("action")
                        .and_then(|value| value.get("command"))
                        .and_then(Value::as_str)
                })
                .unwrap_or("command execution");
            format!(
                "Codex command approval requested: {}",
                command.lines().next().unwrap_or(command)
            )
        }
        "item/fileChange/requestApproval" => {
            let path = params
                .get("path")
                .and_then(Value::as_str)
                .or_else(|| {
                    params
                        .get("changes")
                        .and_then(Value::as_array)
                        .and_then(|items| items.first())
                        .and_then(|item| item.get("path"))
                        .and_then(Value::as_str)
                })
                .unwrap_or("file change");
            format!("Codex file change approval requested: {path}")
        }
        _ => format!("Codex approval requested: {method}"),
    }
}

fn create_run_approval(
    conn: &Connection,
    project_id: &str,
    task_id: &str,
    run_id: &str,
    requested_reason: &str,
) -> CommandResult<ApprovalSummary> {
    let approval_id = new_id();
    let timestamp = now();
    conn.execute(
        "INSERT INTO approvals (
           id, project_id, entity_type, entity_id, approval_type, status,
           requested_reason, requested_at, created_at, updated_at
         )
         VALUES (?1, ?2, 'AgentRun', ?3, 'RunApproval', 'Pending', ?4, ?5, ?5, ?5)",
        params![approval_id, project_id, run_id, requested_reason, timestamp],
    )
    .map_err(|err| CommandError::database("실행 승인 요청을 저장하지 못했습니다.", err))?;
    insert_audit(
        conn,
        project_id,
        "AgentRun",
        Some(run_id),
        "approval.created",
        json!({
            "approvalId": approval_id,
            "approvalType": "RunApproval",
            "entityType": "AgentRun",
            "entityId": run_id,
            "taskId": task_id,
            "requestedReason": requested_reason
        }),
    )?;
    get_approval(conn, &approval_id)
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

/// 자식 프로세스가 Helm 종료 후에도 살아남도록 spawn한다.
/// - stdout/stderr를 부모 소유 파이프 대신 artifact 로그 파일로 돌린다 → Helm이 죽어도
///   read 단이 닫히지 않아 EPIPE/SIGPIPE로 자식이 죽지 않는다.
/// - unix에선 새 프로세스 그룹으로 분리해 Helm 프로세스 그룹에 가는 시그널과 끊는다.
fn spawn_detached_host_child(
    command: &mut Command,
    artifact_path: &Path,
) -> CommandResult<std::process::Child> {
    let stdout_file = fs::File::create(artifact_path.join("stdout.log"))
        .map_err(|err| CommandError::io("host runner stdout 로그를 열지 못했습니다.", err))?;
    let stderr_file = fs::File::create(artifact_path.join("stderr.log"))
        .map_err(|err| CommandError::io("host runner stderr 로그를 열지 못했습니다.", err))?;
    command
        .stdout(Stdio::from(stdout_file))
        .stderr(Stdio::from(stderr_file));
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // process_group(0): 자식 PID로 새 그룹 생성. Helm 종료 시 그룹 시그널과 분리된다.
        command.process_group(0);
    }
    command
        .spawn()
        .map_err(|err| CommandError::io("host runner command를 실행하지 못했습니다.", err))
}

/// PID 생존 확인. ponytail: `kill -0` 쉘아웃 — libc 의존성 없이 재시작 시 몇 번만 호출.
/// 정밀/고빈도가 필요하면 libc::kill(pid, 0)로 교체.
#[cfg(unix)]
fn host_pid_is_alive(pid: u32) -> bool {
    Command::new("kill")
        .arg("-0")
        .arg(pid.to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn host_pid_is_alive(_pid: u32) -> bool {
    // 비-unix 데스크톱은 프로세스 분리/재연결을 지원하지 않는다(파일 stdio만 적용).
    false
}

#[cfg(unix)]
fn kill_host_pid(pid: u32) {
    let _ = Command::new("kill")
        .arg(pid.to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(not(unix))]
fn kill_host_pid(_pid: u32) {}

/// 프로세스 그룹 전체에 SIGKILL을 보낸다(음수 PID = 그룹). process_group(0)으로 띄운 자식은
/// PID == PGID이므로, 이 호출이 그 자식과 모든 하위 프로세스(codex의 MCP 서버 등)를 함께 종료한다.
/// ponytail: `kill` 쉘아웃 — 기존 kill_host_pid와 동일 패턴, libc 의존성 없이 정리 경로에서만 호출.
#[cfg(unix)]
fn kill_host_pid_group(pgid: u32) {
    let _ = Command::new("kill")
        .arg("-KILL")
        .arg(format!("-{pgid}"))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(not(unix))]
fn kill_host_pid_group(_pgid: u32) {}

/// 태스크의 아직 끝나지 않은 run(Queued/Running)을 (id, host_pid)로 반환한다.
/// 세션 삭제 시 라이브 run에 취소 플래그를 세우고 host 프로세스 그룹을 종료하는 데 쓴다.
pub fn list_active_runs_for_task(
    conn: &Connection,
    project_id: &str,
    task_id: &str,
) -> CommandResult<Vec<(String, Option<i64>)>> {
    let mut stmt = conn
        .prepare(
            "SELECT id, host_pid FROM agent_runs
              WHERE project_id = ?1 AND task_id = ?2 AND status IN ('Queued', 'Running')",
        )
        .map_err(|err| CommandError::database("진행 중 실행을 조회하지 못했습니다.", err))?;
    let rows = stmt
        .query_map(params![project_id, task_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<i64>>(1)?))
        })
        .map_err(|err| CommandError::database("진행 중 실행을 조회하지 못했습니다.", err))?;
    collect_rows(rows, "진행 중 실행을 조회하지 못했습니다.")
}

/// 태스크의 진행 중 run을 강제 종료한다: 저장된 host_pid가 있으면 프로세스 그룹째 kill하고,
/// 상태를 Canceled로 내려 host_pid를 비운다. 세션 삭제가 delete_task의 "실행 중이면 거부" 가드를
/// 통과하도록 삭제 직전에 호출한다. (라이브 run의 협조적 취소 플래그는 호출부에서 별도로 세운다.)
pub fn cancel_task_runs(conn: &Connection, project_id: &str, task_id: &str) -> CommandResult<()> {
    let active = list_active_runs_for_task(conn, project_id, task_id)?;
    if active.is_empty() {
        return Ok(());
    }
    for (_, host_pid) in &active {
        if let Some(pid) = host_pid {
            kill_host_pid_group(*pid as u32);
        }
    }
    let timestamp = now();
    conn.execute(
        "UPDATE agent_runs
            SET status = 'Canceled',
                lifecycle_phase = 'completed',
                finished_at = COALESCE(finished_at, ?1),
                host_pid = NULL,
                updated_at = ?1
          WHERE project_id = ?2 AND task_id = ?3 AND status IN ('Queued', 'Running')",
        params![timestamp, project_id, task_id],
    )
    .map_err(|err| CommandError::database("진행 중 실행을 취소하지 못했습니다.", err))?;
    Ok(())
}

/// detached 자식의 stdout.log / stderr.log를 tail한다. 일반 파일은 EOF(Ok(0)) 이후
/// 파일이 커지면 같은 핸들에서 read가 새 바이트를 반환하므로 follow가 된다.
struct HostLogTailer {
    stdout: Option<fs::File>,
    stderr: Option<fs::File>,
}

impl HostLogTailer {
    fn open(artifact_path: &Path) -> Self {
        HostLogTailer {
            stdout: fs::File::open(artifact_path.join("stdout.log")).ok(),
            stderr: fs::File::open(artifact_path.join("stderr.log")).ok(),
        }
    }

    fn drain<F>(&mut self, stdout: &mut Vec<u8>, stderr: &mut Vec<u8>, on_output: &mut F)
    where
        F: FnMut(&str, &[u8]),
    {
        Self::drain_stream("stdout", &mut self.stdout, stdout, on_output);
        Self::drain_stream("stderr", &mut self.stderr, stderr, on_output);
    }

    fn drain_stream<F>(
        stream: &'static str,
        file: &mut Option<fs::File>,
        buf: &mut Vec<u8>,
        on_output: &mut F,
    ) where
        F: FnMut(&str, &[u8]),
    {
        let Some(file) = file.as_mut() else { return };
        let mut chunk = [0_u8; 8192];
        loop {
            match file.read(&mut chunk) {
                Ok(0) => break,
                Ok(size) => {
                    buf.extend_from_slice(&chunk[..size]);
                    on_output(stream, &chunk[..size]);
                }
                Err(_) => break,
            }
        }
    }
}

/// Helm이 살아있는 동안 detached 자식을 기다린다. 로그 파일을 tail하며 이벤트를 내보내고,
/// Child 핸들의 try_wait로 종료를 감지해 실제 exit code를 얻는다.
fn wait_host_child<F>(
    mut child: std::process::Child,
    artifact_path: &Path,
    timeout_seconds: u64,
    cancellation: Arc<AtomicBool>,
    mut on_output: F,
) -> CommandResult<HostCommandOutput>
where
    F: FnMut(&str, &[u8]),
{
    let mut tailer = HostLogTailer::open(artifact_path);
    let deadline = Instant::now() + Duration::from_secs(timeout_seconds);
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();

    loop {
        tailer.drain(&mut stdout, &mut stderr, &mut on_output);

        if let Some(status) = child
            .try_wait()
            .map_err(|err| CommandError::io("host runner 상태를 확인하지 못했습니다.", err))?
        {
            tailer.drain(&mut stdout, &mut stderr, &mut on_output);
            return Ok(HostCommandOutput {
                stdout,
                stderr,
                exit_code: status.code().unwrap_or(-1),
                timed_out: false,
                canceled: false,
            });
        }

        if cancellation.load(Ordering::SeqCst) {
            let _ = child.kill();
            let status = child.wait().ok();
            tailer.drain(&mut stdout, &mut stderr, &mut on_output);
            return Ok(HostCommandOutput {
                stdout,
                stderr,
                exit_code: status.and_then(|status| status.code()).unwrap_or(-1),
                timed_out: false,
                canceled: true,
            });
        }

        if Instant::now() >= deadline {
            let _ = child.kill();
            let status = child.wait().ok();
            tailer.drain(&mut stdout, &mut stderr, &mut on_output);
            return Ok(HostCommandOutput {
                stdout,
                stderr,
                exit_code: status.and_then(|status| status.code()).unwrap_or(-1),
                timed_out: true,
                canceled: false,
            });
        }

        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Helm 재시작 후, 이미 떠 있는 detached 자식(PID)을 재연결한다. Child 핸들이 없어
/// exit code는 직접 못 얻는다(호출부에서 structured-result.json으로 보정). 로그 tail +
/// PID 생존 폴링만 수행한다.
fn wait_detached_pid<F>(
    pid: u32,
    artifact_path: &Path,
    timeout_seconds: u64,
    cancellation: Arc<AtomicBool>,
    mut on_output: F,
) -> CommandResult<HostCommandOutput>
where
    F: FnMut(&str, &[u8]),
{
    let mut tailer = HostLogTailer::open(artifact_path);
    let deadline = Instant::now() + Duration::from_secs(timeout_seconds);
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut timed_out = false;
    let mut canceled = false;

    loop {
        tailer.drain(&mut stdout, &mut stderr, &mut on_output);

        if !host_pid_is_alive(pid) {
            break;
        }
        if cancellation.load(Ordering::SeqCst) {
            kill_host_pid(pid);
            canceled = true;
            break;
        }
        if Instant::now() >= deadline {
            kill_host_pid(pid);
            timed_out = true;
            break;
        }

        std::thread::sleep(Duration::from_millis(200));
    }

    tailer.drain(&mut stdout, &mut stderr, &mut on_output);
    Ok(HostCommandOutput {
        stdout,
        stderr,
        exit_code: -1, // 재연결 경로: 실제 종료코드 알 수 없음. 호출부에서 보정.
        timed_out,
        canceled,
    })
}

fn write_fallback_result(artifact_path: &Path, role_id: &str, exit_code: i32) -> CommandResult<()> {
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
    write_role_dossier(
        artifact_path,
        role_id,
        &format!(
            "{}\n\n## 종료 상태\n\n- exit code: {exit_code}\n- 판정: NeedsInspection\n\n## 확인 필요\n\n- structured-result.json이 없거나 schema 검증에 실패했습니다.\n- stdout.log와 stderr.log를 확인해야 합니다.\n",
            role_dossier_heading(role_id)
        ),
    )?;
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

    // 멀티 리뷰어(연결 2개 이상)는 all_pass 정책: 모든 리뷰어가 통과해야 다음 단계로 전이한다.
    // 아직 통과하지 않은 리뷰어가 남아 있으면 상태 전이를 보류하고, auto-handoff가
    // 같은 role의 다음 connection run을 큐잉하도록 둔다.
    if role_id == "code_reviewer" {
        let settings = effective_settings(conn, project_id)?;
        // 결정권자(decider)가 지정돼 있으면 그 연결의 통과가 곧 게이트다.
        // 다른 리뷰어의 판정은 조언일 뿐 상태 전이를 막지 않는다.
        if let Some(decider) = decider_connection_id(&settings, "code_reviewer") {
            if !connection_passed_role(conn, project_id, &task.id, "code_reviewer", &decider)? {
                insert_audit(
                    conn,
                    project_id,
                    "Task",
                    Some(&task.id),
                    "code_review.decider_pending",
                    json!({
                        "taskId": task.id,
                        "runId": run_id,
                        "decider": decider,
                        "policy": "decider"
                    }),
                )?;
                return Ok(());
            }
        } else {
            // 결정권자 미지정 → 기존 all_pass 정책(연결 2개 이상은 모두 통과해야 전이).
            let reviewer_ids = role_connection_ids(&settings, "code_reviewer");
            if reviewer_ids.len() >= 2 {
                let passed =
                    count_passed_role_connections(conn, project_id, &task.id, "code_reviewer")?;
                if passed < reviewer_ids.len() {
                    insert_audit(
                        conn,
                        project_id,
                        "Task",
                        Some(&task.id),
                        "code_review.partial",
                        json!({
                            "taskId": task.id,
                            "runId": run_id,
                            "passed": passed,
                            "total": reviewer_ids.len(),
                            "policy": "all_pass"
                        }),
                    )?;
                    return Ok(());
                }
            }
        }
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

        // epic 게이트(계획 검토/코드 리뷰)는 anchor에서 1회 돈다. 통과하면 같은 source 상태로
        // 대기하던 형제 task들도 함께 다음 단계로 옮겨 epic 전체가 한 게이트를 공유하게 한다.
        if is_epic_gate_role(role_id) {
            if let Some(epic_id) = task.epic_id.as_deref() {
                let moved = conn
                    .execute(
                        "UPDATE tasks
                         SET status = ?1, status_reason = ?2, updated_at = ?3, last_transition_at = ?3
                         WHERE project_id = ?4 AND epic_id = ?5 AND status = ?6 AND id != ?7",
                        params![
                            next_status,
                            format!("epic {role_id} gate passed"),
                            timestamp,
                            project_id,
                            epic_id,
                            task.status,
                            task.id
                        ],
                    )
                    .map_err(|err| {
                        CommandError::database("epic 형제 태스크 상태를 저장하지 못했습니다.", err)
                    })?;
                if moved > 0 {
                    insert_audit(
                        conn,
                        project_id,
                        "Epic",
                        Some(epic_id),
                        "epic.gate_passed",
                        json!({
                            "epicId": epic_id,
                            "role": role_id,
                            "from": task.status,
                            "to": next_status,
                            "anchorTaskId": task.id,
                            "siblingsMoved": moved,
                            "runId": run_id
                        }),
                    )?;
                }
            }
        }
    }

    // plan_verifier 통과 = 작업자 작업 완료. PR/리뷰를 자동 진행하지 않고, 사용자에게
    // '리뷰 진행' 승인을 요청한다. 승인되면 approve_approval에서 PR 생성 + 리뷰어 실행을 시작한다.
    if role_id == "plan_verifier"
        && !has_review_approval(conn, project_id, &task.id, "Pending")?
        && !has_review_approval(conn, project_id, &task.id, "Approved")?
    {
        conn.execute(
            "INSERT INTO approvals (
               id, project_id, entity_type, entity_id, approval_type, status,
               requested_reason, decision_reason, requested_at, decided_at, created_at, updated_at
             )
             VALUES (?1, ?2, 'Task', ?3, 'ReviewApproval', 'Pending', ?4, NULL, ?5, NULL, ?5, ?5)",
            params![
                new_id(),
                project_id,
                task.id,
                "plan_verifier host run completed",
                timestamp
            ],
        )
        .map_err(|err| CommandError::database("리뷰 승인 요청을 저장하지 못했습니다.", err))?;
        insert_audit(
            conn,
            project_id,
            "Task",
            Some(&task.id),
            "approval.created",
            json!({
                "taskId": task.id,
                "runId": run_id,
                "approvalType": "ReviewApproval",
                "requestedReason": "plan_verifier host run completed"
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
        "orchestrator" => RoleContextContract {
            objective: "계획자에게 작업을 넘기기 전에 사용자와 대화하며 요구사항을 명확히 확정한다.",
            focus: &[
                "목표, 범위(포함), 제외 범위, 제약, 완료 조건을 사용자와 함께 구체화한다.",
                "모호하거나 빠진 정보는 우선순위가 높은 질문으로 되묻는다.",
                "계획이나 구현을 만들지 않고 정리된 요구사항만 산출한다.",
            ],
            pass_conditions: &[
                "계획자가 바로 계획을 세울 수 있을 만큼 요구사항이 구체적이다.",
                "확정된 범위와 제외 범위가 분리되어 있다.",
            ],
            blocking_conditions: &[
                "핵심 요구사항이 상충하거나 사용자 확인 없이는 진행할 수 없다.",
            ],
            forbidden: &[
                "요구사항이 확정되기 전에 계획이나 task를 만들지 않는다.",
                "파일을 변경하지 않는다.",
            ],
            gate: None,
        },
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
            objective: "승인된 계획과 실제 diff가 일치하는지 판정한다. Epic Plan 섹션이 있으면 이 게이트는 한 task가 아니라 epic 전체를 검토하는 것이며, '승인된 계획'은 그 섹션에 있는 모든 task 계획의 합집합이다.",
            focus: &[
                "Epic Plan 섹션이 있으면 그 안의 모든 task 계획의 합집합을 '승인된 계획'으로 본다. 상단 ## Description(anchor 한 task)만으로 범위를 좁히지 마라.",
                "worktree diff 전체를 그 계획 합집합과 대조한다. 합집합 안 어느 task 계획에든 대응되는 변경이면 '계획 밖'이 아니다(다른 task가 소유한 파일 변경 포함).",
                "어느 task 계획에도 대응되지 않는 변경, 누락된 acceptance criteria, 위험한 상태 전이만 차단 후보로 본다. 차단 이슈는 gateResult.blocking=true로 남긴다.",
            ],
            pass_conditions: &[
                "diff의 모든 변경이 승인된 계획(Epic Plan 합집합 포함) 안 어느 task에든 대응된다.",
                "필수 acceptance criteria가 코드 또는 검증 계획으로 대응된다.",
                "blocking issue가 없으면 gateResult.status=pass를 남긴다.",
            ],
            blocking_conditions: &[
                "어느 task 계획에도(Epic Plan 합집합 포함) 대응되지 않는 변경이 있거나 필수 변경이 누락되었다.",
                "어떤 task 계획에도 없는, 사용자 승인이 필요한 범위 변경이 있다.",
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
                "프론트엔드(UI) 변경이 있고 dev server·스크린샷 도구를 쓸 수 있으면, 영향 화면을 캡쳐해 $HELM_ARTIFACT_DIR/screenshots/ 에 저장하고 리뷰 근거로 참조한다(best-effort: 불가하면 생략, 캡쳐 여부로 차단하지 않는다).",
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

fn role_dossier_artifact_name(role_id: &str) -> &'static str {
    match role_id {
        "planner" => "plan.md",
        "coder" => "pr-dossier.md",
        "plan_verifier" => "plan-verification.md",
        "code_reviewer" => "review-report.md",
        "tester" => "test-report.md",
        _ => "role-dossier.md",
    }
}

fn role_dossier_title(role_id: &str) -> &'static str {
    match role_id {
        "planner" => "계획서",
        "coder" => "PR 작업 문서",
        "plan_verifier" => "계획 준수 검토 기록",
        "code_reviewer" => "코드 리뷰 기록",
        "tester" => "테스트 기록",
        _ => "역할 실행 기록",
    }
}

fn role_dossier_heading(role_id: &str) -> String {
    format!("# {}", role_dossier_title(role_id))
}

fn role_dossier_contract_markdown(role_id: &str) -> String {
    // 상류 dossier는 Context Pack에 6000자로 truncate되어 다음 역할에 주입된다.
    // 그래서 모든 역할은 핵심 핸드오프를 문서 맨 위에 먼저 쓰도록 강제한다.
    let handoff = "- 최상단에 `## 다음 역할 핸드오프` 섹션을 먼저 쓴다: 다음 역할이 알아야 할 핵심 3~5줄(현재 상태, 핵심 판정/결정, 남은 위험, 다음 행동). 상류 dossier는 6000자에서 잘리므로 핵심을 맨 위에 둔다.";
    let body = match role_id {
        "planner" => vec![
            "- 파일명: `plan.md`",
            "- 포함: 목표, 범위, 제외 범위, 실행 단계, acceptance criteria, 검증 계획, 위험, open questions",
            "- scope는 목록으로 고정한다: `touched paths`(수정 허용 경로), `out-of-scope paths`(수정 금지 경로), acceptance criteria는 체크리스트로 작성해 plan_verifier가 범위 밖 변경을 객관적으로 판정할 수 있게 한다.",
            "- 금지: 승인 전 구현 지시를 확정 상태처럼 기록하지 않는다.",
        ],
        "coder" => vec![
            "- 파일명: `pr-dossier.md`",
            "- 포함: 작업 기록, 변경 파일과 이유, 의사결정, 참고문서, 실행한 명령, 검증 결과, 남은 위험, PR 본문 초안",
            "- 금지: 실제 diff와 맞지 않는 변경 요약을 쓰지 않는다.",
        ],
        "plan_verifier" => vec![
            "- 파일명: `plan-verification.md`",
            "- 포함: 승인 계획 대비 구현 일치 여부, 누락된 acceptance criteria, 범위 밖 변경, 차단/비차단 판정",
            "- 금지: 확인하지 않은 항목을 pass로 기록하지 않는다.",
        ],
        "code_reviewer" => vec![
            "- 파일명: `review-report.md`",
            "- 포함: 리뷰 finding, 파일/조건 근거, 수정 요청, 수정 확인 여부, 남은 위험",
            "- 금지: 취향성 스타일 의견을 blocking 수정 요청으로 기록하지 않는다.",
        ],
        "tester" => vec![
            "- 파일명: `test-report.md`",
            "- 포함: 실행한 테스트/빌드/타입체크 명령, 결과, 실패 로그 요약, 생략 사유, 재시도 방법, 최종 판정",
            "- 금지: 실패하거나 실행하지 못한 검증을 통과로 기록하지 않는다.",
        ],
        _ => vec![
            "- 파일명: `role-dossier.md`",
            "- 포함: 역할 목표, 수행한 작업, 근거, 결과, 다음 행동",
            "- 금지: structured-result.json과 충돌하는 결론을 기록하지 않는다.",
        ],
    };
    std::iter::once(handoff)
        .chain(body)
        .collect::<Vec<_>>()
        .join("\n")
}

fn queued_role_dossier(role_id: &str, status: &str) -> String {
    format!(
        "{}\n\n## 상태\n\n- {status}\n\n## 작성 계약\n\n{}\n\n## 작성 대기\n\n이 문서는 host runner가 실행되면 역할 수행 기록으로 갱신되어야 합니다.\n",
        role_dossier_heading(role_id),
        role_dossier_contract_markdown(role_id)
    )
}

fn stub_role_dossier(role_id: &str, task_id: &str) -> String {
    format!(
        "{}\n\n## 상태\n\n- Phase 2 stub 실행 완료\n- task: `{task_id}`\n- role: `{role_id}`\n\n## 작성 계약\n\n{}\n\n## 결과\n\nstub runner가 pass 결과를 생성했습니다. 실제 agent 실행에서는 이 문서가 역할별 handoff 기록으로 채워져야 합니다.\n",
        role_dossier_heading(role_id),
        role_dossier_contract_markdown(role_id)
    )
}

fn write_role_dossier(artifact_path: &Path, role_id: &str, content: &str) -> CommandResult<()> {
    fs::write(
        artifact_path.join(role_dossier_artifact_name(role_id)),
        content,
    )
    .map_err(|err| CommandError::io("역할별 md 산출물을 저장하지 못했습니다.", err))
}

fn role_dossier_is_present(artifact_path: &Path, role_id: &str) -> bool {
    fs::read_to_string(artifact_path.join(role_dossier_artifact_name(role_id)))
        .is_ok_and(|content| !content.trim().is_empty() && !content.contains("## 작성 대기"))
}

fn repair_context_markdown(
    repair: &RepairRequestRecord,
    gate: Option<&GateResultRecord>,
    previous_run: Option<&AgentRunSummary>,
    previous_summary: &str,
) -> String {
    let affected_files = string_list_from_json(&repair.affected_files);
    let blockers = gate
        .map(|gate| compact_json_line(&gate.blockers))
        .unwrap_or_else(|| "없음".to_string());
    let suggested_next = gate
        .and_then(|gate| gate.suggested_next.as_ref())
        .map(compact_json_line)
        .unwrap_or_else(|| "없음".to_string());
    let previous_run_summary = previous_run
        .map(|run| format!("{} · {}", run.id, run_status_summary(run)))
        .unwrap_or_else(|| "이전 run 없음".to_string());
    format!(
        "\n\n\
         ## Targeted Repair\n\n\
         - repair request id: {}\n\
         - severity: {}\n\
         - source run: {}\n\
         - source run status: {}\n\
         - failed gate: {}\n\
         - gate status: {}\n\
         - blocking: {}\n\
         - summary: {}\n\
         - required action: {}\n\
         - affected files:\n{}\n\n\
         ### Previous Summary\n\n{}\n\n\
         ### Gate Blockers\n\n{}\n\n\
         ### Suggested Next\n\n{}\n\n\
         ### Allowed Scope\n\n{}\n\n\
         ### Disallowed Scope\n\n{}\n\n\
         ### Repair Output Contract\n\n\
         - 이 실행은 위 repair request 하나만 해결한다.\n\
         - `changedFiles`는 실제 수정 파일과 일치해야 한다.\n\
         - 해결되면 `status=pass`와 요약 근거를 남긴다.\n\
         - 아직 해결하지 못했으면 `gateResult.status=fail`, `blocking=true`를 유지하고 다음 repair 근거를 남긴다.\n",
        repair.id,
        repair.severity,
        repair.run_id.as_deref().unwrap_or("none"),
        previous_run_summary,
        gate.map(|gate| gate.gate.as_str()).unwrap_or("rules"),
        gate.map(|gate| gate.status.as_str()).unwrap_or("unknown"),
        gate.map(|gate| gate.blocking.to_string())
            .unwrap_or_else(|| "unknown".to_string()),
        repair.summary,
        repair.required_action,
        markdown_string_list(&affected_files),
        truncate_for_context(previous_summary, 4000),
        blockers,
        suggested_next,
        repair_allowed_scope(&repair.affected_files),
        repair_disallowed_scope()
    )
}

fn read_run_summary_for_context(root: &Path, run: &AgentRunSummary) -> String {
    let path = root.join(&run.artifact_dir).join(&run.summary_path);
    fs::read_to_string(path)
        .map(|summary| truncate_for_context(&summary, 4000))
        .unwrap_or_else(|_| "summary.md를 읽지 못했습니다.".to_string())
}

fn upstream_dossier_roles(role_id: &str) -> &'static [&'static str] {
    match role_id {
        "coder" => &["planner"],
        "plan_verifier" => &["planner", "coder"],
        "code_reviewer" => &["coder"],
        "tester" => &["coder", "code_reviewer"],
        _ => &[],
    }
}

fn build_upstream_dossiers_markdown(
    conn: &Connection,
    root: &Path,
    project_id: &str,
    task_id: &str,
    role_id: &str,
) -> String {
    let upstream_roles = upstream_dossier_roles(role_id);
    if upstream_roles.is_empty() {
        return String::new();
    }

    let mut entries = Vec::new();
    for upstream_role in upstream_roles {
        let mut stmt = match conn.prepare(
            "SELECT id, artifact_dir
               FROM agent_runs
              WHERE project_id = ?1 AND task_id = ?2 AND role_id = ?3
                AND status = 'Succeeded'
              ORDER BY finished_at ASC, created_at ASC",
        ) {
            Ok(stmt) => stmt,
            Err(_) => continue,
        };
        let rows = match stmt.query_map(params![project_id, task_id, upstream_role], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }) {
            Ok(rows) => rows,
            Err(_) => continue,
        };

        for row in rows.flatten() {
            let (run_id, artifact_dir) = row;
            if validate_relative_artifact_path(&artifact_dir).is_err() {
                continue;
            }
            let artifact_name = role_dossier_artifact_name(upstream_role);
            let content = match fs::read_to_string(root.join(&artifact_dir).join(artifact_name)) {
                Ok(content) => content,
                Err(_) => continue,
            };
            let trimmed = content.trim();
            if trimmed.is_empty() || trimmed.contains("## 작성 대기") {
                continue;
            }
            entries.push(format!(
                "### {} · `{}` · run `{}`\n\n{}",
                role_label(upstream_role),
                artifact_name,
                run_id,
                truncate_for_context(trimmed, 6000)
            ));
        }
    }

    if entries.is_empty() {
        return "\n\n## Upstream Role Dossiers\n\n- 찾은 상류 dossier가 없습니다. Task description, approval, diff를 기준으로 진행하고 부족하면 차단 이슈로 남기세요.\n".to_string();
    }
    format!(
        "\n\n## Upstream Role Dossiers\n\n{}\n",
        entries.join("\n\n")
    )
}

/// Format one reviewer run row (connection/provider/status + parsed summary/blockers)
/// into the markdown bullet shared by the aggregate and single-run views.
fn format_reviewer_verdict_entry(
    root: &Path,
    connection_id: Option<&str>,
    provider: Option<&str>,
    result_status: Option<&str>,
    artifact_dir: &str,
    result_path: &str,
) -> String {
    let reviewer = match (connection_id, provider) {
        (Some(connection), Some(provider)) => format!("{connection} ({provider})"),
        (Some(connection), None) => connection.to_string(),
        (None, Some(provider)) => provider.to_string(),
        (None, None) => "알 수 없는 리뷰어".to_string(),
    };
    let status = result_status.unwrap_or("미상");

    let result_file = root.join(artifact_dir).join(result_path);
    let parsed = fs::read_to_string(&result_file)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
    let (summary, blockers) = match parsed.as_ref() {
        Some(value) => {
            let summary = value
                .get("summary")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(|item| truncate_for_context(item, 600))
                .unwrap_or_else(|| "요약 없음".to_string());
            let blockers = value
                .get("gateResult")
                .and_then(|gate| gate.get("blockers"))
                .map(|item| string_list_from_json(item))
                .unwrap_or_default();
            (summary, blockers)
        }
        None => (
            "structured-result.json을 읽지 못했습니다.".to_string(),
            Vec::new(),
        ),
    };
    let blockers_md = if blockers.is_empty() {
        "  - blockers: 없음".to_string()
    } else {
        blockers
            .iter()
            .map(|item| format!("  - blocker: {item}"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    format!("- {reviewer} · status={status}\n  - summary: {summary}\n{blockers_md}")
}

/// Same verdict bullet as the aggregate view, but for a single run — used as the
/// body of that reviewer's PR comment. Empty string if the run can't be read.
pub fn build_single_run_verdict_markdown(conn: &Connection, root: &Path, run_id: &str) -> String {
    conn.query_row(
        "SELECT connection_id, provider, result_status, artifact_dir, result_path
           FROM agent_runs WHERE id = ?1",
        params![run_id],
        |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        },
    )
    .ok()
    .map(
        |(connection_id, provider, result_status, artifact_dir, result_path)| {
            format_reviewer_verdict_entry(
                root,
                connection_id.as_deref(),
                provider.as_deref(),
                result_status.as_deref(),
                &artifact_dir,
                &result_path,
            )
        },
    )
    .unwrap_or_default()
}

fn repair_allowed_scope(affected_files: &Value) -> String {
    let files = string_list_from_json(affected_files);
    if files.is_empty() {
        return "blocking gate를 해결하는 데 필요한 최소 파일만 수정합니다.".to_string();
    }
    format!(
        "아래 affected files와 그 실패를 해결하는 데 직접 필요한 최소 인접 코드로 제한합니다: {}",
        files.join(", ")
    )
}

fn repair_disallowed_scope() -> &'static str {
    "관련 없는 refactor, UI 레이아웃 변경, 새 기능 추가, 사용자 변경 되돌리기, merge/commit/push는 금지합니다."
}

fn string_list_from_json(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .filter(|item| !item.trim().is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn markdown_string_list(items: &[String]) -> String {
    if items.is_empty() {
        return "- 없음".to_string();
    }
    items
        .iter()
        .map(|item| format!("- {item}"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn compact_json_line(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "JSON 직렬화 실패".to_string())
}

fn truncate_for_context(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let mut output = value.chars().take(max_chars).collect::<String>();
    output.push_str("\n\n...(truncated)");
    output
}

fn resolve_worktree_setup_config(
    root: &Path,
    settings_setup: Option<&Value>,
) -> CommandResult<Option<Value>> {
    if let Some(value) = settings_setup {
        validate_worktree_setup_config(value)?;
        return Ok(Some(value.clone()));
    }

    let setup_path = root.join(".helm").join("worktree-setup.json");
    if !setup_path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&setup_path)
        .map_err(|err| CommandError::io("worktree setup config를 읽지 못했습니다.", err))?;
    let value = serde_json::from_str::<Value>(&raw).map_err(|err| {
        CommandError::with_details(
            "ValidationFailed",
            "worktree setup config JSON이 올바르지 않습니다.",
            err.to_string(),
        )
    })?;
    validate_worktree_setup_config(&value)?;
    Ok(Some(value))
}

fn validate_worktree_setup_config(value: &Value) -> CommandResult<()> {
    let Some(object) = value.as_object() else {
        return Err(CommandError::validation(
            "worktreeSetup은 JSON object여야 합니다.",
        ));
    };
    if let Some(steps) = object.get("steps") {
        let Some(items) = steps.as_array() else {
            return Err(CommandError::validation(
                "worktreeSetup.steps는 배열이어야 합니다.",
            ));
        };
        for step in items {
            let command = step
                .get("command")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or_default();
            if command.is_empty() {
                return Err(CommandError::validation(
                    "worktreeSetup.steps[].command는 비어 있을 수 없습니다.",
                ));
            }
        }
    }
    Ok(())
}

fn worktree_setup_markdown(setup: Option<&Value>) -> String {
    let Some(setup) = setup else {
        return "- 설정 없음".to_string();
    };
    let steps = setup
        .get("steps")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .enumerate()
                .map(|(index, item)| {
                    let name = item.get("name").and_then(Value::as_str).unwrap_or("setup");
                    let command = item.get("command").and_then(Value::as_str).unwrap_or("");
                    format!("{}. {}: `{}`", index + 1, name, command)
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| "- steps 없음".to_string());
    format!(
        "{}\n\n원본 config는 artifact의 `worktree-setup.json`에 저장됩니다. Helm은 이 설정을 자동 실행하지 않으며 runner approval policy를 따른 명시 실행만 허용합니다.",
        steps
    )
}

struct ResolvedRolePolicy {
    role_id: String,
    enabled: bool,
    path: Option<String>,
    content: Option<String>,
    content_hash: Option<String>,
    error: Option<String>,
}

impl ResolvedRolePolicy {
    fn to_json(&self) -> Value {
        json!({
            "roleId": self.role_id,
            "enabled": self.enabled,
            "path": self.path,
            "contentHash": self.content_hash,
            "error": self.error
        })
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TeamInstructionDoc {
    path: String,
    content_hash: String,
    content: String,
}

fn resolve_role_policy(root: &Path, role_policies: &Value, role_id: &str) -> ResolvedRolePolicy {
    let mut result = ResolvedRolePolicy {
        role_id: role_id.to_string(),
        enabled: false,
        path: None,
        content: None,
        content_hash: None,
        error: None,
    };
    let Some(policy) = role_policies.as_array().and_then(|items| {
        items
            .iter()
            .find(|item| item.get("roleId").and_then(Value::as_str) == Some(role_id))
    }) else {
        return result;
    };
    result.enabled = policy
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    result.path = policy
        .get("path")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(str::to_string);
    if !result.enabled {
        return result;
    }
    let Some(path) = result.path.as_deref() else {
        result.error = Some("정책 문서 경로가 비어 있습니다.".to_string());
        return result;
    };
    if let Err(err) = validate_repo_relative_policy_path(path) {
        result.error = Some(err.message);
        return result;
    }
    match fs::read_to_string(root.join(path)) {
        Ok(content) => {
            result.content_hash = Some(stable_content_hash(&content));
            result.content = Some(content);
        }
        Err(err) => {
            result.error = Some(format!("정책 문서를 읽지 못했습니다: {err}"));
        }
    }
    result
}

/// 컨텍스트 팩에 주입하는 역할 lesson 최대 개수. 프롬프트 블로트/과적합 방지.
const ROLE_LESSON_LIMIT: i64 = 15;

/// .helm/policies/{roleId}.lessons.md 경로(프로젝트 루트 상대). DB의 파생 캐시다.
fn role_lessons_path(role_id: &str) -> String {
    format!(".helm/policies/{role_id}.lessons.md")
}

/// 컨텍스트 팩에 주입할 역할 lesson 본문. 파일이 없으면 None(cold-start).
fn resolve_role_lessons(root: &Path, role_id: &str) -> Option<String> {
    let raw = fs::read_to_string(root.join(role_lessons_path(role_id))).ok()?;
    let content = raw.trim();
    if content.is_empty() {
        return None;
    }
    Some(truncate_for_context(content, 4000))
}

/// "## Role Lessons" 섹션 본문. 위계를 명시한다 — 정책이 항상 우선, lesson은 경험칙.
fn role_lessons_markdown(root: &Path, role_id: &str) -> String {
    match resolve_role_lessons(root, role_id) {
        Some(lessons) => format!(
            "> 아래는 과거 실행에서 학습한 경험칙이다. 위 Role Policy와 충돌하면 항상 정책을 따른다.\n\n{lessons}"
        ),
        None => "학습된 경험칙 없음".to_string(),
    }
}

/// run 산출물에서 lesson 후보 본문을 결정적으로 만든다(ponytail: v1은 LLM 증류 없이 캡처만).
/// structured-result.json의 summary/blockers/suggestedNext를 우선 쓰고, 없으면 summary.md 앞부분.
fn build_retrospective_lesson(artifact_path: &Path, outcome: &str) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    if let Ok(raw) = fs::read_to_string(artifact_path.join("structured-result.json")) {
        if let Ok(value) = serde_json::from_str::<Value>(&raw) {
            if let Some(summary) = value.get("summary").and_then(Value::as_str) {
                let summary = summary.trim();
                if !summary.is_empty() {
                    parts.push(summary.to_string());
                }
            }
            let gate = value.get("gateResult");
            if let Some(blockers) = gate
                .and_then(|g| g.get("blockers"))
                .and_then(Value::as_array)
            {
                let joined = blockers
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>()
                    .join("; ");
                if !joined.is_empty() {
                    parts.push(format!("blockers: {joined}"));
                }
            }
            if let Some(next) = value.get("suggestedNext").and_then(Value::as_str) {
                let next = next.trim();
                if !next.is_empty() {
                    parts.push(format!("suggestedNext: {next}"));
                }
            }
        }
    }
    if parts.is_empty() {
        let summary = fs::read_to_string(artifact_path.join("summary.md")).unwrap_or_default();
        let summary = summary.trim();
        if !summary.is_empty() {
            parts.push(summary.to_string());
        }
    }
    if parts.is_empty() {
        return None;
    }
    let lesson = format!("[{outcome}] {}", parts.join(" / "));
    Some(truncate_for_context(&lesson, 800))
}

/// 회고 캡처는 해당 역할의 role policy가 enabled일 때만 동작한다.
/// 별도 설정/토글 없이 기존 opt-in(role_policies)을 재사용한다 — 정책으로 거버닝하는 역할만 학습한다.
fn retrospective_capture_enabled(conn: &Connection, project_id: &str, role_id: &str) -> bool {
    let Ok(settings) = effective_settings(conn, project_id) else {
        return false;
    };
    settings
        .role_policies
        .as_array()
        .and_then(|items| {
            items
                .iter()
                .find(|item| item.get("roleId").and_then(Value::as_str) == Some(role_id))
        })
        .and_then(|policy| policy.get("enabled").and_then(Value::as_bool))
        .unwrap_or(false)
}

/// 회고 캡처 결과. 호출부가 적절한 run 이벤트를 emit하기 위해 구분한다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RetroCapture {
    /// 캡처 안 함(미지원 역할/비활성/산출물 없음).
    Skipped,
    /// 후보를 pending으로 쌓음 — 사람 승인 대기.
    Pending,
    /// 고신뢰(Succeeded)라 사람 게이트 없이 바로 active로 적용함.
    AutoApplied,
}

/// 회귀 안전장치: 직전에 자동 적용(source='auto')된 active lesson 1건을 비활성화한다.
/// 사람이 승인한 lesson(source='manual')은 절대 건드리지 않는다 — 명시적 의도가 자동 롤백보다 우선.
/// 1건만 되돌려(back off one step) 무관한 실패가 누적 lesson을 한꺼번에 날리는 thrash를 막는다.
fn disable_latest_auto_lesson(
    conn: &Connection,
    project_id: &str,
    role_id: &str,
) -> CommandResult<bool> {
    let timestamp = now();
    let affected = conn
        .execute(
            "UPDATE role_retrospectives SET status = 'disabled', updated_at = ?1 \
             WHERE id IN ( \
                SELECT id FROM role_retrospectives \
                WHERE project_id = ?2 AND role_id = ?3 AND status = 'active' AND source = 'auto' \
                ORDER BY created_at DESC LIMIT 1 \
             )",
            params![timestamp, project_id, role_id],
        )
        .map_err(|err| CommandError::database("회고 자동 롤백에 실패했습니다.", err))?;
    Ok(affected > 0)
}

/// run 종료 시 lesson 후보를 캡처한다(best-effort, finalize를 막지 않음).
/// 회고 row와 승인 row(RoleLesson)를 한 트랜잭션으로 함께 만들어 둘이 갈라지지 않게 한다.
/// Succeeded/NeedsInspection은 사람 게이트 없이 바로 active(source='auto')로 적용하고 .lessons.md를 재생성한다.
/// 하드 실패/중단(Failed/TimedOut/Canceled)만 pending으로 쌓여 사람 승인을 기다린다(노이즈/환각 강화 차단).
/// 하드 실패(Failed)면 새 캡처와 별개로 직전 자동 lesson 1건을 회귀 안전장치로 비활성화한다.
fn capture_role_retrospective(
    conn: &mut Connection,
    project_id: &str,
    task_id: &str,
    run_id: &str,
    role_id: &str,
    outcome: &str,
    artifact_path: &Path,
    root: &Path,
) -> CommandResult<RetroCapture> {
    if !role_policy_role_ids().contains(&role_id) {
        return Ok(RetroCapture::Skipped);
    }
    // 회고 캡처는 해당 역할의 role policy가 켜졌을 때만 동작한다(opt-in).
    // 켜지 않으면 run마다 승인 카드가 쌓이는 노이즈가 없다.
    if !retrospective_capture_enabled(conn, project_id, role_id) {
        return Ok(RetroCapture::Skipped);
    }

    // 회귀 안전장치: 하드 실패(Failed, exit!=0)면 직전 자동 lesson을 back off한다.
    // NeedsInspection/TimedOut/Canceled는 신호가 모호해 제외(thrash 방지). 새 캡처와 독립적이라
    // 산출물이 비어 lesson을 못 만들어도 롤백은 수행한다.
    if outcome == "Failed" && disable_latest_auto_lesson(conn, project_id, role_id)? {
        regenerate_role_lessons_file(conn, root, project_id, role_id)?;
    }

    let Some(lesson) = build_retrospective_lesson(artifact_path, outcome) else {
        return Ok(RetroCapture::Skipped);
    };
    // 자동 적용: 명확한 성공(Succeeded) + 점검필요(NeedsInspection)까지.
    // 하드 실패/중단(Failed/TimedOut/Canceled)은 신호가 약해 사람 승인 게이트를 유지한다.
    let auto = outcome == "Succeeded" || outcome == "NeedsInspection";
    let retro_status = if auto { "active" } else { "pending" };
    let source = if auto { "auto" } else { "manual" };
    let approval_status = if auto { "Approved" } else { "Pending" };
    let timestamp = now();
    let decided_at: Option<&str> = if auto { Some(timestamp.as_str()) } else { None };
    let decision_reason: Option<String> = if auto {
        Some(format!("auto: {outcome} 자동 적용"))
    } else {
        None
    };
    let retro_id = new_id();
    let approval_id = new_id();
    let tx = conn
        .transaction()
        .map_err(|err| CommandError::database("회고 후보를 저장하지 못했습니다.", err))?;
    tx.execute(
        "INSERT INTO role_retrospectives \
         (id, project_id, task_id, run_id, role_id, outcome, lesson, tags, status, source, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, '[]', ?8, ?9, ?10, ?10)",
        params![
            retro_id, project_id, task_id, run_id, role_id, outcome, lesson, retro_status, source,
            timestamp
        ],
    )
    .map_err(|err| CommandError::database("회고 후보를 저장하지 못했습니다.", err))?;
    tx.execute(
        "INSERT INTO approvals \
         (id, project_id, entity_type, entity_id, approval_type, status, requested_reason, decision_reason, requested_at, decided_at, created_at, updated_at) \
         VALUES (?1, ?2, 'RoleLesson', ?3, 'RoleLesson', ?4, ?5, ?6, ?7, ?8, ?7, ?7)",
        params![
            approval_id, project_id, retro_id, approval_status, lesson, decision_reason, timestamp,
            decided_at
        ],
    )
    .map_err(|err| CommandError::database("회고 승인 요청을 저장하지 못했습니다.", err))?;
    insert_audit(
        &tx,
        project_id,
        "RoleLesson",
        Some(&retro_id),
        if auto {
            "approval.approved"
        } else {
            "approval.created"
        },
        json!({
            "approvalId": approval_id,
            "approvalType": "RoleLesson",
            "entityType": "RoleLesson",
            "entityId": retro_id,
            "roleId": role_id,
            "auto": auto,
            "status": approval_status
        }),
    )?;
    tx.commit()
        .map_err(|err| CommandError::database("회고 후보를 저장하지 못했습니다.", err))?;
    if auto {
        // 자동 적용은 즉시 파일에 반영해야 다음 동일 역할 run 컨텍스트 팩에 주입된다.
        regenerate_role_lessons_file(conn, root, project_id, role_id)?;
        Ok(RetroCapture::AutoApplied)
    } else {
        Ok(RetroCapture::Pending)
    }
}

/// active lesson을 모아 .helm/policies/{roleId}.lessons.md를 재생성한다(DB가 원본, 파일은 파생 캐시).
/// active가 0개면 파일을 삭제해 cold-start 상태로 되돌린다(soft-delete 롤백 자동 반영).
fn regenerate_role_lessons_file(
    conn: &Connection,
    root: &Path,
    project_id: &str,
    role_id: &str,
) -> CommandResult<()> {
    let mut stmt = conn
        .prepare(
            "SELECT lesson FROM role_retrospectives \
             WHERE project_id = ?1 AND role_id = ?2 AND status = 'active' \
             ORDER BY created_at DESC LIMIT ?3",
        )
        .map_err(|err| CommandError::database("회고 목록을 읽지 못했습니다.", err))?;
    let lessons = stmt
        .query_map(params![project_id, role_id, ROLE_LESSON_LIMIT], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|err| CommandError::database("회고 목록을 읽지 못했습니다.", err))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| CommandError::database("회고 목록을 읽지 못했습니다.", err))?;

    let path = root.join(role_lessons_path(role_id));
    if lessons.is_empty() {
        let _ = fs::remove_file(&path);
        return Ok(());
    }
    let body = lessons
        .iter()
        .map(|lesson| format!("- {}", lesson.trim().replace('\n', " ")))
        .collect::<Vec<_>>()
        .join("\n");
    let content = format!("# {role_id} 학습 경험칙 (자동 생성 — 직접 편집 금지)\n\n{body}\n");
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| CommandError::io("정책 디렉터리를 만들지 못했습니다.", err))?;
    }
    fs::write(&path, content)
        .map_err(|err| CommandError::io("회고 캐시 파일을 쓰지 못했습니다.", err))?;
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleLessonSummary {
    pub id: String,
    pub task_id: String,
    pub run_id: String,
    pub role_id: String,
    pub outcome: String,
    pub lesson: String,
    pub status: String,
    pub created_at: String,
}

/// 회고 후보 목록을 조회한다. status가 주어지면 그 상태만, 없으면 pending+active(disabled 제외).
pub fn list_role_lessons(
    conn: &Connection,
    project_id: &str,
    status: Option<&str>,
) -> CommandResult<Vec<RoleLessonSummary>> {
    let mut stmt = conn
        .prepare(
            "SELECT id, task_id, run_id, role_id, outcome, lesson, status, created_at \
             FROM role_retrospectives \
             WHERE project_id = ?1 \
               AND (?2 IS NULL AND status != 'disabled' OR status = ?2) \
             ORDER BY created_at DESC",
        )
        .map_err(|err| CommandError::database("회고 목록을 읽지 못했습니다.", err))?;
    let rows = stmt
        .query_map(params![project_id, status], |row| {
            Ok(RoleLessonSummary {
                id: row.get(0)?,
                task_id: row.get(1)?,
                run_id: row.get(2)?,
                role_id: row.get(3)?,
                outcome: row.get(4)?,
                lesson: row.get(5)?,
                status: row.get(6)?,
                created_at: row.get(7)?,
            })
        })
        .map_err(|err| CommandError::database("회고 목록을 읽지 못했습니다.", err))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| CommandError::database("회고 목록을 읽지 못했습니다.", err))?;
    Ok(rows)
}

/// RoleLesson 승인 결정 후 .lessons.md를 재생성한다(회고 상태 전환은 decide_approval이 in-tx 처리).
/// 파일은 DB의 파생 캐시이므로 command 계층에서 best-effort로 호출한다.
pub fn refresh_role_lessons_file(
    conn: &Connection,
    root: &Path,
    project_id: &str,
    retro_id: &str,
) -> CommandResult<()> {
    let role_id: Option<String> = conn
        .query_row(
            "SELECT role_id FROM role_retrospectives WHERE id = ?1 AND project_id = ?2",
            params![retro_id, project_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|err| CommandError::database("회고 역할을 읽지 못했습니다.", err))?;
    if let Some(role_id) = role_id {
        regenerate_role_lessons_file(conn, root, project_id, &role_id)?;
    }
    Ok(())
}

fn resolve_team_instruction_docs(root: &Path) -> Vec<TeamInstructionDoc> {
    let mut docs = ["AGENTS.md", "CLAUDE.md", ".claude/CLAUDE.md"]
        .into_iter()
        .filter_map(|path| {
            let raw = fs::read_to_string(root.join(path)).ok()?;
            let content = raw.trim();
            if content.is_empty() {
                return None;
            }
            Some(TeamInstructionDoc {
                path: path.to_string(),
                content_hash: stable_content_hash(content),
                content: truncate_for_context(content, 8000),
            })
        })
        .collect::<Vec<_>>();
    docs.extend(resolve_project_skill_docs(root));
    docs
}

fn resolve_project_skill_docs(root: &Path) -> Vec<TeamInstructionDoc> {
    let mut skill_paths = Vec::new();
    for base in [
        ".agents/skills",
        ".codex/skills",
        ".claude/skills",
        "skills",
    ] {
        let dir = root.join(base);
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let skill_path = entry.path().join("SKILL.md");
            if skill_path.is_file() {
                skill_paths.push((
                    format!("{}/{}", base, entry.file_name().to_string_lossy()),
                    skill_path,
                ));
            }
        }
    }
    skill_paths.sort_by(|left, right| left.0.cmp(&right.0));
    skill_paths
        .into_iter()
        .take(12)
        .filter_map(|(skill_dir, path)| {
            let raw = fs::read_to_string(path).ok()?;
            let content = raw.trim();
            if content.is_empty() {
                return None;
            }
            Some(TeamInstructionDoc {
                path: format!("{skill_dir}/SKILL.md"),
                content_hash: stable_content_hash(content),
                content: truncate_for_context(content, 8000),
            })
        })
        .collect()
}

fn team_instruction_markdown(docs: &[TeamInstructionDoc]) -> String {
    if docs.is_empty() {
        return "- 프로젝트 팀 지시 문서 없음".to_string();
    }
    docs.iter()
        .map(|doc| {
            format!(
                "### {}\n\n- contentHash: {}\n\n{}",
                doc.path, doc.content_hash, doc.content
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn validate_repo_relative_policy_path(path: &str) -> CommandResult<()> {
    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed.starts_with('/') || trimmed.split('/').any(|part| part == "..")
    {
        return Err(CommandError::validation(
            "역할 정책 문서는 프로젝트 내부 상대 경로여야 합니다.",
        ));
    }
    if !trimmed.ends_with(".md") {
        return Err(CommandError::validation(
            "역할 정책 문서는 .md 파일이어야 합니다.",
        ));
    }
    Ok(())
}

fn role_policy_markdown(policy: Option<&ResolvedRolePolicy>) -> String {
    let Some(policy) = policy else {
        return "등록된 역할 정책 없음".to_string();
    };
    if !policy.enabled {
        return "역할 정책 비활성화".to_string();
    }
    if let Some(error) = policy.error.as_deref() {
        return format!(
            "- path: {}\n- error: {}",
            policy.path.as_deref().unwrap_or("-"),
            error
        );
    }
    let content = policy
        .content
        .as_deref()
        .map(str::trim)
        .filter(|content| !content.is_empty())
        .unwrap_or("정책 문서가 비어 있습니다.");
    format!(
        "- path: {}\n- contentHash: {}\n\n{}",
        policy.path.as_deref().unwrap_or("-"),
        policy.content_hash.as_deref().unwrap_or("-"),
        content
    )
}

fn build_context_pack_markdown(
    root: &Path,
    task: &TaskSummary,
    worktree: &TaskWorktreeSummary,
    role_id: &str,
    worktree_setup: Option<&Value>,
    role_policy: Option<&ResolvedRolePolicy>,
) -> CommandResult<String> {
    let contract = role_context_contract(role_id);
    let changed_files = git::changed_files(root)?;
    let recent_commits = git::recent_commits(root, 5)?;
    let team_docs = resolve_team_instruction_docs(root);
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
         ## Role Dossier Contract\n\n{}\n\n\
         ## Role Policy\n\n{}\n\n\
         ## Role Lessons\n\n{}\n\n\
         ## Team Instructions\n\n{}\n\n\
         ## Worktree Setup\n\n{}\n\n\
         ## External Refs\n\n{}\n\n\
         ## Changed Files\n\n{}\n\n\
         ## Recent Commits\n\n{}\n\n\
         ## Expected Output\n\n\
         Agent는 `summary.md`, `{}`, schema v1을 만족하는 `structured-result.json`을 남겨야 한다.\n\
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
        role_dossier_contract_markdown(role_id),
        role_policy_markdown(role_policy),
        role_lessons_markdown(root, role_id),
        team_instruction_markdown(&team_docs),
        worktree_setup_markdown(worktree_setup),
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
        },
        role_dossier_artifact_name(role_id)
    ))
}

fn build_context_manifest(
    root: &Path,
    task: &TaskSummary,
    worktree: &TaskWorktreeSummary,
    role_id: &str,
    worktree_setup: Option<&Value>,
    role_policy: Option<&ResolvedRolePolicy>,
) -> CommandResult<Value> {
    let contract = role_context_contract(role_id);
    let team_docs = resolve_team_instruction_docs(root);
    Ok(json!({
        "schemaVersion": 1,
        "generatedAt": now(),
        "projectRoot": root.to_string_lossy(),
        "task": task,
        "roleId": role_id,
        "roleContract": contract.to_json(role_id),
        "rolePolicy": role_policy.map(ResolvedRolePolicy::to_json),
        "teamInstructions": team_docs,
        "worktree": worktree,
        "worktreeSetup": worktree_setup.cloned(),
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
            "roleContract",
            "rolePolicy",
            "teamInstructions",
            "worktreeSetup"
        ],
        "expectedArtifacts": [
            "summary.md",
            "structured-result.json",
            role_dossier_artifact_name(role_id),
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

    // 작업 완료(plan_verifier 통과) 후 사용자가 '리뷰 진행'을 승인해야 코드 리뷰어를 실행한다.
    if role_id == "code_reviewer" && !has_review_approval(conn, project_id, &task.id, "Approved")? {
        return Err(CommandError::validation(
            "리뷰 진행 승인 전에는 코드 리뷰어 역할을 실행할 수 없습니다.",
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

fn has_review_approval(
    conn: &Connection,
    project_id: &str,
    task_id: &str,
    status: &str,
) -> CommandResult<bool> {
    let exists: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM approvals
             WHERE project_id = ?1 AND entity_type = 'Task' AND entity_id = ?2
               AND approval_type = 'ReviewApproval' AND status = ?3
             LIMIT 1",
            params![project_id, task_id, status],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| CommandError::database("리뷰 승인 요청을 확인하지 못했습니다.", err))?;
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

/// epic 단위로 한 번만 도는 게이트 role. 공유 worktree에서는 형제 task의 변경이 모두
/// 같은 diff에 섞여 보이므로, 개별 task가 아니라 epic 전체가 끝난 뒤 anchor task에서 1회
/// 실행해 합쳐진 diff를 epic 전체 계획과 대조한다. coder/tester는 task 단위 그대로 둔다.
const EPIC_GATE_ROLES: &[&str] = &["plan_verifier", "code_reviewer"];

fn is_epic_gate_role(role_id: &str) -> bool {
    EPIC_GATE_ROLES.contains(&role_id)
}

/// task가 속한 epic의 형제 task들을 (sort_order, id) 순으로 반환한다.
/// epic_id가 없으면 자기 자신만 담은 1개짜리 epic으로 취급한다(= 기존 task 단위 동작).
fn epic_sibling_tasks(
    conn: &Connection,
    project_id: &str,
    task: &TaskSummary,
) -> CommandResult<Vec<TaskSummary>> {
    let Some(epic_id) = task.epic_id.as_deref() else {
        return Ok(vec![task.clone()]);
    };
    let mut siblings: Vec<TaskSummary> = list_tasks(conn, project_id)?
        .into_iter()
        .filter(|candidate| candidate.epic_id.as_deref() == Some(epic_id))
        .collect();
    siblings.sort_by(|a, b| {
        a.sort_order
            .cmp(&b.sort_order)
            .then_with(|| a.id.cmp(&b.id))
    });
    if siblings.is_empty() {
        siblings.push(task.clone());
    }
    Ok(siblings)
}

/// epic 게이트를 호스팅하는 anchor task id (형제 중 sort_order/id 최소). 입력 순서와
/// 무관하게 결정적이라 같은 epic에서 항상 동일한 task가 게이트를 1회만 띄운다.
fn epic_anchor_id(siblings: &[TaskSummary]) -> &str {
    siblings
        .iter()
        .min_by(|a, b| {
            a.sort_order
                .cmp(&b.sort_order)
                .then_with(|| a.id.cmp(&b.id))
        })
        .map(|t| t.id.as_str())
        .unwrap_or_default()
}

/// epic 배리어: 형제 task가 모두 gate_status에 도달했는지. 아직 코딩 중(Planned/Ready/Coding)
/// 이거나 Blocked인 형제가 하나라도 있으면 미충족 → 게이트를 대기시킨다.
fn epic_barrier_met(siblings: &[TaskSummary], gate_status: &str) -> bool {
    let Some(gate_idx) = TASK_STATUS_ORDER.iter().position(|s| *s == gate_status) else {
        return false;
    };
    siblings.iter().all(|sib| {
        // Blocked는 순서상 뒤에 있지만 "진행"이 아니므로 배리어를 막는다.
        if sib.status == "Blocked" {
            return false;
        }
        TASK_STATUS_ORDER
            .iter()
            .position(|s| *s == sib.status)
            .is_some_and(|idx| idx >= gate_idx)
    })
}

/// 이 task에서 지금 role_id 게이트를 띄울 수 있는지. epic 게이트 role이면 anchor이면서
/// 형제가 모두 도달했을 때만 true. 게이트 role이 아니면 항상 true(기존 동작).
fn epic_gate_ready(
    conn: &Connection,
    project_id: &str,
    task: &TaskSummary,
    role_id: &str,
) -> CommandResult<bool> {
    if !is_epic_gate_role(role_id) {
        return Ok(true);
    }
    let siblings = epic_sibling_tasks(conn, project_id, task)?;
    Ok(task.id == epic_anchor_id(&siblings) && epic_barrier_met(&siblings, &task.status))
}

/// epic 게이트 role의 context용 task를 반환한다. 게이트는 anchor의 단일 task가 아니라
/// epic 전체 계획의 합집합과 worktree diff를 대조해야 하므로, context pack의 ## Description을
/// epic 전체 task 계획의 합집합으로 교체한 clone을 돌려준다. 게이트 role이 아니거나 형제가
/// 1개뿐이면 원본 task를 그대로 쓴다. 이게 없으면 약한 검증 모델이 단일 task 설명에 앵커링해
/// 공유 worktree의 형제 변경을 매번 out-of-plan으로 오탐한다.
fn epic_gate_context_task(
    conn: &Connection,
    project_id: &str,
    task: &TaskSummary,
    role_id: &str,
) -> CommandResult<TaskSummary> {
    if !is_epic_gate_role(role_id) || task.epic_id.is_none() {
        return Ok(task.clone());
    }
    let siblings = epic_sibling_tasks(conn, project_id, task)?;
    if siblings.len() <= 1 {
        return Ok(task.clone());
    }
    let mut description = String::from(
        "이 게이트는 한 task가 아니라 아래 epic 전체를 검토한다. '승인된 계획'은 아래 \
         모든 task 계획의 합집합이다. worktree diff 전체를 이 합집합과 대조하고, 아래 어느 \
         task 계획에든 대응되는 변경이면 절대 '계획 밖'으로 판정하지 마라(다른 task가 소유한 \
         파일 변경 포함). 어느 task 계획에도 대응되지 않는 변경만 범위 밖 후보다.\n\n\
         ## Epic 전체 계획 (task별)\n\n",
    );
    for sib in &siblings {
        let marker = if sib.id == task.id {
            " (anchor · 이 run이 호스팅)"
        } else {
            ""
        };
        let body = if sib.description.trim().is_empty() {
            "설명 없음"
        } else {
            sib.description.trim()
        };
        description.push_str(&format!(
            "### {}{}\n\n- id: {}\n- status: {}\n\n{}\n\n",
            sib.title, marker, sib.id, sib.status, body
        ));
    }
    Ok(TaskSummary {
        description,
        ..task.clone()
    })
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

    // 보고만 하고 실제 diff에 없는 파일(extra_files)이 진짜 위험(환각/잘못된 worktree)이다.
    // 실제로 더 고쳤는데 changedFiles에 덜 적은 under-report(missing_files만 존재)는
    // 정상 작업이므로 차단하지 않는다.
    if extra_files.is_empty() {
        return None;
    }

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

fn default_role_policies() -> Value {
    json!(role_policy_role_ids()
        .into_iter()
        .map(|role_id| json!({
            "roleId": role_id,
            "path": format!(".helm/policies/{role_id}.md"),
            "enabled": false
        }))
        .collect::<Vec<_>>())
}

fn normalize_role_policies(value: Value) -> Value {
    let incoming = value.as_array().cloned().unwrap_or_default();
    json!(role_policy_role_ids()
        .into_iter()
        .map(|role_id| {
            let match_item = incoming
                .iter()
                .find(|item| item.get("roleId").and_then(Value::as_str) == Some(role_id));
            let default_path = format!(".helm/policies/{role_id}.md");
            let path = match_item
                .and_then(|item| item.get("path"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|path| !path.is_empty())
                .unwrap_or(default_path.as_str());
            let enabled = match_item
                .and_then(|item| item.get("enabled"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            json!({
                "roleId": role_id,
                "path": path,
                "enabled": enabled
            })
        })
        .collect::<Vec<_>>())
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
                worktree_mode: Some("worktree".to_string()),
            },
        )
        .expect("create task")
    }

    fn git_file(path: &str) -> GitFileStatus {
        GitFileStatus {
            path: path.to_string(),
            status: "M".to_string(),
            staged: false,
            renamed_from: None,
        }
    }

    #[test]
    fn diff_consistency_only_blocks_on_reported_files_absent_from_diff() {
        let result = json!({ "status": "pass", "changedFiles": ["a.tsx"] });

        // under-report: 실제로 더 고쳤지만 changedFiles에 덜 적음 → 통과(차단 안 함)
        let actual = vec![git_file("a.tsx"), git_file("b.json"), git_file("c.json")];
        assert!(diff_consistency_check("coder", Some(&result), &actual).is_none());

        // 정확히 일치 → 통과
        let actual = vec![git_file("a.tsx")];
        assert!(diff_consistency_check("coder", Some(&result), &actual).is_none());

        // over-report(환각/잘못된 worktree): 보고했지만 실제 diff에 없음 → 차단
        let actual = vec![git_file("b.json")];
        let check = diff_consistency_check("coder", Some(&result), &actual)
            .expect("reported file absent from diff must block");
        assert_eq!(check.extra_files, vec!["a.tsx".to_string()]);
    }

    fn epic_task(id: &str, sort_order: i64, status: &str) -> TaskSummary {
        TaskSummary {
            id: id.to_string(),
            project_id: "p".to_string(),
            epic_id: Some("epic-1".to_string()),
            title: id.to_string(),
            description: String::new(),
            status: status.to_string(),
            status_reason: None,
            sort_order,
            external_refs: vec![],
            created_at: "t".to_string(),
            updated_at: "t".to_string(),
            last_transition_at: "t".to_string(),
        }
    }

    #[test]
    fn epic_barrier_and_anchor_gate_the_plan_verifier() {
        // anchor = (sort_order, id) 최소. 순서가 뒤섞여도 결정적으로 첫 task를 고른다.
        let siblings = vec![
            epic_task("b", 2, "PlanVerification"),
            epic_task("a", 1, "Coding"),
            epic_task("c", 3, "PlanVerification"),
        ];
        assert_eq!(epic_anchor_id(&siblings), "a");

        // 형제 하나가 아직 Coding → PlanVerification 배리어 미충족.
        assert!(!epic_barrier_met(&siblings, "PlanVerification"));

        // 전부 PlanVerification 이상 도달 → 충족.
        let ready = vec![
            epic_task("a", 1, "PlanVerification"),
            epic_task("b", 2, "CodeReview"),
            epic_task("c", 3, "PlanVerification"),
        ];
        assert!(epic_barrier_met(&ready, "PlanVerification"));

        // Blocked 형제가 있으면(순서상 뒤지만 진행 아님) 배리어를 막는다.
        let blocked = vec![
            epic_task("a", 1, "PlanVerification"),
            epic_task("b", 2, "Blocked"),
        ];
        assert!(!epic_barrier_met(&blocked, "PlanVerification"));

        // CodeReview 게이트는 PlanVerification에 머문 형제가 있으면 미충족.
        let mixed = vec![
            epic_task("a", 1, "CodeReview"),
            epic_task("b", 2, "PlanVerification"),
        ];
        assert!(!epic_barrier_met(&mixed, "CodeReview"));
    }

    #[test]
    fn terminal_saved_scripts_are_project_scoped_and_durable() {
        let repo = test_repo();
        let (mut conn, project) = open_test_project(&repo);

        let script = save_terminal_saved_script(
            &mut conn,
            &project.id,
            SaveTerminalScriptInput {
                id: None,
                name: "Run checks".to_string(),
                command: "pnpm --dir apps/desktop typecheck".to_string(),
                cwd_mode: Some("active_pane".to_string()),
                node_bin_path: None,
                tags: Some(vec!["verify".to_string(), "".to_string()]),
            },
        )
        .expect("save script");

        assert_eq!(script.project_id, project.id);
        assert_eq!(script.tags, vec!["verify".to_string()]);

        let listed = list_terminal_saved_scripts(&conn, &project.id).expect("list scripts");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, script.id);

        let used =
            mark_terminal_saved_script_used(&mut conn, &project.id, &script.id).expect("mark used");
        assert!(used.last_used_at.is_some());

        delete_terminal_saved_script(&mut conn, &project.id, &script.id).expect("delete script");
        assert!(list_terminal_saved_scripts(&conn, &project.id)
            .expect("list after delete")
            .is_empty());
    }

    #[test]
    fn terminal_saved_scripts_reject_secret_like_commands() {
        let repo = test_repo();
        let (mut conn, project) = open_test_project(&repo);

        let error = save_terminal_saved_script(
            &mut conn,
            &project.id,
            SaveTerminalScriptInput {
                id: None,
                name: "Bad script".to_string(),
                command: "curl -H 'Authorization=Bearer abc' https://example.com".to_string(),
                cwd_mode: Some("active_pane".to_string()),
                node_bin_path: None,
                tags: None,
            },
        )
        .expect_err("secret-like script rejected");

        assert_eq!(error.code, "ValidationFailed");
    }

    fn valid_planning_draft() -> Value {
        json!({
            "title": "DB backed planning",
            "summary": "Planning session을 DB revision으로 저장하고 Task로 materialize한다.",
            "scope": ["planning session", "draft revision", "materialization"],
            "tasks": [
                {
                    "id": "task-1",
                    "title": "Planning DB slice",
                    "description": "계획 세션과 draft 저장을 구현한다.",
                    "subtasks": ["migration 추가", "command 추가"],
                    "acceptanceCriteria": ["앱 재시작 후 draft가 복원된다."],
                    "risks": ["approval 경계가 흐려질 수 있다."],
                    "testPlan": ["cargo test planning_session_revision_and_materialization_are_durable"]
                }
            ],
            "openQuestions": [],
            "risks": ["approval 경계가 흐려질 수 있다."],
            "executablePlan": {
                "taskGraph": [
                    {
                        "id": "task-1",
                        "title": "Planning DB slice",
                        "dependsOn": [],
                        "parallelizable": true,
                        "batch": "batch-1"
                    }
                ],
                "taskCards": [
                    {
                        "id": "task-1",
                        "title": "Planning DB slice",
                        "ownerRole": "coder",
                        "goal": "계획 세션과 draft 저장을 구현한다.",
                        "inputs": ["Plan Document"],
                        "outputs": ["migration", "commands"],
                        "acceptanceCriteria": ["앱 재시작 후 draft가 복원된다."],
                        "verificationGates": ["gate-1"]
                    }
                ],
                "ownershipMap": [
                    {
                        "ownerRole": "coder",
                        "responsibilities": ["구현", "검증"],
                        "artifacts": ["code", "tests"],
                        "approver": "code_reviewer"
                    }
                ],
                "barriers": [],
                "verificationGates": [
                    {
                        "id": "gate-1",
                        "title": "Planning DB test",
                        "type": "command",
                        "command": "cargo test planning_session_revision_and_materialization_are_durable",
                        "requiredEvidence": ["test output"]
                    }
                ]
            }
        })
    }

    fn valid_multi_task_planning_draft() -> Value {
        json!({
            "title": "Multi task planning",
            "summary": "채팅으로 들어온 작업을 여러 Task로 나누고 모두 실행 준비한다.",
            "scope": ["chat", "planning", "handoff"],
            "tasks": [
                {
                    "id": "task-1",
                    "title": "Chat intake",
                    "description": "오케스트레이터 입력을 계획 세션으로 넘긴다.",
                    "subtasks": ["입력 저장", "계획자 호출"],
                    "acceptanceCriteria": ["채팅 입력이 계획 세션으로 생성된다."],
                    "risks": [],
                    "testPlan": ["npm test"]
                },
                {
                    "id": "task-2",
                    "title": "Agent handoff",
                    "description": "승인된 계획의 Task를 다음 role 실행으로 넘긴다.",
                    "subtasks": ["Task materialize", "다음 role queue"],
                    "acceptanceCriteria": ["생성 Task가 모두 Queued run을 가진다."],
                    "risks": [],
                    "testPlan": ["cargo test"]
                }
            ],
            "openQuestions": [],
            "risks": [],
            "executablePlan": {
                "taskGraph": [
                    { "id": "task-1", "title": "Chat intake", "dependsOn": [], "parallelizable": true, "batch": "batch-1" },
                    { "id": "task-2", "title": "Agent handoff", "dependsOn": ["task-1"], "parallelizable": false, "batch": "batch-2" }
                ],
                "taskCards": [
                    {
                        "id": "task-1",
                        "title": "Chat intake",
                        "ownerRole": "coder",
                        "goal": "오케스트레이터 입력을 계획 세션으로 넘긴다.",
                        "inputs": ["chat message"],
                        "outputs": ["planning session"],
                        "acceptanceCriteria": ["채팅 입력이 계획 세션으로 생성된다."],
                        "verificationGates": ["gate-1"]
                    },
                    {
                        "id": "task-2",
                        "title": "Agent handoff",
                        "ownerRole": "coder",
                        "goal": "승인된 계획의 Task를 다음 role 실행으로 넘긴다.",
                        "inputs": ["approved plan"],
                        "outputs": ["queued runs"],
                        "acceptanceCriteria": ["생성 Task가 모두 Queued run을 가진다."],
                        "verificationGates": ["gate-2"]
                    }
                ],
                "ownershipMap": [
                    {
                        "ownerRole": "coder",
                        "responsibilities": ["구현", "검증"],
                        "artifacts": ["code", "tests"],
                        "approver": "code_reviewer"
                    }
                ],
                "barriers": [],
                "verificationGates": [
                    {
                        "id": "gate-1",
                        "title": "Chat intake check",
                        "type": "command",
                        "command": "npm test",
                        "requiredEvidence": ["test output"]
                    },
                    {
                        "id": "gate-2",
                        "title": "Handoff check",
                        "type": "command",
                        "command": "cargo test",
                        "requiredEvidence": ["test output"]
                    }
                ]
            }
        })
    }

    #[test]
    fn planning_session_revision_and_materialization_are_durable() {
        let repo = test_repo();
        let (mut conn, project) = open_test_project(&repo);

        let session = create_planning_session(
            &mut conn,
            &project.id,
            CreatePlanningSessionInput {
                title: Some("DB backed planning".to_string()),
                goal_text: "계획을 DB에 저장하고 승인 시 Task로 만든다.".to_string(),
                jira_ref: None,
                jira_state: None,
            },
        )
        .expect("create planning session");
        assert_eq!(session.session.status, "Drafting");
        assert_eq!(session.messages.len(), 1);
        let vault = repo.root.join("obsidian-vault");
        update_settings(
            &conn,
            &project.id,
            ProjectSettingsPatch {
                role_presets: None,
                ai_connections: None,
                role_assignments: None,
                role_policies: None,
                conductor_config: None,
                worktree_root: None,
                worktree_setup: None,
                jira_config: None,
                obsidian_vault_path: Some(Some(vault.to_string_lossy().to_string())),
                obsidian_artifact_path: None,
                token_budget: None,
                artifact_retention_days: None,
            },
        )
        .expect("enable obsidian vault");

        let saved = save_plan_draft_revision(
            &mut conn,
            &repo.root,
            &project.id,
            &session.session.id,
            SavePlanDraftRevisionInput {
                draft_json: valid_planning_draft(),
                plan_markdown: Some("# DB backed planning".to_string()),
                planner_message: Some("draft 저장".to_string()),
            },
        )
        .expect("save draft");
        let draft = saved.session.current_draft.as_ref().expect("current draft");
        assert_eq!(saved.session.status, "ReadyForApproval");
        assert_eq!(draft.task_count, 1);
        assert_eq!(draft.task_graph_count, 1);
        assert_eq!(draft.verification_gate_count, 1);
        assert_eq!(
            saved
                .session
                .current_approval
                .as_ref()
                .map(|approval| approval.status.as_str()),
            Some("Pending")
        );
        assert!(draft
            .artifact_path
            .as_ref()
            .is_some_and(|path| path.ends_with("/draft-v1.md")));
        assert!(draft
            .content_hash
            .as_ref()
            .is_some_and(|hash| hash.starts_with("fnv1a64:")));
        assert!(repo
            .root
            .join(draft.artifact_path.as_ref().expect("artifact path"))
            .exists());
        let obsidian_plan_dir = vault
            .join("projects")
            .join(slug_for_path(&project.name))
            .join("desktop")
            .join("plans");
        let obsidian_files = fs::read_dir(&obsidian_plan_dir)
            .expect("obsidian plan dir")
            .collect::<Result<Vec<_>, _>>()
            .expect("obsidian files");
        assert_eq!(obsidian_files.len(), 1);
        let obsidian_content =
            fs::read_to_string(obsidian_files[0].path()).expect("obsidian plan content");
        assert!(obsidian_content.contains("helmDraftRevision: 1"));
        assert!(obsidian_content.contains("helmArtifactPath: .helm/planning/"));
        assert!(obsidian_content.contains("# DB backed planning"));

        let sessions = list_planning_sessions(&conn, &project.id).expect("list sessions");
        assert_eq!(sessions.len(), 1);
        assert_eq!(
            sessions[0].current_draft_id.as_deref(),
            Some(draft.id.as_str())
        );

        let approval_error = materialize_plan_draft(&mut conn, &project.id, &draft.id)
            .expect_err("materialization requires approval");
        assert_eq!(approval_error.code, "PlanDraftApprovalRequired");
        let approved = approve_plan_draft(
            &mut conn,
            &project.id,
            &draft.id,
            DecidePlanDraftInput {
                reason: Some("test approval".to_string()),
            },
        )
        .expect("approve draft");
        assert_eq!(
            approved
                .session
                .current_approval
                .as_ref()
                .map(|approval| approval.status.as_str()),
            Some("Approved")
        );

        let materialized =
            materialize_plan_draft(&mut conn, &project.id, &draft.id).expect("materialize draft");
        assert_eq!(materialized.task_ids.len(), 1);
        let first_task_id = materialized.task_ids[0].clone();
        let first_task = get_task(&conn, &first_task_id).expect("materialized task");
        assert_eq!(first_task.status, "Ready");
        let next_run =
            prepare_next_role_context(&mut conn, &repo.root, &project.id, &first_task_id)
                .expect("materialized task starts next role");
        assert_eq!(next_run.role_id, "coder");
        assert_eq!(next_run.status, "Queued");
        let materialized_again =
            materialize_plan_draft(&mut conn, &project.id, &draft.id).expect("idempotent");
        assert_eq!(materialized_again.id, materialized.id);
        assert_eq!(materialized_again.task_ids, materialized.task_ids);

        let detail = get_planning_session(&conn, &project.id, &session.session.id)
            .expect("get approved session");
        assert_eq!(detail.session.status, "Approved");
        assert_eq!(
            detail
                .session
                .materialization
                .as_ref()
                .map(|item| item.id.as_str()),
            Some(materialized.id.as_str())
        );
    }

    #[test]
    fn invalid_plan_draft_without_executable_plan_is_rejected() {
        let repo = test_repo();
        let (mut conn, project) = open_test_project(&repo);
        let session = create_planning_session(
            &mut conn,
            &project.id,
            CreatePlanningSessionInput {
                title: None,
                goal_text: "invalid draft 검증".to_string(),
                jira_ref: None,
                jira_state: None,
            },
        )
        .expect("create planning session");

        let error = save_plan_draft_revision(
            &mut conn,
            &repo.root,
            &project.id,
            &session.session.id,
            SavePlanDraftRevisionInput {
                draft_json: json!({
                    "title": "Invalid",
                    "summary": "executablePlan 누락",
                    "tasks": [{"title": "task"}]
                }),
                plan_markdown: None,
                planner_message: None,
            },
        )
        .expect_err("invalid executablePlan rejected");
        assert_eq!(error.code, "ValidationFailed");
        assert!(error.details.unwrap_or_default().contains("executablePlan"));
    }

    #[test]
    fn parallel_owned_files_overlap_is_rejected() {
        let repo = test_repo();
        let (mut conn, project) = open_test_project(&repo);
        let session = create_planning_session(
            &mut conn,
            &project.id,
            CreatePlanningSessionInput {
                title: None,
                goal_text: "parallel ownership 검증".to_string(),
                jira_ref: None,
                jira_state: None,
            },
        )
        .expect("create planning session");

        let error = save_plan_draft_revision(
            &mut conn,
            &repo.root,
            &project.id,
            &session.session.id,
            SavePlanDraftRevisionInput {
                draft_json: json!({
                    "title": "Parallel overlap",
                    "summary": "병렬 task ownership 충돌을 검증한다.",
                    "tasks": [
                        {"title": "Task A"},
                        {"title": "Task B"}
                    ],
                    "executablePlan": {
                        "taskGraph": [
                            {
                                "id": "task-a",
                                "title": "Task A",
                                "dependsOn": [],
                                "parallelizable": true,
                                "batch": "batch-1"
                            },
                            {
                                "id": "task-b",
                                "title": "Task B",
                                "dependsOn": [],
                                "parallelizable": true,
                                "batch": "batch-1"
                            }
                        ],
                        "taskCards": [
                            {
                                "id": "task-a",
                                "title": "Task A",
                                "ownerRole": "coder",
                                "goal": "A를 구현한다.",
                                "inputs": ["Plan Document"],
                                "outputs": ["A evidence"],
                                "ownedFiles": ["apps/desktop/src/App.tsx"],
                                "sharedFiles": [],
                                "generatedFiles": [],
                                "generatedFilePolicy": "Generated files are read-only unless a generator command is listed.",
                                "reportContract": "taskId/status/changedFiles/verification/blockers",
                                "acceptanceCriteria": ["A 완료"],
                                "verificationGates": ["gate-a"]
                            },
                            {
                                "id": "task-b",
                                "title": "Task B",
                                "ownerRole": "coder",
                                "goal": "B를 구현한다.",
                                "inputs": ["Plan Document"],
                                "outputs": ["B evidence"],
                                "ownedFiles": ["apps/desktop/src/App.tsx"],
                                "sharedFiles": [],
                                "generatedFiles": [],
                                "generatedFilePolicy": "Generated files are read-only unless a generator command is listed.",
                                "reportContract": "taskId/status/changedFiles/verification/blockers",
                                "acceptanceCriteria": ["B 완료"],
                                "verificationGates": ["gate-a"]
                            }
                        ],
                        "ownershipMap": [
                            {
                                "ownerRole": "coder",
                                "responsibilities": ["병렬 task ownership 유지"],
                                "artifacts": ["code diff"],
                                "approver": "code_reviewer"
                            }
                        ],
                        "barriers": [],
                        "verificationGates": [
                            {
                                "id": "gate-a",
                                "title": "Typecheck",
                                "type": "command",
                                "command": "pnpm --dir apps/desktop typecheck",
                                "requiredEvidence": ["typecheck output"]
                            }
                        ]
                    }
                }),
                plan_markdown: None,
                planner_message: None,
            },
        )
        .expect_err("parallel ownedFiles overlap rejected");
        assert_eq!(error.code, "ValidationFailed");
        assert!(error.details.unwrap_or_default().contains("ownedFiles"));
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
            None,
        )
        .expect("host run")
    }

    fn migrate_through_phase10(conn: &mut Connection) {
        apply_migration(conn, 1, "phase1", PHASE1_MIGRATION).expect("phase1");
        apply_migration(conn, 2, "phase2_runs_approvals", PHASE2_MIGRATION).expect("phase2");
        apply_migration(conn, 3, "phase3a_worktrees", PHASE3A_MIGRATION).expect("phase3");
        apply_migration(conn, 4, "evidence_gate_timeline", PHASE4_MIGRATION).expect("phase4");
        apply_migration(conn, 5, "phase5_run_events", PHASE5_MIGRATION).expect("phase5");
        apply_migration(conn, 6, "phase6_run_lifecycle", PHASE6_MIGRATION).expect("phase6");
        apply_migration(conn, 7, "phase7_repair_run_links", PHASE7_MIGRATION).expect("phase7");
        apply_migration(conn, 8, "phase8_planning_workspace", PHASE8_MIGRATION).expect("phase8");
        apply_migration(
            conn,
            9,
            "phase9_planning_approvals_artifacts",
            PHASE9_MIGRATION,
        )
        .expect("phase9");
        apply_migration(conn, 10, "phase10_terminal_orca_parity", PHASE10_MIGRATION)
            .expect("phase10");
    }

    #[test]
    fn tasks_awaiting_merge_with_pr_returns_only_mergewaiting_with_pr_number() {
        let mut conn = Connection::open_in_memory().expect("in-memory db");
        run_migrations(&mut conn).expect("migrate");
        let ts = "2026-06-12T00:00:00Z";
        let project_id = new_id();
        conn.execute(
            "INSERT INTO projects (id, root_path, name, base_branch, created_at, updated_at)
             VALUES (?1, '/tmp/helm', 'Helm', 'main', ?2, ?2)",
            params![&project_id, ts],
        )
        .expect("project");

        // MergeWaiting + PR ref -> included.
        let waiting = new_id();
        // MergeWaiting, no PR ref -> excluded.
        let waiting_no_pr = new_id();
        // Coding + PR ref -> excluded (wrong status).
        let coding = new_id();
        for (id, status) in [
            (&waiting, "MergeWaiting"),
            (&waiting_no_pr, "MergeWaiting"),
            (&coding, "Coding"),
        ] {
            conn.execute(
                "INSERT INTO tasks (id, project_id, title, description, status, sort_order, created_at, updated_at, last_transition_at)
                 VALUES (?1, ?2, 't', '', ?3, 0, ?4, ?4, ?4)",
                params![id, &project_id, status, ts],
            )
            .expect("task");
        }
        insert_pr_ref(&conn, &project_id, &waiting, "https://x/pull/42", 42).expect("pr ref");
        insert_pr_ref(&conn, &project_id, &coding, "https://x/pull/7", 7).expect("pr ref");

        let result = tasks_awaiting_merge_with_pr(&conn, &project_id).expect("query");
        assert_eq!(result, vec![(waiting, 42)]);
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
        assert_eq!(version, SUPPORTED_SCHEMA_VERSION);
    }

    #[test]
    fn migration_backfills_runner_metadata_from_request_event() {
        let mut conn = Connection::open_in_memory().expect("in-memory db");
        migrate_through_phase10(&mut conn);
        let timestamp = "2026-06-12T00:00:00Z";
        let project_id = new_id();
        let task_id = new_id();
        let run_id = new_id();
        let missing_run_id = new_id();

        conn.execute(
            "INSERT INTO projects (id, root_path, name, base_branch, created_at, updated_at)
             VALUES (?1, '/tmp/helm-control-tower', 'Helm', 'main', ?2, ?2)",
            params![&project_id, timestamp],
        )
        .expect("insert project");
        conn.execute(
            "INSERT INTO tasks (
               id, project_id, title, description, status, sort_order, created_at, updated_at, last_transition_at
             )
             VALUES (?1, ?2, 'Control Tower', '', 'Ready', 0, ?3, ?3, ?3)",
            params![&task_id, &project_id, timestamp],
        )
        .expect("insert task");
        for run_id in [&run_id, &missing_run_id] {
            conn.execute(
                "INSERT INTO agent_runs (
                   id, project_id, task_id, role_id, status, artifact_dir, summary_path, result_path,
                   stdout_log_path, stderr_log_path, created_at, updated_at
                 )
                 VALUES (?1, ?2, ?3, 'coder', 'Running', '.helm/artifacts/runs/test',
                         'summary.md', 'structured-result.json', 'stdout.log', 'stderr.log', ?4, ?4)",
                params![run_id, &project_id, &task_id, timestamp],
            )
            .expect("insert run");
        }
        conn.execute(
            "INSERT INTO run_events (
               id, project_id, task_id, run_id, seq, kind, message, payload_json, created_at
             )
             VALUES (?1, ?2, ?3, ?4, 1, 'system', 'Runner request captured', ?5, ?6)",
            params![
                new_id(),
                &project_id,
                &task_id,
                &run_id,
                json!({
                    "provider": "codex",
                    "connectionId": "codex-local",
                    "model": "gpt-5.4"
                })
                .to_string(),
                timestamp
            ],
        )
        .expect("insert runner event");
        conn.execute(
            "INSERT INTO run_events (
               id, project_id, task_id, run_id, seq, kind, message, payload_json, created_at
             )
             VALUES (?1, ?2, ?3, ?4, 1, 'system', 'Runner request captured', '{}', ?5)",
            params![new_id(), &project_id, &task_id, &missing_run_id, timestamp],
        )
        .expect("insert missing runner event");

        run_migrations(&mut conn).expect("phase11 migration");

        let run = get_agent_run(&conn, &run_id).expect("run");
        assert_eq!(run.provider.as_deref(), Some("codex"));
        assert_eq!(run.connection_id.as_deref(), Some("codex-local"));
        assert_eq!(run.model.as_deref(), Some("gpt-5.4"));

        let missing_run = get_agent_run(&conn, &missing_run_id).expect("missing run");
        assert_eq!(missing_run.provider, None);
        assert_eq!(missing_run.connection_id, None);
        assert_eq!(missing_run.model, None);
    }

    #[test]
    fn list_project_runs_returns_recent_runs_across_tasks() {
        let repo = test_repo();
        let (mut conn, project) = open_test_project(&repo);
        let first_task = create_test_task(&mut conn, &project.id);
        let second_task = create_task(
            &mut conn,
            &project.id,
            CreateTaskInput {
                epic_id: None,
                title: "Second task".to_string(),
                description: None,
                external_refs: None,
                worktree_mode: Some("worktree".to_string()),
            },
        )
        .expect("second task");
        let older_run_id = new_id();
        let latest_run_id = new_id();

        conn.execute(
            "INSERT INTO agent_runs (
               id, project_id, task_id, role_id, status, artifact_dir, summary_path, result_path,
               stdout_log_path, stderr_log_path, provider, connection_id, model, created_at, updated_at
             )
             VALUES (?1, ?2, ?3, 'planner', 'Succeeded', '.helm/artifacts/runs/older',
                     'summary.md', 'structured-result.json', 'stdout.log', 'stderr.log',
                     'claude', 'claude-local', 'claude-sonnet', '2026-06-12T00:00:00Z', '2026-06-12T00:00:00Z')",
                params![&older_run_id, &project.id, &first_task.id],
        )
        .expect("older run");
        conn.execute(
            "INSERT INTO agent_runs (
               id, project_id, task_id, role_id, status, artifact_dir, summary_path, result_path,
               stdout_log_path, stderr_log_path, provider, connection_id, model, created_at, updated_at
             )
             VALUES (?1, ?2, ?3, 'coder', 'Running', '.helm/artifacts/runs/latest',
                     'summary.md', 'structured-result.json', 'stdout.log', 'stderr.log',
                     'gemini', 'gemini-local', 'gemini-2.5-pro', '2026-06-12T00:01:00Z', '2026-06-12T00:01:00Z')",
            params![&latest_run_id, &project.id, &second_task.id],
        )
        .expect("latest run");

        let limited = list_project_runs(&conn, &project.id, 1).expect("limited runs");
        assert_eq!(limited.len(), 1);
        assert_eq!(limited[0].id, latest_run_id);
        assert_eq!(limited[0].provider.as_deref(), Some("gemini"));
        assert_eq!(limited[0].connection_id.as_deref(), Some("gemini-local"));
        assert_eq!(limited[0].model.as_deref(), Some("gemini-2.5-pro"));

        let all_runs = list_project_runs(&conn, &project.id, 10).expect("project runs");
        assert_eq!(
            all_runs
                .iter()
                .map(|run| run.id.as_str())
                .collect::<Vec<_>>(),
            vec![latest_run_id.as_str(), older_run_id.as_str(),]
        );
    }

    #[test]
    fn materialized_multi_task_plan_can_queue_every_created_task() {
        let repo = test_repo();
        let (mut conn, project) = open_test_project(&repo);
        let session = create_planning_session(
            &mut conn,
            &project.id,
            CreatePlanningSessionInput {
                title: Some("Multi task planning".to_string()),
                goal_text: "채팅 지시를 여러 Task로 나누고 모두 실행 준비한다.".to_string(),
                jira_ref: None,
                jira_state: None,
            },
        )
        .expect("create planning session");
        let saved = save_plan_draft_revision(
            &mut conn,
            &repo.root,
            &project.id,
            &session.session.id,
            SavePlanDraftRevisionInput {
                draft_json: valid_multi_task_planning_draft(),
                plan_markdown: Some("# Multi task planning".to_string()),
                planner_message: Some("multi draft 저장".to_string()),
            },
        )
        .expect("save draft");
        let draft_id = saved
            .session
            .current_draft_id
            .as_deref()
            .expect("draft id")
            .to_string();
        approve_plan_draft(
            &mut conn,
            &project.id,
            &draft_id,
            DecidePlanDraftInput {
                reason: Some("multi approval".to_string()),
            },
        )
        .expect("approve draft");
        let materialized =
            materialize_plan_draft(&mut conn, &project.id, &draft_id).expect("materialize");
        assert_eq!(materialized.task_ids.len(), 2);

        let mut queued_roles = Vec::new();
        for task_id in &materialized.task_ids {
            let run = prepare_next_role_context(&mut conn, &repo.root, &project.id, task_id)
                .expect("queue next role");
            assert_eq!(run.status, "Queued");
            queued_roles.push(run.role_id);
        }

        assert_eq!(queued_roles, vec!["coder", "coder"]);
    }

    #[test]
    fn list_agent_sessions_projects_runs_into_session_cards() {
        let repo = test_repo();
        let (mut conn, project) = open_test_project(&repo);
        let task = create_test_task(&mut conn, &project.id);
        let run_id = new_id();

        conn.execute(
            "INSERT INTO task_worktrees (
               id, project_id, task_id, branch_name, worktree_path, base_branch, head_hash,
               status, created_at, updated_at
             )
             VALUES (?1, ?2, ?3, 'feature/acp-session', '/tmp/helm-acp-session', 'main', NULL,
                     'Active', '2026-06-18T00:00:00Z', '2026-06-18T00:00:00Z')",
            params![new_id(), &project.id, &task.id],
        )
        .expect("worktree");
        conn.execute(
            "INSERT INTO agent_runs (
               id, project_id, task_id, role_id, status, artifact_dir, summary_path, result_path,
               stdout_log_path, stderr_log_path, provider, connection_id, model, started_at, created_at, updated_at
             )
             VALUES (?1, ?2, ?3, 'coder', 'Running', '.helm/artifacts/runs/session',
                     'summary.md', 'structured-result.json', 'stdout.log', 'stderr.log',
                     'codex', 'codex-local', 'gpt-5', '2026-06-18T00:00:00Z',
                     '2026-06-18T00:00:00Z', '2026-06-18T00:00:00Z')",
            params![&run_id, &project.id, &task.id],
        )
        .expect("run");
        conn.execute(
            "INSERT INTO run_events (
               id, project_id, task_id, run_id, seq, kind, message, payload_json, created_at
             )
             VALUES (?1, ?2, ?3, ?4, 1, 'status', 'working', '{}', '2026-06-18T00:01:00Z')",
            params![new_id(), &project.id, &task.id, &run_id],
        )
        .expect("event");

        let sessions = list_agent_sessions(&conn, &project.id, 10).expect("sessions");

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, run_id);
        assert_eq!(sessions[0].source_run_id.as_deref(), Some(run_id.as_str()));
        assert_eq!(sessions[0].title, task.title);
        assert_eq!(sessions[0].provider.as_deref(), Some("codex"));
        assert_eq!(sessions[0].model.as_deref(), Some("gpt-5"));
        assert_eq!(sessions[0].branch.as_deref(), Some("feature/acp-session"));
        assert_eq!(
            sessions[0].worktree_path.as_deref(),
            Some("/tmp/helm-acp-session")
        );
        assert_eq!(
            sessions[0].last_signal_at.as_deref(),
            Some("2026-06-18T00:01:00Z")
        );
        assert_eq!(sessions[0].next_action, "watch");
        assert_eq!(sessions[0].event_count, 1);
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
    fn role_dossier_contracts_are_role_specific() {
        assert_eq!(role_dossier_artifact_name("planner"), "plan.md");
        assert_eq!(role_dossier_artifact_name("coder"), "pr-dossier.md");
        assert_eq!(
            role_dossier_artifact_name("plan_verifier"),
            "plan-verification.md"
        );
        assert_eq!(
            role_dossier_artifact_name("code_reviewer"),
            "review-report.md"
        );
        assert_eq!(role_dossier_artifact_name("tester"), "test-report.md");
        assert!(role_dossier_contract_markdown("coder").contains("PR 본문 초안"));
        assert!(role_dossier_contract_markdown("tester").contains("실행한 테스트"));
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
    fn plan_approval_does_not_create_next_run_without_explicit_prepare() {
        let repo = test_repo();
        let (mut conn, project) = open_test_project(&repo);
        let task = create_test_task(&mut conn, &project.id);

        run_stub_role(&mut conn, &repo.root, &project.id, &task.id, "planner").expect("planner");
        let approval = list_approvals(&conn, &project.id, Some("Pending".to_string()))
            .expect("approvals")
            .remove(0);

        decide_approval(&mut conn, &project.id, &approval.id, "Approved", "승인").expect("approve");

        let run_count_after_approval: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM agent_runs WHERE task_id = ?1",
                params![&task.id],
                |row| row.get(0),
            )
            .expect("run count");
        assert_eq!(run_count_after_approval, 1);

        let next =
            prepare_next_role_context(&mut conn, &repo.root, &project.id, &task.id).expect("next");
        assert_eq!(next.role_id, "coder");
        assert_eq!(next.status, "Queued");
    }

    #[test]
    fn task_graph_export_writes_empty_board() {
        let repo = test_repo();
        let (conn, project) = open_test_project(&repo);

        let exported =
            export_task_graph(&conn, &repo.root, &project.id, false).expect("export graph");

        assert_eq!(exported.task_count, 0);
        assert!(exported.content.contains("# Helm Task Graph"));
        assert!(exported.content.contains("No tasks yet"));
        assert!(task_graph_path(&repo.root).exists());
        let conflict = check_task_graph_conflict(&repo.root).expect("conflict");
        assert!(conflict.exists);
        assert!(!conflict.conflict);
    }

    #[test]
    fn task_graph_export_includes_run_blocker_and_detects_conflict() {
        let repo = test_repo();
        let (mut conn, project) = open_test_project(&repo);
        let task = create_test_task(&mut conn, &project.id);
        ensure_task_worktree(&mut conn, &repo.root, &project.id, &task.id).expect("worktree");
        let run = prepare_role_context(&mut conn, &repo.root, &project.id, &task.id, "planner")
            .expect("context");
        conn.execute(
            "UPDATE agent_runs
             SET status = 'TimedOut',
                 result_status = 'needs_changes',
                 lifecycle_phase = 'failed',
                 failure_kind = 'timeout',
                 failure_reason = 'test timeout',
                 updated_at = ?1
             WHERE id = ?2",
            params![now(), &run.id],
        )
        .expect("mark timeout");

        let exported =
            export_task_graph(&conn, &repo.root, &project.id, false).expect("export graph");

        assert!(exported.content.contains("Fixture core loop"));
        assert!(exported
            .content
            .contains("Active role/run: 설계자 · TimedOut"));
        assert!(exported.content.contains("Latest blocker: 시간 초과"));
        assert!(exported.content.contains("summary.md"));

        fs::write(
            task_graph_path(&repo.root),
            format!("{}\nmanual edit\n", exported.content),
        )
        .expect("manual edit");
        let conflict = check_task_graph_conflict(&repo.root).expect("conflict");
        assert!(conflict.conflict);
        assert!(export_task_graph(&conn, &repo.root, &project.id, false).is_err());
        let forced = export_task_graph(&conn, &repo.root, &project.id, true).expect("force");
        assert!(!forced.conflict.conflict);
    }

    #[test]
    fn coordination_export_writes_manifest_and_compacted_events() {
        let repo = test_repo();
        let (mut conn, project) = open_test_project(&repo);
        let task = create_test_task(&mut conn, &project.id);
        ensure_task_worktree(&mut conn, &repo.root, &project.id, &task.id).expect("worktree");
        let run = prepare_role_context(&mut conn, &repo.root, &project.id, &task.id, "planner")
            .expect("context");
        append_run_event(
            &conn,
            &project.id,
            &task.id,
            &run.id,
            "stdout",
            "noisy output",
            json!({ "delta": "noisy output" }),
        )
        .expect("stdout event");
        append_run_event(
            &conn,
            &project.id,
            &task.id,
            &run.id,
            "system",
            "semantic signal",
            json!({ "type": "test.signal" }),
        )
        .expect("system event");

        let exported =
            export_coordination_snapshot(&conn, &repo.root, &project.id).expect("coordination");

        assert_eq!(exported.task_count, 1);
        assert_eq!(exported.run_count, 1);
        assert!(exported.message_count >= 3);
        assert!(coordination_export_path(&repo.root)
            .join("manifest.json")
            .exists());
        assert!(coordination_export_path(&repo.root)
            .join(format!("tasks/{}.json", task.id))
            .exists());
        assert!(coordination_export_path(&repo.root)
            .join(format!("runs/{}.json", run.id))
            .exists());
        let manifest_raw =
            fs::read_to_string(coordination_export_path(&repo.root).join("manifest.json"))
                .expect("manifest");
        let manifest: Value = serde_json::from_str(&manifest_raw).expect("manifest json");
        assert_eq!(manifest["schemaVersion"], 1);
        assert_eq!(manifest["projectId"], project.id);
        assert!(manifest["exportContentHash"].as_str().unwrap_or("").len() >= 16);
        let message_files = fs::read_dir(coordination_export_path(&repo.root).join("messages"))
            .expect("messages")
            .collect::<Result<Vec<_>, _>>()
            .expect("message entries");
        let exported_messages = message_files
            .iter()
            .map(|entry| fs::read_to_string(entry.path()).expect("message"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(exported_messages.contains("semantic signal"));
        assert!(!exported_messages.contains("noisy output"));
    }

    #[test]
    fn coordination_export_removes_stale_entity_files() {
        let repo = test_repo();
        let (mut conn, project) = open_test_project(&repo);
        let task = create_test_task(&mut conn, &project.id);
        ensure_task_worktree(&mut conn, &repo.root, &project.id, &task.id).expect("worktree");
        let run = prepare_role_context(&mut conn, &repo.root, &project.id, &task.id, "planner")
            .expect("context");

        export_coordination_snapshot(&conn, &repo.root, &project.id).expect("first export");
        assert!(coordination_export_path(&repo.root)
            .join(format!("tasks/{}.json", task.id))
            .exists());
        assert!(coordination_export_path(&repo.root)
            .join(format!("runs/{}.json", run.id))
            .exists());

        conn.execute("DELETE FROM run_events WHERE run_id = ?1", params![run.id])
            .expect("delete events");
        conn.execute("DELETE FROM agent_runs WHERE id = ?1", params![run.id])
            .expect("delete run");
        conn.execute("DELETE FROM tasks WHERE id = ?1", params![task.id])
            .expect("delete task");

        let exported =
            export_coordination_snapshot(&conn, &repo.root, &project.id).expect("second export");
        assert_eq!(exported.task_count, 0);
        assert_eq!(exported.run_count, 0);
        assert!(!coordination_export_path(&repo.root)
            .join(format!("tasks/{}.json", task.id))
            .exists());
        assert!(!coordination_export_path(&repo.root)
            .join(format!("runs/{}.json", run.id))
            .exists());
        assert!(coordination_export_path(&repo.root)
            .join("manifest.json")
            .exists());
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
        assert_eq!(run.lifecycle_phase.as_deref(), Some("queued"));
        assert_eq!(run.attempt, 1);
        let events = list_run_events(&conn, &project.id, &run.id).expect("events");
        assert_eq!(events.len(), 3);
        assert_eq!(events[0].kind, "status");
        assert_eq!(events[0].message, "Queued");
        assert_eq!(events[1].kind, "artifact");
        assert_eq!(events[1].message, "Context Pack created");
        assert_eq!(events[2].kind, "artifact");
        assert_eq!(
            events[2].message,
            "Summary and structured result placeholders created"
        );

        let artifact_dir = repo.root.join(&run.artifact_dir);
        assert!(artifact_dir.join("context-pack.md").exists());
        assert!(artifact_dir.join("context-pack.json").exists());
        assert!(artifact_dir.join("structured-result.schema.json").exists());
        assert!(artifact_dir.join("pr-dossier.md").exists());

        let context_pack =
            fs::read_to_string(artifact_dir.join("context-pack.md")).expect("context pack");
        assert!(context_pack.contains("## Role Contract"));
        assert!(context_pack.contains("## Role Dossier Contract"));
        assert!(context_pack.contains("pr-dossier.md"));
        assert!(context_pack.contains("## Upstream Role Dossiers"));
        assert!(context_pack.contains("plan.md"));
        assert!(context_pack.contains("stub runner가 pass 결과를 생성했습니다."));
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
        assert!(manifest["expectedArtifacts"]
            .as_array()
            .expect("expected artifacts")
            .contains(&json!("pr-dossier.md")));
    }

    #[test]
    fn prepare_role_context_includes_worktree_setup_config() {
        let repo = test_repo();
        let (mut conn, project) = open_test_project(&repo);
        let task = create_test_task(&mut conn, &project.id);
        fs::create_dir_all(repo.root.join(".helm")).expect("helm dir");
        fs::write(
            repo.root.join(".helm").join("worktree-setup.json"),
            r#"{
              "steps": [
                { "name": "install", "command": "pnpm install" },
                { "name": "test", "command": "pnpm test" }
              ]
            }"#,
        )
        .expect("setup config");
        ensure_task_worktree(&mut conn, &repo.root, &project.id, &task.id).expect("worktree");

        let run = prepare_role_context(&mut conn, &repo.root, &project.id, &task.id, "planner")
            .expect("context");
        let artifact_dir = repo.root.join(&run.artifact_dir);
        assert!(artifact_dir.join("worktree-setup.json").exists());

        let context_pack =
            fs::read_to_string(artifact_dir.join("context-pack.md")).expect("context pack");
        assert!(context_pack.contains("## Worktree Setup"));
        assert!(context_pack.contains("pnpm install"));

        let manifest: Value = serde_json::from_str(
            &fs::read_to_string(artifact_dir.join("context-pack.json")).expect("manifest"),
        )
        .expect("manifest json");
        assert_eq!(
            manifest["worktreeSetup"]["steps"][0]["command"],
            "pnpm install"
        );
    }

    #[test]
    fn prepare_role_context_includes_enabled_role_policy() {
        let repo = test_repo();
        let (mut conn, project) = open_test_project(&repo);
        let task = create_test_task(&mut conn, &project.id);
        run_stub_role(&mut conn, &repo.root, &project.id, &task.id, "planner").expect("planner");
        let approval = list_approvals(&conn, &project.id, Some("Pending".to_string()))
            .expect("approvals")
            .remove(0);
        decide_approval(&mut conn, &project.id, &approval.id, "Approved", "승인").expect("approve");
        fs::create_dir_all(repo.root.join(".helm").join("policies")).expect("policy dir");
        fs::write(
            repo.root.join(".helm").join("policies").join("coder.md"),
            "# Coder Policy\n\n- 정책 문서를 우선한다.\n",
        )
        .expect("policy");
        update_settings(
            &conn,
            &project.id,
            ProjectSettingsPatch {
                role_presets: None,
                ai_connections: None,
                role_assignments: None,
                role_policies: Some(json!([
                    {
                        "roleId": "coder",
                        "path": ".helm/policies/coder.md",
                        "enabled": true
                    }
                ])),
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
        .expect("settings");
        ensure_task_worktree(&mut conn, &repo.root, &project.id, &task.id).expect("worktree");

        let run = prepare_role_context(&mut conn, &repo.root, &project.id, &task.id, "coder")
            .expect("context");
        let artifact_dir = repo.root.join(&run.artifact_dir);
        let context_pack =
            fs::read_to_string(artifact_dir.join("context-pack.md")).expect("context pack");
        assert!(context_pack.contains("## Role Policy"));
        assert!(context_pack.contains("# Coder Policy"));
        assert!(context_pack.contains("정책 문서를 우선한다."));

        let manifest: Value = serde_json::from_str(
            &fs::read_to_string(artifact_dir.join("context-pack.json")).expect("manifest"),
        )
        .expect("manifest json");
        assert_eq!(manifest["rolePolicy"]["enabled"], true);
        assert_eq!(manifest["rolePolicy"]["path"], ".helm/policies/coder.md");
        assert!(manifest["rolePolicy"]["contentHash"]
            .as_str()
            .is_some_and(|hash| hash.starts_with("fnv1a64:")));
    }

    #[test]
    fn prepare_role_context_includes_project_team_instruction_docs() {
        let repo = test_repo();
        let (mut conn, project) = open_test_project(&repo);
        let task = create_test_task(&mut conn, &project.id);
        fs::write(
            repo.root.join("AGENTS.md"),
            "# Team Skill\n\n- 프로젝트 공용 스킬을 따른다.\n",
        )
        .expect("agents");
        fs::create_dir_all(repo.root.join(".claude")).expect("claude dir");
        fs::write(
            repo.root.join(".claude").join("CLAUDE.md"),
            "# Claude Team Rules\n\n- 리뷰 전 타입체크를 실행한다.\n",
        )
        .expect("claude");
        fs::create_dir_all(repo.root.join(".agents").join("skills").join("team-skill"))
            .expect("skill dir");
        fs::write(
            repo.root
                .join(".agents")
                .join("skills")
                .join("team-skill")
                .join("SKILL.md"),
            "# Team Shared Skill\n\n- 공용 스킬 절차를 적용한다.\n",
        )
        .expect("skill");
        ensure_task_worktree(&mut conn, &repo.root, &project.id, &task.id).expect("worktree");

        let run = prepare_role_context(&mut conn, &repo.root, &project.id, &task.id, "planner")
            .expect("context");
        let artifact_dir = repo.root.join(&run.artifact_dir);
        let context_pack =
            fs::read_to_string(artifact_dir.join("context-pack.md")).expect("context pack");
        assert!(context_pack.contains("## Team Instructions"));
        assert!(context_pack.contains("AGENTS.md"));
        assert!(context_pack.contains("프로젝트 공용 스킬을 따른다."));
        assert!(context_pack.contains(".claude/CLAUDE.md"));
        assert!(context_pack.contains(".agents/skills/team-skill/SKILL.md"));
        assert!(context_pack.contains("공용 스킬 절차를 적용한다."));

        let manifest: Value = serde_json::from_str(
            &fs::read_to_string(artifact_dir.join("context-pack.json")).expect("manifest"),
        )
        .expect("manifest json");
        let docs = manifest["teamInstructions"].as_array().expect("team docs");
        assert_eq!(docs.len(), 3);
        assert_eq!(docs[0]["path"], "AGENTS.md");
        assert_eq!(docs[2]["path"], ".agents/skills/team-skill/SKILL.md");
        assert!(docs[0]["contentHash"]
            .as_str()
            .is_some_and(|hash| hash.starts_with("fnv1a64:")));
    }

    #[test]
    fn write_obsidian_run_artifact_saves_session_note_when_vault_is_configured() {
        let repo = test_repo();
        let (mut conn, project) = open_test_project(&repo);
        let task = create_test_task(&mut conn, &project.id);
        let vault = repo.root.join("obsidian-vault");
        update_settings(
            &conn,
            &project.id,
            ProjectSettingsPatch {
                role_presets: None,
                ai_connections: None,
                role_assignments: None,
                role_policies: None,
                conductor_config: None,
                worktree_root: None,
                worktree_setup: None,
                jira_config: None,
                obsidian_vault_path: Some(Some(vault.to_string_lossy().to_string())),
                obsidian_artifact_path: None,
                token_budget: None,
                artifact_retention_days: None,
            },
        )
        .expect("enable obsidian vault");
        ensure_task_worktree(&mut conn, &repo.root, &project.id, &task.id).expect("worktree");
        let run = prepare_role_context(&mut conn, &repo.root, &project.id, &task.id, "planner")
            .expect("context");

        let relative_path = write_obsidian_run_artifact(
            &conn,
            &project.id,
            &task,
            &run,
            "Succeeded",
            Some("pass"),
            2,
            "2026-06-18T04:00:00Z",
            "검증 완료",
            Some("# 계획서\n\n검증 dossier"),
        )
        .expect("write obsidian")
        .expect("obsidian path");
        let content = fs::read_to_string(vault.join(relative_path)).expect("obsidian content");
        assert!(content.contains("status: Succeeded"));
        assert!(content.contains("resultStatus: pass"));
        assert!(content.contains("changedFileCount: 2"));
        assert!(content.contains("검증 완료"));
        assert!(content.contains("## 역할별 산출물"));
        assert!(content.contains("검증 dossier"));
    }

    #[test]
    fn write_obsidian_run_artifact_uses_configured_artifact_path() {
        let repo = test_repo();
        let (mut conn, project) = open_test_project(&repo);
        let task = create_test_task(&mut conn, &project.id);
        let vault = repo.root.join("obsidian-vault");
        update_settings(
            &conn,
            &project.id,
            ProjectSettingsPatch {
                role_presets: None,
                ai_connections: None,
                role_assignments: None,
                role_policies: None,
                conductor_config: None,
                worktree_root: None,
                worktree_setup: None,
                jira_config: None,
                obsidian_vault_path: Some(Some(vault.to_string_lossy().to_string())),
                obsidian_artifact_path: Some(Some("custom-artifacts".to_string())),
                token_budget: None,
                artifact_retention_days: None,
            },
        )
        .expect("enable obsidian artifact path");
        ensure_task_worktree(&mut conn, &repo.root, &project.id, &task.id).expect("worktree");
        let run = prepare_role_context(&mut conn, &repo.root, &project.id, &task.id, "planner")
            .expect("context");

        let relative_path = write_obsidian_run_artifact(
            &conn,
            &project.id,
            &task,
            &run,
            "Succeeded",
            Some("pass"),
            1,
            "2026-06-18T04:00:00Z",
            "구현 완료",
            Some("# 계획서\n\n구현 dossier"),
        )
        .expect("write obsidian")
        .expect("obsidian path");

        assert!(relative_path.contains("desktop/sessions"));
        let content = fs::read_to_string(vault.join("custom-artifacts").join(relative_path))
            .expect("custom obsidian content");
        assert!(content.contains("구현 dossier"));
    }

    #[test]
    fn create_run_approval_records_pending_agent_run_approval() {
        let repo = test_repo();
        let (mut conn, project) = open_test_project(&repo);
        let task = create_test_task(&mut conn, &project.id);
        ensure_task_worktree(&mut conn, &repo.root, &project.id, &task.id).expect("worktree");
        let run = prepare_role_context(&mut conn, &repo.root, &project.id, &task.id, "planner")
            .expect("context");

        let approval = create_run_approval(
            &conn,
            &project.id,
            &task.id,
            &run.id,
            "Codex command approval requested: pnpm test",
        )
        .expect("approval");

        assert_eq!(approval.approval_type, "RunApproval");
        assert_eq!(approval.entity_type, "AgentRun");
        assert_eq!(approval.entity_id, run.id);
        assert_eq!(approval.status, "Pending");
        let pending =
            list_approvals(&conn, &project.id, Some("Pending".to_string())).expect("pending");
        assert!(pending.iter().any(|item| item.id == approval.id));
    }

    #[test]
    fn claim_host_run_is_atomic_and_records_running_event() {
        let repo = test_repo();
        let (mut conn, project) = open_test_project(&repo);
        let task = create_test_task(&mut conn, &project.id);
        ensure_task_worktree(&mut conn, &repo.root, &project.id, &task.id).expect("worktree");

        let run = prepare_role_context(&mut conn, &repo.root, &project.id, &task.id, "planner")
            .expect("context");
        let mut event_sink: Option<&mut dyn FnMut(&RunEventSummary)> = None;
        let claimed = claim_host_run(
            &conn,
            &project.id,
            &run.id,
            json!({
                "runner": "test",
                "provider": "codex",
                "connectionId": "codex-local",
                "model": "gpt-5.4"
            }),
            &mut event_sink,
        )
        .expect("claim");
        assert_eq!(claimed.status, "Running");
        assert_eq!(claimed.lifecycle_phase.as_deref(), Some("running"));
        assert!(claimed.claimed_at.is_some());
        assert!(claimed.heartbeat_at.is_some());
        assert_eq!(claimed.provider.as_deref(), Some("codex"));
        assert_eq!(claimed.connection_id.as_deref(), Some("codex-local"));
        assert_eq!(claimed.model.as_deref(), Some("gpt-5.4"));

        let duplicate = claim_host_run(
            &conn,
            &project.id,
            &run.id,
            json!({ "runner": "test" }),
            &mut event_sink,
        )
        .expect_err("duplicate claim should be rejected");
        assert_eq!(duplicate.code, "RunAlreadyClaimed");

        let events = list_run_events(&conn, &project.id, &run.id).expect("events");
        assert!(events
            .iter()
            .any(|event| event.kind == "status" && event.message == "Running"));
    }

    #[test]
    fn fixture_host_core_loop_reaches_merge_waiting() {
        let repo = test_repo();
        let (mut conn, project) = open_test_project(&repo);
        let task = create_test_task(&mut conn, &project.id);
        let vault = repo.root.join("obsidian-vault");
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
                role_policies: None,
                conductor_config: None,
                worktree_root: None,
                worktree_setup: None,
                jira_config: None,
                obsidian_vault_path: Some(Some(vault.to_string_lossy().to_string())),
                obsidian_artifact_path: None,
                token_budget: None,
                artifact_retention_days: None,
            },
        )
        .expect("settings");
        ensure_task_worktree(&mut conn, &repo.root, &project.id, &task.id).expect("worktree");

        let planner = run_prepared_host_role(&mut conn, &repo, &project.id, &task.id, "planner");
        assert_eq!(planner.status, "Succeeded");
        // 회고 학습 승인(RoleLesson)이 같은 pending 목록에 섞이므로 타입으로 명시 선택한다.
        let approval = list_approvals(&conn, &project.id, Some("Pending".to_string()))
            .expect("approvals")
            .into_iter()
            .find(|approval| approval.approval_type == "PlanApproval")
            .expect("pending plan approval");
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
        // 작업 완료 후 리뷰 진행 승인 게이트: 승인해야 코드 리뷰어가 실행된다.
        let review_approval = list_approvals(&conn, &project.id, Some("Pending".to_string()))
            .expect("review approvals")
            .into_iter()
            .find(|approval| approval.approval_type == "ReviewApproval")
            .expect("pending review approval");
        decide_approval(
            &mut conn,
            &project.id,
            &review_approval.id,
            "Approved",
            "리뷰 진행 승인",
        )
        .expect("approve review");
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

        let session_dir = vault
            .join("projects")
            .join(slug_for_path(&project.name))
            .join("desktop")
            .join("sessions");
        let session_notes = fs::read_dir(session_dir)
            .expect("obsidian sessions")
            .collect::<Result<Vec<_>, _>>()
            .expect("obsidian session files");
        assert_eq!(session_notes.len(), 5);
    }

    #[test]
    fn review_roles_skip_run_approval() {
        assert!(is_review_role("code_reviewer"));
        assert!(!is_review_role("coder"));
        assert!(!is_review_role("planner"));
    }

    #[test]
    fn code_reviewer_blocked_until_review_approval() {
        let repo = test_repo();
        let (mut conn, project) = open_test_project(&repo);
        let task = create_test_task(&mut conn, &project.id);
        update_task_status(
            &mut conn,
            &project.id,
            &task.id,
            "CodeReview",
            Some("리뷰 게이트 테스트".to_string()),
        )
        .expect("status");
        ensure_task_worktree(&mut conn, &repo.root, &project.id, &task.id).expect("worktree");

        // 승인 전: 코드 리뷰어 준비가 리뷰 진행 승인 게이트에서 막힌다.
        let err = prepare_role_context(
            &mut conn,
            &repo.root,
            &project.id,
            &task.id,
            "code_reviewer",
        )
        .expect_err("review approval 전에는 막혀야 한다");
        assert!(
            err.message.contains("리뷰 진행 승인"),
            "unexpected error: {}",
            err.message
        );

        // 승인 후: 같은 게이트 에러는 더 이상 발생하지 않는다(이후 단계는 별도 설정 필요).
        let timestamp = now();
        conn.execute(
            "INSERT INTO approvals (
               id, project_id, entity_type, entity_id, approval_type, status,
               requested_reason, requested_at, created_at, updated_at
             )
             VALUES (?1, ?2, 'Task', ?3, 'ReviewApproval', 'Approved', '승인', ?4, ?4, ?4)",
            params![new_id(), &project.id, &task.id, timestamp],
        )
        .expect("insert review approval");
        if let Err(err) = prepare_role_context(
            &mut conn,
            &repo.root,
            &project.id,
            &task.id,
            "code_reviewer",
        ) {
            assert!(
                !err.message.contains("리뷰 진행 승인"),
                "승인 후에는 게이트를 통과해야 한다: {}",
                err.message
            );
        }
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
                role_policies: None,
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
            None,
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
                role_policies: None,
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
            None,
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
    fn prepare_repair_context_links_run_and_limits_scope() {
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
                    },
                    {
                        "roleId": "coder",
                        "label": "구현자",
                        "provider": "fixture",
                        "commandArgs": ["node", script.to_string_lossy(), "--mode", "pass"],
                        "timeoutSeconds": 60
                    }
                ])),
                ai_connections: None,
                role_assignments: None,
                role_policies: None,
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
        .expect("settings");
        ensure_task_worktree(&mut conn, &repo.root, &project.id, &task.id).expect("worktree");

        let gate_run = prepare_role_context(
            &mut conn,
            &repo.root,
            &project.id,
            &task.id,
            "plan_verifier",
        )
        .expect("context");
        run_host_role(
            &mut conn,
            &repo.root,
            &project.id,
            &gate_run.id,
            Arc::new(AtomicBool::new(false)),
            None,
        )
        .expect("host run");
        let repair_id: String = conn
            .query_row(
                "SELECT id FROM repair_requests WHERE run_id = ?1 AND status = 'Open'",
                params![gate_run.id],
                |row| row.get(0),
            )
            .expect("repair id");

        let repair_run = prepare_repair_context(&mut conn, &repo.root, &project.id, &repair_id)
            .expect("repair context");
        assert_eq!(repair_run.role_id, "coder");
        assert_eq!(repair_run.status, "Queued");
        assert_eq!(
            repair_run.repair_request_id.as_deref(),
            Some(repair_id.as_str())
        );
        assert_eq!(repair_run.attempt, 1);
        let context_pack = fs::read_to_string(
            repo.root
                .join(&repair_run.artifact_dir)
                .join("context-pack.md"),
        )
        .expect("context pack");
        assert!(context_pack.contains("## Targeted Repair"));
        assert!(context_pack.contains("Repair fixture gate failure"));
        assert!(context_pack.contains("README.md"));

        let finished = run_host_role(
            &mut conn,
            &repo.root,
            &project.id,
            &repair_run.id,
            Arc::new(AtomicBool::new(false)),
            None,
        )
        .expect("repair run");
        assert_eq!(finished.status, "Succeeded");

        let repair_status: String = conn
            .query_row(
                "SELECT status FROM repair_requests WHERE id = ?1",
                params![repair_id],
                |row| row.get(0),
            )
            .expect("repair status");
        assert_eq!(repair_status, "Resolved");
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
                role_policies: None,
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
            None,
        )
        .expect("host run");
        assert_eq!(finished.status, "NeedsInspection");
        assert_eq!(finished.result_status.as_deref(), Some("pass"));

        let updated_task = get_task(&conn, &task.id).expect("task");
        assert_eq!(updated_task.status, "Blocked");

        let rules_gate_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM gate_results
                 WHERE run_id = ?1 AND gate = 'rules' AND status = 'fail' AND blocking = 1",
                params![run.id],
                |row| row.get(0),
            )
            .expect("gate count");
        assert_eq!(rules_gate_count, 1);

        let repair_id: String = conn
            .query_row(
                "SELECT id FROM repair_requests WHERE run_id = ?1 AND status = 'Open'",
                params![run.id],
                |row| row.get(0),
            )
            .expect("repair id");

        // Blocked가 됐어도 게이트 결함이므로 수동 repair는 coder로 라우팅돼야 한다.
        let repair_run = prepare_repair_context(&mut conn, &repo.root, &project.id, &repair_id)
            .expect("repair context");
        assert_eq!(repair_run.role_id, "coder");
    }

    #[test]
    fn coder_host_run_needs_inspection_without_gate_advances_to_review() {
        // 구현자 run이 실행은 끝났지만 자동 판정 근거(structured-result schema)가 부족한
        // NeedsInspection이면, Ready로 되돌려 준비됨에서 멈추는 대신 리뷰 단계
        // (PlanVerification)로 전이해야 한다. blocking gate도 diff 불일치도 없는 케이스다.
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
                        "commandArgs": ["node", script.to_string_lossy(), "--mode", "schema_invalid"],
                        "timeoutSeconds": 60
                    }
                ])),
                ai_connections: None,
                role_assignments: None,
                role_policies: None,
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
            None,
        )
        .expect("host run");
        assert_eq!(finished.status, "NeedsInspection");

        let updated_task = get_task(&conn, &task.id).expect("task");
        assert_eq!(updated_task.status, "PlanVerification");
    }

    #[test]
    fn delete_task_cleanup_removes_worktree_dir_and_branch() {
        // delete_task는 DB만 cascade로 지운다. 명령 계층(main.rs)이 그 뒤에 하는 디스크
        // worktree/브랜치 정리(git::remove_worktree + delete_branch)까지 묶어, 세션 삭제 후
        // 고아 worktree/브랜치가 남지 않는지 검증한다.
        let repo = test_repo();
        let (mut conn, project) = open_test_project(&repo);
        let task = create_test_task(&mut conn, &project.id);
        let worktree =
            ensure_task_worktree(&mut conn, &repo.root, &project.id, &task.id).expect("worktree");
        let worktree_path = PathBuf::from(&worktree.worktree_path);
        assert!(worktree_path.exists());
        assert!(git::branch_exists(&repo.root, &worktree.branch_name).expect("branch_exists"));

        // 명령 계층 순서 재현: 정보 확보 → DB 삭제 → 디스크/브랜치 정리.
        let saved = get_task_worktree(&conn, &project.id, &task.id)
            .expect("get worktree")
            .expect("worktree row");
        delete_task(&mut conn, &project.id, &task.id).expect("delete task");
        git::remove_worktree(&repo.root, &PathBuf::from(&saved.worktree_path)).expect("remove wt");
        git::delete_branch(&repo.root, &saved.branch_name, false).expect("delete branch");

        assert!(!worktree_path.exists());
        assert!(!git::branch_exists(&repo.root, &saved.branch_name).expect("branch_exists"));
        assert!(get_task(&conn, &task.id).is_err());
    }

    #[test]
    fn delete_task_removes_task_scoped_chat_messages() {
        // 채팅은 프로젝트 단일 스레드라 source_run_id↔task 매핑으로만 task에 묶인다.
        // task 삭제 시 그 run에 묶인 채팅 요약은 사라지고, 일반 메시지는 남아야 한다.
        let repo = test_repo();
        let (mut conn, project) = open_test_project(&repo);
        let task = create_test_task(&mut conn, &project.id);
        let run =
            prepare_next_role_context(&mut conn, &repo.root, &project.id, &task.id).expect("next");
        cancel_task_runs(&conn, &project.id, &task.id).expect("cancel");

        append_conversation_message(&conn, &project.id, "user", "안녕", None).expect("plain msg");
        append_conversation_message(&conn, &project.id, "assistant", "요약", Some(&run.id))
            .expect("run msg");
        assert_eq!(
            list_conversation_messages(&conn, &project.id).expect("list").len(),
            2
        );

        delete_task(&mut conn, &project.id, &task.id).expect("delete");

        let remaining = list_conversation_messages(&conn, &project.id).expect("list after");
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].source_run_id, None);
    }

    #[test]
    fn cancel_task_runs_lets_delete_proceed_past_active_guard() {
        // 세션 삭제는 진행 중 run을 막지 않고 함께 정리해야 한다. cancel_task_runs가 활성 run을
        // Canceled로 내려 delete_task의 "실행 중이면 거부" 가드를 통과시키는지 검증한다.
        let repo = test_repo();
        let (mut conn, project) = open_test_project(&repo);
        let task = create_test_task(&mut conn, &project.id);
        let run =
            prepare_next_role_context(&mut conn, &repo.root, &project.id, &task.id).expect("next");
        assert_eq!(run.status, "Queued");

        // 활성 run이 있으면 삭제가 거부된다(기존 가드).
        assert!(delete_task(&mut conn, &project.id, &task.id).is_err());

        cancel_task_runs(&conn, &project.id, &task.id).expect("cancel");
        let canceled = get_agent_run(&conn, &run.id).expect("run");
        assert_eq!(canceled.status, "Canceled");
        assert!(list_active_runs_for_task(&conn, &project.id, &task.id)
            .expect("active")
            .is_empty());

        // 이제 가드를 통과해 삭제된다.
        delete_task(&mut conn, &project.id, &task.id).expect("delete after cancel");
        assert!(get_task(&conn, &task.id).is_err());
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
    fn reconcile_next_role_gap_queues_missing_coder_after_approval() {
        let repo = test_repo();
        let (mut conn, project) = open_test_project(&repo);
        let task = create_test_task(&mut conn, &project.id);

        run_stub_role(&mut conn, &repo.root, &project.id, &task.id, "planner").expect("planner");
        let approval = list_approvals(&conn, &project.id, Some("Pending".to_string()))
            .expect("approvals")
            .remove(0);
        decide_approval(&mut conn, &project.id, &approval.id, "Approved", "승인").expect("approve");

        let run = reconcile_next_role_gap(&mut conn, &repo.root, &project.id)
            .expect("reconcile")
            .expect("queued run");

        assert_eq!(run.role_id, "coder");
        assert_eq!(run.status, "Queued");
        let second =
            reconcile_next_role_gap(&mut conn, &repo.root, &project.id).expect("reconcile again");
        assert!(second.is_none());
    }

    #[test]
    fn reconcile_next_role_gap_does_not_start_planner() {
        let repo = test_repo();
        let (mut conn, project) = open_test_project(&repo);
        create_test_task(&mut conn, &project.id);

        let run = reconcile_next_role_gap(&mut conn, &repo.root, &project.id).expect("reconcile");

        assert!(run.is_none());
    }

    #[test]
    fn exclude_baseline_untracked_silences_noise_and_dedups() {
        let repo = test_repo();
        let wt = repo.root.join("wt");
        run_git(
            &repo.root,
            &[
                "worktree",
                "add",
                "-b",
                "helm/x",
                wt.to_str().unwrap(),
                "HEAD",
            ],
        );
        // git-lfs/husky 훅이 만들어낸 것처럼 untracked 노이즈를 만든다.
        fs::create_dir_all(wt.join(".husky/_")).expect("husky dir");
        fs::write(wt.join(".husky/_/post-checkout"), "noise\n").expect("hook");
        assert!(!git::changed_files(&wt).expect("status").is_empty());

        git::exclude_baseline_untracked(&wt);
        assert!(
            git::changed_files(&wt).expect("status").is_empty(),
            "baseline 노이즈가 exclude 후에도 잡힘"
        );

        // 두 번 호출해도 exclude에 중복 추가하지 않는다.
        let exclude = repo.root.join(".git/info/exclude");
        let before = fs::read_to_string(&exclude).unwrap_or_default();
        git::exclude_baseline_untracked(&wt);
        let after = fs::read_to_string(&exclude).unwrap_or_default();
        assert_eq!(before, after, "exclude 중복 추가됨");
    }

    #[test]
    fn ensure_dossier_instruction_appends_when_missing() {
        let mut placeholders = HashMap::new();
        placeholders.insert("dossierPath".to_string(), "/runs/x/plan.md".to_string());

        // 템플릿이 dossier를 안 쓰면 프롬프트(마지막 인자)에 보강된다.
        let stale = vec![
            "claude".to_string(),
            "-p".to_string(),
            "Read ctx, write summary and result.".to_string(),
        ];
        let fixed = ensure_dossier_instruction(stale, &placeholders);
        assert!(fixed.last().unwrap().contains("/runs/x/plan.md"));

        // 이미 dossier를 참조하면 그대로 둔다(중복 보강 없음).
        let ok = vec![
            "claude".to_string(),
            "-p".to_string(),
            "Read ctx, write summary, result, /runs/x/plan.md.".to_string(),
        ];
        let unchanged = ensure_dossier_instruction(ok.clone(), &placeholders);
        assert_eq!(unchanged, ok);
    }

    #[test]
    fn multi_reviewer_pins_selected_connection() {
        let settings = EffectiveSettings {
            role_presets: default_role_presets(),
            ai_connections: json!([
                {
                    "id": "claude-a",
                    "label": "Reviewer A",
                    "provider": "claude",
                    "commandArgs": ["claude", "--", "review-a"],
                    "timeoutSeconds": 120,
                    "enabled": true
                },
                {
                    "id": "claude-b",
                    "label": "Reviewer B",
                    "provider": "claude",
                    "commandArgs": ["claude", "--", "review-b"],
                    "timeoutSeconds": 120,
                    "enabled": true
                }
            ]),
            role_assignments: json!([
                {
                    "roleId": "code_reviewer",
                    "selectionMode": "multiple",
                    "connectionIds": ["claude-a", "claude-b"],
                    "selections": [
                        { "connectionId": "claude-a" },
                        { "connectionId": "claude-b" }
                    ],
                    "aggregationPolicy": "all_pass"
                }
            ]),
            role_policies: default_role_policies(),
            conductor_config: None,
            worktree_root: None,
            worktree_setup: None,
            jira_config: None,
            obsidian_vault_path: None,
            obsidian_artifact_path: None,
            token_budget: None,
            artifact_retention_days: Some(30),
        };
        let placeholders = HashMap::new();

        // 배정된 리뷰어 connection은 selections 순서대로 나열된다(all_pass 기준 목록).
        assert_eq!(
            role_connection_ids(&settings, "code_reviewer"),
            vec!["claude-a".to_string(), "claude-b".to_string()]
        );

        // pin이 없으면 첫 번째 리뷰어, pin이 있으면 해당 리뷰어 명령으로 해석된다.
        let first = resolve_host_runner_command(&settings, "code_reviewer", None, &placeholders)
            .expect("first reviewer");
        assert_eq!(first.connection_id.as_deref(), Some("claude-a"));
        assert!(first.args.contains(&"review-a".to_string()));

        let pinned = resolve_host_runner_command(
            &settings,
            "code_reviewer",
            Some("claude-b"),
            &placeholders,
        )
        .expect("pinned reviewer");
        assert_eq!(pinned.connection_id.as_deref(), Some("claude-b"));
        assert!(pinned.args.contains(&"review-b".to_string()));
    }

    #[test]
    fn decider_is_opt_in_among_reviewers() {
        // 결정권자(decider) 플래그가 없으면 None → 기존 all_pass 동작이 유지된다(opt-in).
        let base = |selections: Value| EffectiveSettings {
            role_presets: default_role_presets(),
            ai_connections: json!([]),
            role_assignments: json!([
                {
                    "roleId": "code_reviewer",
                    "selectionMode": "multiple",
                    "connectionIds": ["claude-a", "claude-b"],
                    "selections": selections,
                    "aggregationPolicy": "all_pass"
                }
            ]),
            role_policies: default_role_policies(),
            conductor_config: None,
            worktree_root: None,
            worktree_setup: None,
            jira_config: None,
            obsidian_vault_path: None,
            obsidian_artifact_path: None,
            token_budget: None,
            artifact_retention_days: Some(30),
        };

        // decider 플래그 없음 → None.
        let without = base(json!([
            { "connectionId": "claude-a" },
            { "connectionId": "claude-b" }
        ]));
        assert_eq!(decider_connection_id(&without, "code_reviewer"), None);

        // 한 selection에 decider=true → 그 connectionId가 게이트가 된다.
        let with = base(json!([
            { "connectionId": "claude-a" },
            { "connectionId": "claude-b", "decider": true }
        ]));
        assert_eq!(
            decider_connection_id(&with, "code_reviewer").as_deref(),
            Some("claude-b")
        );

        // 기본 role assignment 묶음에는 더 이상 arbiter가 없다.
        let defaults = default_role_assignments();
        assert!(defaults
            .as_array()
            .map(|items| items
                .iter()
                .all(|item| item.get("roleId").and_then(Value::as_str) != Some("arbiter")))
            .unwrap_or(false));
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
                    "defaultModel": "gpt-5.5",
                    "env": { "CODEX_HOME": "/tmp/codex-alt" },
                    "runnerAdapter": "codex_app_server",
                    "approvalPolicy": "on-request",
                    "sandbox": "workspace-write"
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
            role_policies: default_role_policies(),
            conductor_config: None,
            worktree_root: None,
            worktree_setup: None,
            jira_config: None,
            obsidian_vault_path: None,
            obsidian_artifact_path: None,
            token_budget: None,
            artifact_retention_days: Some(30),
        };
        let placeholders = HashMap::from([
            ("worktreePath".to_string(), "/tmp/helm-worktree".to_string()),
            ("roleId".to_string(), "coder".to_string()),
        ]);

        let command =
            resolve_host_runner_command(&settings, "coder", None, &placeholders).expect("command");

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
        assert_eq!(command.runner_adapter, RunnerAdapterKind::CodexAppServer);
        assert_eq!(command.approval_policy.as_deref(), Some("on-request"));
        assert_eq!(command.sandbox.as_deref(), Some("workspace-write"));
        assert_eq!(
            command.env,
            vec![("CODEX_HOME".to_string(), "/tmp/codex-alt".to_string())]
        );
    }

    #[test]
    fn role_assignment_command_adds_artifact_dir_for_claude() {
        let settings = EffectiveSettings {
            role_presets: default_role_presets(),
            ai_connections: json!([
                {
                    "id": "claude-local",
                    "label": "Claude CLI",
                    "provider": "claude",
                    "commandArgs": ["claude", "-p", "run {roleId}"],
                    "timeoutSeconds": 120,
                    "enabled": true,
                    "defaultModel": "sonnet"
                }
            ]),
            role_assignments: json!([
                {
                    "roleId": "coder",
                    "selectionMode": "single",
                    "connectionIds": ["claude-local"],
                    "selections": [{ "connectionId": "claude-local", "model": null }],
                    "aggregationPolicy": null
                }
            ]),
            role_policies: default_role_policies(),
            conductor_config: None,
            worktree_root: None,
            worktree_setup: None,
            jira_config: None,
            obsidian_vault_path: None,
            obsidian_artifact_path: None,
            token_budget: None,
            artifact_retention_days: Some(30),
        };
        let placeholders = HashMap::from([
            (
                "artifactDir".to_string(),
                "/tmp/helm-artifacts/run-1".to_string(),
            ),
            ("roleId".to_string(), "coder".to_string()),
        ]);

        let command =
            resolve_host_runner_command(&settings, "coder", None, &placeholders).expect("command");

        assert_eq!(
            command.args,
            vec![
                "claude",
                "--add-dir",
                "/tmp/helm-artifacts/run-1",
                "--permission-mode",
                "bypassPermissions",
                "--model",
                "sonnet",
                "-p",
                "run coder"
            ]
        );
    }

    #[test]
    fn role_assignment_command_adds_gemini_model_and_artifact_dir() {
        let settings = EffectiveSettings {
            role_presets: default_role_presets(),
            ai_connections: json!([
                {
                    "id": "gemini-local",
                    "label": "Gemini CLI",
                    "provider": "gemini",
                    "commandArgs": ["gemini", "--skip-trust", "--approval-mode", "yolo", "--prompt", "run {roleId}"],
                    "timeoutSeconds": 120,
                    "enabled": true,
                    "defaultModel": "gemini-2.5-pro"
                }
            ]),
            role_assignments: json!([
                {
                    "roleId": "coder",
                    "selectionMode": "single",
                    "connectionIds": ["gemini-local"],
                    "selections": [{ "connectionId": "gemini-local", "model": null }],
                    "aggregationPolicy": null
                }
            ]),
            role_policies: default_role_policies(),
            conductor_config: None,
            worktree_root: None,
            worktree_setup: None,
            jira_config: None,
            obsidian_vault_path: None,
            obsidian_artifact_path: None,
            token_budget: None,
            artifact_retention_days: Some(30),
        };
        let placeholders = HashMap::from([
            (
                "artifactDir".to_string(),
                "/tmp/helm-artifacts/run-1".to_string(),
            ),
            ("roleId".to_string(), "coder".to_string()),
        ]);

        let command =
            resolve_host_runner_command(&settings, "coder", None, &placeholders).expect("command");

        assert_eq!(
            command.args,
            vec![
                "gemini",
                "--include-directories",
                "/tmp/helm-artifacts/run-1",
                "--model",
                "gemini-2.5-pro",
                "--skip-trust",
                "--approval-mode",
                "yolo",
                "--prompt",
                "run coder"
            ]
        );
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
        conn.execute(
            "INSERT INTO approvals (
               id, project_id, entity_type, entity_id, approval_type, status,
               requested_reason, decision_reason, requested_at, decided_at, created_at, updated_at
             )
             VALUES (?1, ?2, 'AgentRun', ?3, 'RunApproval', 'Pending',
                     'test approval', NULL, ?4, NULL, ?4, ?4)",
            params![new_id(), project.id, run_id, timestamp],
        )
        .expect("insert pending run approval");

        let reattach = reconcile_interrupted_runs(&conn, &project.id).expect("reconcile");
        // host_pid가 없으므로 재연결 대상이 아니라 orphaned 처리된다.
        assert!(reattach.is_empty());

        let run = get_agent_run(&conn, &run_id).expect("run");
        assert_eq!(run.status, "NeedsInspection");
        assert_eq!(run.lifecycle_phase.as_deref(), Some("orphaned"));
        assert_eq!(run.failure_kind.as_deref(), Some("orphaned_after_restart"));
        assert!(run.finished_at.is_some());
        let approval_status: String = conn
            .query_row(
                "SELECT status FROM approvals WHERE entity_id = ?1",
                params![run_id],
                |row| row.get(0),
            )
            .expect("approval status");
        assert_eq!(approval_status, "Expired");
    }

    #[test]
    fn ensure_task_worktree_inplace_uses_current_branch_and_protects_main() {
        let repo = test_repo();
        let (mut conn, project) = open_test_project(&repo);

        // 1) 비보호 브랜치에서 in-place: 그 브랜치를 그대로 쓰고, worktree_path = root.
        run_git(&repo.root, &["checkout", "-b", "feature/work"]);
        let task = create_task(
            &mut conn,
            &project.id,
            CreateTaskInput {
                epic_id: None,
                title: "inplace".to_string(),
                description: None,
                external_refs: None,
                worktree_mode: Some("current_branch".to_string()),
            },
        )
        .expect("task");
        let wt = ensure_task_worktree(&mut conn, &repo.root, &project.id, &task.id).expect("wt");
        assert_eq!(wt.worktree_path, repo.root.to_string_lossy());
        assert_eq!(wt.branch_name, "feature/work");

        // 2) 보호 브랜치(main)에서 in-place: main을 직접 건드리지 않고 새 helm/ 브랜치를 체크아웃.
        run_git(&repo.root, &["checkout", "main"]);
        let task2 = create_task(
            &mut conn,
            &project.id,
            CreateTaskInput {
                epic_id: None,
                title: "on main".to_string(),
                description: None,
                external_refs: None,
                worktree_mode: Some("current_branch".to_string()),
            },
        )
        .expect("task2");
        let wt2 = ensure_task_worktree(&mut conn, &repo.root, &project.id, &task2.id).expect("wt2");
        assert_eq!(wt2.worktree_path, repo.root.to_string_lossy());
        assert!(
            wt2.branch_name.starts_with("helm/"),
            "got {}",
            wt2.branch_name
        );
        assert_eq!(
            git::current_branch(&repo.root).as_deref(),
            Some(wt2.branch_name.as_str())
        );
    }

    #[test]
    fn reap_stale_running_runs_reaps_only_idle_past_timeout() {
        let repo = test_repo();
        let (mut conn, project) = open_test_project(&repo);
        let task = create_test_task(&mut conn, &project.id);

        let fresh_id = new_id();
        let stale_id = new_id();
        let fresh_hb = now();
        // 기본 role timeout(1800s) + grace(120s)를 한참 넘긴 과거 heartbeat.
        let stale_hb = (Utc::now() - chrono::Duration::hours(3)).to_rfc3339();

        for (id, heartbeat) in [(&fresh_id, &fresh_hb), (&stale_id, &stale_hb)] {
            conn.execute(
                "INSERT INTO agent_runs (
                   id, project_id, task_id, role_id, status, artifact_dir, summary_path, result_path,
                   stdout_log_path, stderr_log_path, started_at, heartbeat_at, created_at, updated_at
                 )
                 VALUES (?1, ?2, ?3, 'coder', 'Running', ?4, 'summary.md', 'structured-result.json',
                         'stdout.log', 'stderr.log', ?5, ?5, ?5, ?5)",
                params![id, project.id, task.id, ".helm/artifacts/runs/reap-test", heartbeat],
            )
            .expect("insert running run");
        }

        let reaped = reap_stale_running_runs(&conn, &project.id).expect("reap");
        assert_eq!(reaped, vec![stale_id.clone()]);

        let stale = get_agent_run(&conn, &stale_id).expect("stale run");
        assert_eq!(stale.status, "NeedsInspection");
        assert_eq!(
            stale.failure_kind.as_deref(),
            Some("orphaned_stale_heartbeat")
        );
        assert!(stale.finished_at.is_some());

        // 방금 heartbeat을 찍은 run은 살아있는 것으로 보고 건드리지 않는다.
        let fresh = get_agent_run(&conn, &fresh_id).expect("fresh run");
        assert_eq!(fresh.status, "Running");
    }

    #[test]
    fn running_run_worktree_paths_reports_only_running_runs_paths() {
        let repo = test_repo();
        let (mut conn, project) = open_test_project(&repo);
        let task_a = create_test_task(&mut conn, &project.id);
        let task_b = create_test_task(&mut conn, &project.id);

        for (task_id, path) in [(&task_a.id, "/wt/a"), (&task_b.id, "/wt/b")] {
            conn.execute(
                "INSERT INTO task_worktrees (
                   id, project_id, task_id, branch_name, worktree_path, base_branch, head_hash,
                   status, created_at, updated_at
                 )
                 VALUES (?1, ?2, ?3, 'helm/x', ?4, 'main', NULL, 'Active', ?5, ?5)",
                params![new_id(), project.id, task_id, path, now()],
            )
            .expect("insert worktree");
        }

        // task_a만 Running, task_b는 Queued.
        conn.execute(
            "INSERT INTO agent_runs (
               id, project_id, task_id, role_id, status, artifact_dir, summary_path, result_path,
               stdout_log_path, stderr_log_path, created_at, updated_at
             )
             VALUES (?1, ?2, ?3, 'coder', 'Running', ?4, 's.md', 'r.json', 'o.log', 'e.log', ?5, ?5)",
            params![new_id(), project.id, task_a.id, ".helm/a", now()],
        )
        .expect("running run");
        conn.execute(
            "INSERT INTO agent_runs (
               id, project_id, task_id, role_id, status, artifact_dir, summary_path, result_path,
               stdout_log_path, stderr_log_path, created_at, updated_at
             )
             VALUES (?1, ?2, ?3, 'coder', 'Queued', ?4, 's.md', 'r.json', 'o.log', 'e.log', ?5, ?5)",
            params![new_id(), project.id, task_b.id, ".helm/b", now()],
        )
        .expect("queued run");

        assert_eq!(count_running_agent_runs(&conn, &project.id).expect("count"), 1);
        assert_eq!(
            running_run_worktree_paths(&conn, &project.id).expect("paths"),
            vec!["/wt/a".to_string()]
        );
    }

    #[test]
    fn host_log_tailer_follows_appended_bytes() {
        let dir = std::env::temp_dir().join(format!("helm-tail-{}", new_id()));
        fs::create_dir_all(&dir).expect("temp dir");
        fs::write(dir.join("stdout.log"), b"hello").expect("seed stdout");
        fs::write(dir.join("stderr.log"), b"").expect("seed stderr");

        let mut tailer = HostLogTailer::open(&dir);
        let (mut out, mut err) = (Vec::new(), Vec::new());
        tailer.drain(&mut out, &mut err, &mut |_, _| {});
        assert_eq!(out, b"hello");

        // 같은 핸들에서 추가분이 follow 되어야 한다(detached 자식 출력 tail의 핵심 가정).
        let mut file = fs::OpenOptions::new()
            .append(true)
            .open(dir.join("stdout.log"))
            .expect("reopen stdout");
        file.write_all(b" world").expect("append");
        file.flush().expect("flush");

        tailer.drain(&mut out, &mut err, &mut |_, _| {});
        assert_eq!(out, b"hello world");

        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn host_pid_is_alive_detects_current_and_missing() {
        assert!(host_pid_is_alive(std::process::id()));
        assert!(!host_pid_is_alive(2_000_000_000));
    }

    #[test]
    fn pending_run_approval_for_orphaned_run_is_hidden() {
        let repo = test_repo();
        let (mut conn, project) = open_test_project(&repo);
        let task = create_test_task(&mut conn, &project.id);
        let timestamp = now();
        let run_id = new_id();
        conn.execute(
            "INSERT INTO agent_runs (
               id, project_id, task_id, role_id, status, artifact_dir, summary_path, result_path,
               stdout_log_path, stderr_log_path, result_status, started_at, finished_at,
               lifecycle_phase, failure_kind, failure_reason, created_at, updated_at
             )
             VALUES (?1, ?2, ?3, 'coder', 'NeedsInspection', ?4, 'summary.md', 'structured-result.json',
                     'stdout.log', 'stderr.log', 'needs_changes', ?5, ?5,
                     'orphaned', 'orphaned_after_restart',
                     'Helm app restarted before the host run finished.', ?5, ?5)",
            params![
                run_id,
                project.id,
                task.id,
                ".helm/artifacts/runs/orphaned-approval-test",
                timestamp
            ],
        )
        .expect("insert orphaned run");
        conn.execute(
            "INSERT INTO approvals (
               id, project_id, entity_type, entity_id, approval_type, status,
               requested_reason, decision_reason, requested_at, decided_at, created_at, updated_at
             )
             VALUES (?1, ?2, 'AgentRun', ?3, 'RunApproval', 'Pending',
                     'stale approval', NULL, ?4, NULL, ?4, ?4)",
            params![new_id(), project.id, run_id, timestamp],
        )
        .expect("insert stale approval");

        let pending =
            list_approvals(&conn, &project.id, Some("Pending".to_string())).expect("approvals");
        assert!(pending.is_empty());
    }

    fn write_run_artifacts(root: &Path, summary: &str, structured: Option<&str>) -> PathBuf {
        let dir = root.join(".helm/artifacts/runs").join(new_id());
        fs::create_dir_all(&dir).expect("create artifact dir");
        fs::write(dir.join("summary.md"), summary).expect("write summary");
        if let Some(json) = structured {
            fs::write(dir.join("structured-result.json"), json).expect("write structured");
        }
        dir
    }

    fn enable_retrospective_capture(conn: &Connection, project_id: &str) {
        // 회고 캡처는 역할 policy가 enabled일 때만 동작하므로 5개 역할 정책을 켠다.
        let policies = role_policy_role_ids()
            .iter()
            .map(|role_id| {
                json!({
                    "roleId": role_id,
                    "enabled": true,
                    "path": format!(".helm/policies/{role_id}.md")
                })
            })
            .collect::<Vec<_>>();
        update_settings(
            conn,
            project_id,
            ProjectSettingsPatch {
                role_presets: None,
                ai_connections: None,
                role_assignments: None,
                role_policies: Some(Value::Array(policies)),
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
        .expect("enable retrospective capture");
    }

    fn pending_role_lesson_approval(conn: &Connection, project_id: &str) -> ApprovalSummary {
        list_approvals(conn, project_id, Some("Pending".to_string()))
            .expect("list approvals")
            .into_iter()
            .find(|approval| approval.approval_type == "RoleLesson")
            .expect("role lesson approval present")
    }

    #[test]
    fn role_lesson_high_confidence_auto_applies_without_gate() {
        let repo = test_repo();
        let (mut conn, project) = open_test_project(&repo);
        enable_retrospective_capture(&conn, &project.id);

        let artifact = write_run_artifacts(
            &repo.root,
            "fallback summary",
            Some(r#"{"summary":"타입 가드를 추가하라","suggestedNext":"테스트 보강"}"#),
        );

        // 고신뢰(Succeeded): 사람 게이트 없이 바로 active로 적용되고 .lessons.md가 즉시 생긴다.
        let captured = capture_role_retrospective(
            &mut conn, &project.id, "task-1", "run-1", "coder", "Succeeded", &artifact, &repo.root,
        )
        .expect("capture");
        assert_eq!(captured, RetroCapture::AutoApplied);

        // pending 승인 카드는 뜨지 않는다(이미 Approved로 자동 결정).
        let no_pending = list_approvals(&conn, &project.id, Some("Pending".to_string()))
            .expect("list approvals")
            .into_iter()
            .all(|approval| approval.approval_type != "RoleLesson");
        assert!(no_pending);

        // 다음 동일 역할 run 컨텍스트 팩에 주입된다.
        let injected = resolve_role_lessons(&repo.root, "coder").expect("lessons present");
        assert!(injected.contains("타입 가드"));
        assert!(role_lessons_markdown(&repo.root, "coder").contains("정책을 따른다"));
    }

    #[test]
    fn role_lesson_needs_inspection_also_auto_applies() {
        let repo = test_repo();
        let (mut conn, project) = open_test_project(&repo);
        enable_retrospective_capture(&conn, &project.id);

        let artifact =
            write_run_artifacts(&repo.root, "fallback", Some(r#"{"summary":"점검 교훈"}"#));

        // NeedsInspection도 사람 게이트 없이 바로 active로 적용된다.
        let captured = capture_role_retrospective(
            &mut conn, &project.id, "task-1", "run-1", "coder", "NeedsInspection", &artifact,
            &repo.root,
        )
        .expect("capture");
        assert_eq!(captured, RetroCapture::AutoApplied);

        // 승인 카드는 뜨지 않는다.
        let no_pending = list_approvals(&conn, &project.id, Some("Pending".to_string()))
            .expect("list approvals")
            .into_iter()
            .all(|approval| approval.approval_type != "RoleLesson");
        assert!(no_pending);
        assert!(resolve_role_lessons(&repo.root, "coder")
            .expect("lessons present")
            .contains("점검 교훈"));
    }

    #[test]
    fn role_lesson_hard_failure_backs_off_latest_auto_lesson() {
        let repo = test_repo();
        let (mut conn, project) = open_test_project(&repo);
        enable_retrospective_capture(&conn, &project.id);

        // 고신뢰 run 2건이 자동 적용된다.
        let a = write_run_artifacts(&repo.root, "f", Some(r#"{"summary":"교훈 A"}"#));
        capture_role_retrospective(
            &mut conn, &project.id, "t", "r1", "coder", "Succeeded", &a, &repo.root,
        )
        .expect("capture A");
        let b = write_run_artifacts(&repo.root, "f", Some(r#"{"summary":"교훈 B"}"#));
        capture_role_retrospective(
            &mut conn, &project.id, "t", "r2", "coder", "Succeeded", &b, &repo.root,
        )
        .expect("capture B");
        let injected = resolve_role_lessons(&repo.root, "coder").expect("present");
        assert!(injected.contains("교훈 A") && injected.contains("교훈 B"));

        // 하드 실패(Failed): 직전 자동 lesson(교훈 B) 1건만 비활성화하고 파일에서 빠진다.
        let f = write_run_artifacts(&repo.root, "f", Some(r#"{"summary":"실패 회고"}"#));
        capture_role_retrospective(
            &mut conn, &project.id, "t", "r3", "coder", "Failed", &f, &repo.root,
        )
        .expect("capture fail");
        let after = resolve_role_lessons(&repo.root, "coder").expect("present");
        assert!(after.contains("교훈 A"));
        assert!(!after.contains("교훈 B"));
    }

    #[test]
    fn role_lesson_rejected_via_chat_path_stays_cold_start() {
        let repo = test_repo();
        let (mut conn, project) = open_test_project(&repo);
        enable_retrospective_capture(&conn, &project.id);

        let artifact =
            write_run_artifacts(&repo.root, "fallback", Some(r#"{"summary":"잘못된 교훈"}"#));
        capture_role_retrospective(
            &mut conn, &project.id, "task-1", "run-1", "tester", "Failed", &artifact, &repo.root,
        )
        .expect("capture");

        let approval = pending_role_lesson_approval(&conn, &project.id);
        decide_approval(&mut conn, &project.id, &approval.id, "Rejected", "no").expect("reject");
        refresh_role_lessons_file(&conn, &repo.root, &project.id, &approval.entity_id)
            .expect("refresh");

        // 반려 → disabled → active 0개 → 파일 없음(cold-start 유지).
        assert!(resolve_role_lessons(&repo.root, "tester").is_none());
    }

    #[test]
    fn role_lesson_capture_skips_unknown_role_and_empty_artifacts() {
        let repo = test_repo();
        let (mut conn, project) = open_test_project(&repo);
        enable_retrospective_capture(&conn, &project.id);

        // 알 수 없는 역할은 캡처하지 않는다(CHECK 제약 위반 방지).
        let artifact = write_run_artifacts(&repo.root, "something", None);
        let captured = capture_role_retrospective(
            &mut conn, &project.id, "t", "r", "orchestrator", "Succeeded", &artifact, &repo.root,
        )
        .expect("capture unknown role");
        assert_eq!(captured, RetroCapture::Skipped);

        // 빈 산출물(summary 비고 structured 없음)은 후보를 만들지 않는다.
        let empty = write_run_artifacts(&repo.root, "   ", None);
        let captured = capture_role_retrospective(
            &mut conn, &project.id, "t", "r", "coder", "Failed", &empty, &repo.root,
        )
        .expect("capture empty");
        assert_eq!(captured, RetroCapture::Skipped);
    }

    #[test]
    fn role_lesson_capture_is_opt_in_disabled_by_default() {
        let repo = test_repo();
        let (mut conn, project) = open_test_project(&repo);
        // 기본 비활성: 유효한 role + 내용이 있어도 캡처하지 않는다(노이즈 방지).
        let artifact = write_run_artifacts(&repo.root, "fallback", Some(r#"{"summary":"교훈"}"#));
        let captured = capture_role_retrospective(
            &mut conn, &project.id, "t", "r", "coder", "Failed", &artifact, &repo.root,
        )
        .expect("capture");
        assert_eq!(captured, RetroCapture::Skipped);
        assert!(list_role_lessons(&conn, &project.id, None)
            .expect("list")
            .is_empty());
    }

    #[test]
    fn role_lessons_markdown_is_cold_start_safe() {
        let repo = test_repo();
        assert_eq!(
            role_lessons_markdown(&repo.root, "tester"),
            "학습된 경험칙 없음"
        );
    }
}
