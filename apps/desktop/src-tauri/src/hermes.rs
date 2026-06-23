// Hermes-native integration: read the local Hermes board/session store and create
// staged task chains via the `hermes kanban` CLI. Reads are read-only against
// ~/.hermes/{kanban.db,state.db}; writes shell out to the CLI (the stable interface).
// ponytail: couples to Hermes' SQLite schema for reads — guarded by schema presence,
// upgrade path is the `hermes kanban`/`hermes sessions` CLIs if the schema shifts.
use crate::git;
use crate::models::{CommandError, CommandResult, GitFileDiff};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;

fn home() -> CommandResult<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| CommandError::validation("HOME 경로를 찾을 수 없습니다."))
}

fn hermes_dir() -> CommandResult<PathBuf> {
    Ok(home()?.join(".hermes"))
}

/// Resolve the `hermes` binary: prefer ~/.local/bin/hermes, else rely on PATH.
fn hermes_bin() -> CommandResult<String> {
    let local = home()?.join(".local/bin/hermes");
    if local.exists() {
        Ok(local.to_string_lossy().to_string())
    } else {
        Ok("hermes".to_string())
    }
}

fn open_readonly(db: PathBuf) -> CommandResult<Connection> {
    if !db.exists() {
        return Err(CommandError::with_details(
            "HermesNotFound",
            "Hermes 데이터를 찾을 수 없습니다.",
            db.to_string_lossy(),
        ));
    }
    let conn = Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|err| CommandError::database("Hermes 데이터베이스를 열 수 없습니다.", err))?;
    // Hermes writes concurrently; wait briefly rather than failing on a lock.
    let _ = conn.busy_timeout(std::time::Duration::from_millis(2000));
    Ok(conn)
}

// ---------- Profiles (stage = profile = model) ----------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HermesProfile {
    pub name: String,
    pub model: Option<String>,
    pub provider: Option<String>,
    pub is_default: bool,
}

/// Read a profile's model + provider from its config.yaml `model:` block without pulling
/// in a YAML dependency: the block is small and flat (default:/provider: indented keys).
fn read_profile_model(config_path: &std::path::Path) -> (Option<String>, Option<String>) {
    match std::fs::read_to_string(config_path) {
        Ok(text) => parse_model_block(&text),
        Err(_) => (None, None),
    }
}

/// Extract (model, provider) from a config.yaml `model:` block — a small flat block with
/// `default:`/`provider:` indented keys. Avoids a YAML dependency for this one read.
fn parse_model_block(text: &str) -> (Option<String>, Option<String>) {
    let mut in_model = false;
    let mut model = None;
    let mut provider = None;
    for line in text.lines() {
        if !line.starts_with(char::is_whitespace) && !line.trim().is_empty() {
            // a new top-level key ends the model block.
            in_model = line.trim_start().starts_with("model:");
            continue;
        }
        if in_model {
            let trimmed = line.trim();
            if let Some(rest) = trimmed.strip_prefix("default:") {
                model = Some(rest.trim().trim_matches(['\'', '"']).to_string());
            } else if let Some(rest) = trimmed.strip_prefix("provider:") {
                provider = Some(rest.trim().trim_matches(['\'', '"']).to_string());
            }
        }
    }
    (model, provider)
}

/// List Hermes profiles (the implicit `default` plus ~/.hermes/profiles/*), each with its
/// configured model — this is how a pipeline stage selects its model (stage = profile).
pub fn list_profiles() -> CommandResult<Vec<HermesProfile>> {
    let dir = hermes_dir()?;
    let mut profiles = Vec::new();

    let (model, provider) = read_profile_model(&dir.join("config.yaml"));
    profiles.push(HermesProfile { name: "default".to_string(), model, provider, is_default: true });

    if let Ok(entries) = std::fs::read_dir(dir.join("profiles")) {
        let mut names: Vec<String> = entries
            .filter_map(Result::ok)
            .filter(|e| e.path().is_dir())
            .filter_map(|e| e.file_name().into_string().ok())
            .collect();
        names.sort();
        for name in names {
            let (model, provider) = read_profile_model(&dir.join("profiles").join(&name).join("config.yaml"));
            profiles.push(HermesProfile { name, model, provider, is_default: false });
        }
    }
    Ok(profiles)
}

// ---------- Board actions (human gate) ----------

/// Run a whitelisted kanban lifecycle action on a task (the human approval/gate surface).
pub fn kanban_action(action: String, task_id: String, reason: Option<String>) -> CommandResult<()> {
    const ALLOWED: [&str; 5] = ["unblock", "promote", "complete", "block", "archive"];
    if !ALLOWED.contains(&action.as_str()) {
        return Err(CommandError::validation("허용되지 않은 작업입니다."));
    }
    let bin = hermes_bin()?;
    let mut cmd = Command::new(&bin);
    cmd.arg("kanban").arg(&action).arg(&task_id);
    if let Some(reason) = reason.as_deref().filter(|r| !r.trim().is_empty()) {
        // unblock/block accept a free-form reason; others ignore extra args harmlessly.
        if action == "unblock" {
            cmd.arg("--reason").arg(reason);
        } else if action == "block" {
            cmd.arg(reason);
        }
    }
    let output = cmd
        .output()
        .map_err(|err| CommandError::io("hermes kanban 작업 실행 실패", err))?;
    if !output.status.success() {
        return Err(CommandError::with_details(
            "HermesActionFailed",
            "Hermes 작업 액션에 실패했습니다.",
            String::from_utf8_lossy(&output.stderr).to_string(),
        ));
    }
    Ok(())
}

// ---------- Board ----------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HermesBoardCard {
    pub id: String,
    pub title: String,
    pub status: String,
    pub assignee: Option<String>,
    pub priority: i64,
    pub branch_name: Option<String>,
    pub workspace_path: Option<String>,
    pub session_id: Option<String>,
    pub model_override: Option<String>,
    pub created_at: Option<f64>,
    pub started_at: Option<f64>,
    pub completed_at: Option<f64>,
    pub parents: Vec<String>,
    pub run_status: Option<String>,
    pub run_outcome: Option<String>,
    pub run_summary: Option<String>,
}

fn board_card_from_row(row: &Row) -> rusqlite::Result<HermesBoardCard> {
    Ok(HermesBoardCard {
        id: row.get("id")?,
        title: row.get("title")?,
        status: row.get("status")?,
        assignee: row.get("assignee")?,
        priority: row.get::<_, Option<i64>>("priority")?.unwrap_or(0),
        branch_name: row.get("branch_name")?,
        workspace_path: row.get("workspace_path")?,
        session_id: row.get("session_id")?,
        model_override: row.get("model_override")?,
        created_at: row.get("created_at")?,
        started_at: row.get("started_at")?,
        completed_at: row.get("completed_at")?,
        parents: Vec::new(),
        run_status: row.get("run_status")?,
        run_outcome: row.get("run_outcome")?,
        run_summary: row.get("run_summary")?,
    })
}

pub fn list_board(limit: i64) -> CommandResult<Vec<HermesBoardCard>> {
    let conn = open_readonly(hermes_dir()?.join("kanban.db"))?;
    let mut stmt = conn
        .prepare(
            "SELECT t.id, t.title, t.status, t.assignee, t.priority, t.branch_name,
                    t.workspace_path, t.session_id, t.model_override,
                    t.created_at, t.started_at, t.completed_at,
                    r.status AS run_status, r.outcome AS run_outcome, r.summary AS run_summary
             FROM tasks t
             LEFT JOIN task_runs r ON r.id = t.current_run_id
             ORDER BY t.created_at DESC
             LIMIT ?1",
        )
        .map_err(|err| CommandError::database("Hermes 보드를 읽지 못했습니다.", err))?;
    let mut cards = stmt
        .query_map(params![limit], board_card_from_row)
        .map_err(|err| CommandError::database("Hermes 보드를 읽지 못했습니다.", err))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| CommandError::database("Hermes 보드를 읽지 못했습니다.", err))?;

    // Dependency edges (parent -> child) live in task_links; attach parents per card.
    let mut link_stmt = conn
        .prepare("SELECT parent_id, child_id FROM task_links")
        .ok();
    if let Some(stmt) = link_stmt.as_mut() {
        if let Ok(rows) = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }) {
            let edges: Vec<(String, String)> = rows.filter_map(Result::ok).collect();
            for card in cards.iter_mut() {
                for (parent, child) in &edges {
                    if child == &card.id {
                        card.parents.push(parent.clone());
                    }
                }
            }
        }
    }
    Ok(cards)
}

// ---------- Task evidence tree (sessions + tool calls) ----------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HermesToolCall {
    pub role: String,
    pub tool_name: Option<String>,
    pub content: Option<String>,
    pub timestamp: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HermesSessionNode {
    pub id: String,
    pub parent_session_id: Option<String>,
    pub kind: String,
    pub model: Option<String>,
    pub title: Option<String>,
    pub message_count: i64,
    pub tool_call_count: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub actual_cost_usd: Option<f64>,
    pub started_at: Option<f64>,
    pub ended_at: Option<f64>,
    pub tool_calls: Vec<HermesToolCall>,
}

fn session_node_from_row(row: &Row) -> rusqlite::Result<HermesSessionNode> {
    let parent: Option<String> = row.get("parent_session_id")?;
    Ok(HermesSessionNode {
        id: row.get("id")?,
        kind: if parent.is_some() { "child".to_string() } else { "root".to_string() },
        parent_session_id: parent,
        model: row.get("model")?,
        title: row.get("title")?,
        message_count: row.get::<_, Option<i64>>("message_count")?.unwrap_or(0),
        tool_call_count: row.get::<_, Option<i64>>("tool_call_count")?.unwrap_or(0),
        input_tokens: row.get::<_, Option<i64>>("input_tokens")?.unwrap_or(0),
        output_tokens: row.get::<_, Option<i64>>("output_tokens")?.unwrap_or(0),
        actual_cost_usd: row.get("actual_cost_usd")?,
        started_at: row.get("started_at")?,
        ended_at: row.get("ended_at")?,
        tool_calls: Vec::new(),
    })
}

/// Returns the session tree (root + descendants via parent_session_id) for a task,
/// each node carrying a capped list of its tool-call/result messages as evidence.
///
/// Kanban workers run under the task's assignee *profile*, whose sessions live in a
/// per-profile store (~/.hermes/profiles/<assignee>/state.db), not the shared one. The
/// worker session is not recorded on the task row (tasks.session_id is the *creator's*
/// session); instead the dispatcher seeds the worker with "work kanban task <id>", so we
/// locate root worker sessions by matching the task id in their prompt/messages.
pub fn get_task_tree(task_id: String) -> CommandResult<Vec<HermesSessionNode>> {
    let kanban = open_readonly(hermes_dir()?.join("kanban.db"))?;
    let assignee: Option<String> = kanban
        .query_row(
            "SELECT assignee FROM tasks WHERE id = ?1",
            params![task_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| CommandError::database("Hermes 작업을 읽지 못했습니다.", err))?
        .flatten();

    let dir = hermes_dir()?;
    let state_path = match assignee.as_deref().map(|a| dir.join("profiles").join(a).join("state.db")) {
        Some(profile_db) if profile_db.exists() => profile_db,
        _ => dir.join("state.db"),
    };
    let state = open_readonly(state_path)?;

    // Root worker sessions: those whose system prompt or messages reference the task id.
    let pattern = format!("%{}%", task_id);
    let mut root_stmt = state
        .prepare(
            "SELECT DISTINCT s.id FROM sessions s
             WHERE s.system_prompt LIKE ?1
                OR s.id IN (SELECT session_id FROM messages WHERE content LIKE ?1)",
        )
        .map_err(|err| CommandError::database("Hermes 세션을 찾지 못했습니다.", err))?;
    let roots: Vec<String> = root_stmt
        .query_map(params![pattern], |row| row.get(0))
        .map_err(|err| CommandError::database("Hermes 세션을 찾지 못했습니다.", err))?
        .filter_map(Result::ok)
        .collect();

    if roots.is_empty() {
        return Ok(Vec::new());
    }

    // BFS over parent_session_id to collect the tree (depth-bounded for safety).
    let mut nodes: Vec<HermesSessionNode> = Vec::new();
    let mut frontier = roots;
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut guard = 0;
    while let Some(session_id) = frontier.pop() {
        guard += 1;
        if guard > 200 || !seen.insert(session_id.clone()) {
            continue;
        }
        let node = state
            .query_row(
                "SELECT id, parent_session_id, model, title, message_count, tool_call_count,
                        input_tokens, output_tokens, actual_cost_usd, started_at, ended_at
                 FROM sessions WHERE id = ?1",
                params![session_id],
                session_node_from_row,
            )
            .optional()
            .map_err(|err| CommandError::database("Hermes 세션을 읽지 못했습니다.", err))?;
        let Some(mut node) = node else { continue };

        // tool-call / tool-result messages as evidence (capped).
        let mut msg_stmt = state
            .prepare(
                "SELECT role, tool_name, substr(content, 1, 600) AS content, timestamp
                 FROM messages
                 WHERE session_id = ?1 AND (tool_name IS NOT NULL OR role = 'tool')
                 ORDER BY timestamp LIMIT 50",
            )
            .map_err(|err| CommandError::database("Hermes 메시지를 읽지 못했습니다.", err))?;
        node.tool_calls = msg_stmt
            .query_map(params![session_id], |row| {
                Ok(HermesToolCall {
                    role: row.get("role")?,
                    tool_name: row.get("tool_name")?,
                    content: row.get("content")?,
                    timestamp: row.get("timestamp")?,
                })
            })
            .map_err(|err| CommandError::database("Hermes 메시지를 읽지 못했습니다.", err))?
            .filter_map(Result::ok)
            .collect();

        // enqueue children
        let mut child_stmt = state
            .prepare("SELECT id FROM sessions WHERE parent_session_id = ?1")
            .map_err(|err| CommandError::database("Hermes 자식 세션을 읽지 못했습니다.", err))?;
        let children: Vec<String> = child_stmt
            .query_map(params![session_id], |row| row.get(0))
            .map_err(|err| CommandError::database("Hermes 자식 세션을 읽지 못했습니다.", err))?
            .filter_map(Result::ok)
            .collect();
        frontier.extend(children);

        nodes.push(node);
    }
    Ok(nodes)
}

// ---------- Worktree diff (review surface) ----------

/// Unified diffs for every changed file in a task's worktree. Read-only review surface;
/// reuses the git helpers against the task's `workspace_path`. Returns empty when the task
/// is not a worktree task or its path no longer exists. Capped to keep the payload bounded.
pub fn get_task_diff(task_id: String) -> CommandResult<Vec<GitFileDiff>> {
    let kanban = open_readonly(hermes_dir()?.join("kanban.db"))?;
    let workspace: Option<String> = kanban
        .query_row(
            "SELECT workspace_path FROM tasks WHERE id = ?1",
            params![task_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| CommandError::database("Hermes 작업을 읽지 못했습니다.", err))?
        .flatten();

    let Some(workspace) = workspace.filter(|w| !w.is_empty()) else {
        return Ok(Vec::new());
    };
    let root = std::path::Path::new(&workspace);
    if !root.exists() {
        return Ok(Vec::new());
    }

    let files = git::changed_files(root)?;
    let mut diffs = Vec::new();
    for file in files.into_iter().take(50) {
        if let Ok(diff) = git::file_diff(root, &file.path, "worktree") {
            diffs.push(diff);
        }
    }
    Ok(diffs)
}

// ---------- Write: staged task chain ----------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HermesStageInput {
    pub title: String,
    pub assignee: String,
    #[serde(default)]
    pub skills: Vec<String>,
    pub workspace: Option<String>,
    pub branch: Option<String>,
}

/// Create a sequential chain of kanban tasks (stage[i+1] depends on stage[i] via --parent).
/// Each stage is assigned to a profile (= its model). Returns the created task ids in order.
pub fn create_stage_chain(goal: String, stages: Vec<HermesStageInput>) -> CommandResult<Vec<String>> {
    if stages.is_empty() {
        return Err(CommandError::validation("단계가 비어 있습니다."));
    }
    let bin = hermes_bin()?;
    let mut ids: Vec<String> = Vec::new();
    for (idx, stage) in stages.iter().enumerate() {
        let mut cmd = Command::new(&bin);
        cmd.arg("kanban").arg("create").arg(&stage.title);
        cmd.arg("--assignee").arg(&stage.assignee);
        cmd.arg("--json");
        if idx == 0 {
            cmd.arg("--body").arg(&goal);
        }
        if let Some(prev) = ids.last() {
            cmd.arg("--parent").arg(prev);
        }
        for skill in &stage.skills {
            cmd.arg("--skill").arg(skill);
        }
        if let Some(ws) = &stage.workspace {
            cmd.arg("--workspace").arg(ws);
        }
        if let Some(branch) = &stage.branch {
            cmd.arg("--branch").arg(branch);
        }
        let output = cmd
            .output()
            .map_err(|err| CommandError::io("hermes kanban create 실행 실패", err))?;
        if !output.status.success() {
            return Err(CommandError::with_details(
                "HermesCreateFailed",
                "Hermes 작업 생성에 실패했습니다.",
                String::from_utf8_lossy(&output.stderr).to_string(),
            ));
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let id = parse_created_id(&stdout).ok_or_else(|| {
            CommandError::with_details(
                "HermesCreateParse",
                "생성된 작업 id를 해석하지 못했습니다.",
                stdout.to_string(),
            )
        })?;
        ids.push(id);
    }
    Ok(ids)
}

/// `hermes kanban create --json` prints a (pretty-printed) JSON object with the new task
/// id. Parse the JSON blob between the first `{` and last `}` (tolerating any preamble),
/// and be lenient about the key.
fn parse_created_id(stdout: &str) -> Option<String> {
    let start = stdout.find('{')?;
    let end = stdout.rfind('}')?;
    if end < start {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(&stdout[start..=end]).ok()?;
    for key in ["id", "task_id", "taskId"] {
        if let Some(s) = value.get(key).and_then(|v| v.as_str()) {
            return Some(s.to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_created_id_handles_pretty_json() {
        let out = "{\n  \"id\": \"t_b241fc32\",\n  \"title\": \"x\"\n}\n";
        assert_eq!(parse_created_id(out).as_deref(), Some("t_b241fc32"));
    }

    #[test]
    fn parse_created_id_tolerates_preamble_and_alt_keys() {
        assert_eq!(parse_created_id("noise\n{\"task_id\":\"t_9\"}").as_deref(), Some("t_9"));
        assert_eq!(parse_created_id("no json here"), None);
    }

    #[test]
    fn parse_model_block_reads_default_and_provider() {
        let cfg = "user_profile_enabled: true\nmodel:\n  base_url: http://x/v1\n  default: mlx-community/Qwen2.5-7B\n  provider: mlx\ndelegation:\n  model: ''\n";
        let (model, provider) = parse_model_block(cfg);
        assert_eq!(model.as_deref(), Some("mlx-community/Qwen2.5-7B"));
        assert_eq!(provider.as_deref(), Some("mlx"));
    }

    #[test]
    fn parse_model_block_ignores_default_outside_model_block() {
        // a `default:` under delegation must not be mistaken for the model.
        let cfg = "model:\n  provider: anthropic\ndelegation:\n  default: should-not-win\n";
        let (model, provider) = parse_model_block(cfg);
        assert_eq!(model, None);
        assert_eq!(provider.as_deref(), Some("anthropic"));
    }

    #[test]
    fn parse_model_block_empty_when_absent() {
        assert_eq!(parse_model_block("foo: bar\n"), (None, None));
    }
}
