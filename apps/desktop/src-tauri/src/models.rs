use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Clone, Debug)]
pub struct ProjectContext {
    pub root_path: PathBuf,
    pub db_path: PathBuf,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
}

impl CommandError {
    pub fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.to_string(),
            message: message.to_string(),
            details: None,
        }
    }

    pub fn with_details(code: &str, message: &str, details: impl ToString) -> Self {
        Self {
            code: code.to_string(),
            message: message.to_string(),
            details: Some(details.to_string()),
        }
    }

    pub fn validation(message: &str) -> Self {
        Self::new("ValidationFailed", message)
    }

    pub fn io(message: &str, details: impl ToString) -> Self {
        Self::with_details("IoFailed", message, details)
    }

    pub fn database(message: &str, details: impl ToString) -> Self {
        Self::with_details("DatabaseOpenFailed", message, details)
    }
}

pub type CommandResult<T> = Result<T, CommandError>;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: String,
    pub root_path: String,
    pub name: String,
    pub base_branch: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveSettings {
    pub role_presets: Value,
    pub worktree_root: Option<String>,
    pub obsidian_vault_path: Option<String>,
    pub token_budget: Option<i64>,
    pub artifact_retention_days: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpicSummary {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub status: String,
    pub plan_path: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskExternalRefSummary {
    pub id: String,
    pub project_id: String,
    pub task_id: String,
    pub ref_type: String,
    pub ref_value: String,
    pub ref_title: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSummary {
    pub id: String,
    pub project_id: String,
    pub epic_id: Option<String>,
    pub title: String,
    pub description: String,
    pub status: String,
    pub status_reason: Option<String>,
    pub sort_order: i64,
    pub external_refs: Vec<TaskExternalRefSummary>,
    pub created_at: String,
    pub updated_at: String,
    pub last_transition_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskWorktreeSummary {
    pub id: String,
    pub project_id: String,
    pub task_id: String,
    pub branch_name: String,
    pub worktree_path: String,
    pub base_branch: Option<String>,
    pub head_hash: Option<String>,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditLogEntry {
    pub id: String,
    pub project_id: String,
    pub entity_type: String,
    pub entity_id: Option<String>,
    pub event_type: String,
    pub payload: Value,
    pub created_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCounts {
    pub total: usize,
    pub done: usize,
    pub by_status: HashMap<String, usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSnapshot {
    pub project: ProjectSummary,
    pub settings: EffectiveSettings,
    pub repository: GitRepositoryState,
    pub epics: Vec<EpicSummary>,
    pub tasks: Vec<TaskSummary>,
    pub approvals: Vec<ApprovalSummary>,
    pub task_counts: TaskCounts,
    pub audit_tail: Vec<AuditLogEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepositoryState {
    pub current_branch: Option<String>,
    pub head: Option<String>,
    pub is_detached: bool,
    pub dirty_count: usize,
    pub staged_count: usize,
    pub unstaged_count: usize,
    pub untracked_count: usize,
    pub user_name: Option<String>,
    pub user_email: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitSummary {
    pub hash: String,
    pub short_hash: String,
    pub author_name: String,
    pub author_email: String,
    pub committed_at: String,
    pub subject: String,
    pub refs: Vec<String>,
    pub is_mine: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchSummary {
    pub branch_name: String,
    pub head_hash: String,
    pub upstream: Option<String>,
    pub ahead: Option<i64>,
    pub behind: Option<i64>,
    pub is_current: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileStatus {
    pub path: String,
    pub status: String,
    pub staged: bool,
    pub renamed_from: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateEpicInput {
    pub title: String,
    pub plan_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskExternalRefInput {
    pub ref_type: String,
    pub ref_value: String,
    pub ref_title: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTaskInput {
    pub epic_id: Option<String>,
    pub title: String,
    pub description: Option<String>,
    pub external_refs: Option<Vec<TaskExternalRefInput>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSettingsPatch {
    pub role_presets: Option<Value>,
    pub worktree_root: Option<Option<String>>,
    pub obsidian_vault_path: Option<Option<String>>,
    pub token_budget: Option<Option<i64>>,
    pub artifact_retention_days: Option<Option<i64>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCommandResult {
    pub cwd: String,
    pub command: String,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub timed_out: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunSummary {
    pub id: String,
    pub project_id: String,
    pub task_id: String,
    pub role_id: String,
    pub status: String,
    pub artifact_dir: String,
    pub summary_path: String,
    pub result_path: String,
    pub stdout_log_path: String,
    pub stderr_log_path: String,
    pub exit_code: Option<i64>,
    pub result_status: Option<String>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalSummary {
    pub id: String,
    pub project_id: String,
    pub entity_type: String,
    pub entity_id: String,
    pub approval_type: String,
    pub status: String,
    pub requested_reason: String,
    pub decision_reason: Option<String>,
    pub requested_at: String,
    pub decided_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}
