CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  status TEXT NOT NULL,
  artifact_dir TEXT NOT NULL,
  summary_path TEXT NOT NULL,
  result_path TEXT NOT NULL,
  stdout_log_path TEXT NOT NULL,
  stderr_log_path TEXT NOT NULL,
  exit_code INTEGER,
  result_status TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (role_id IN ('planner', 'coder', 'plan_verifier', 'code_reviewer', 'tester')),
  CHECK (status IN ('Queued', 'Running', 'Succeeded', 'Failed', 'Canceled', 'TimedOut', 'NeedsInspection')),
  CHECK (result_status IS NULL OR result_status IN ('pass', 'fail', 'needs_changes')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX idx_agent_runs_task_created ON agent_runs(task_id, created_at);
CREATE INDEX idx_agent_runs_project_status ON agent_runs(project_id, status);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  approval_type TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_reason TEXT NOT NULL,
  decision_reason TEXT,
  requested_at TEXT NOT NULL,
  decided_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (entity_type IN ('Task', 'AgentRun')),
  CHECK (approval_type IN ('PlanApproval', 'RunApproval', 'ManualStatusChange')),
  CHECK (status IN ('Pending', 'Approved', 'Rejected', 'Expired')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX idx_approvals_project_status ON approvals(project_id, status);
CREATE INDEX idx_approvals_entity ON approvals(entity_type, entity_id);
