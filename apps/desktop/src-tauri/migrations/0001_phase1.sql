CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  root_path TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  base_branch TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE project_settings (
  project_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (json_valid(value_json)),
  PRIMARY KEY (project_id, key),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE epics (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  plan_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (status IN ('Drafting', 'AwaitingPlanApproval', 'Approved', 'Splitting', 'Active', 'Done', 'Archived')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  epic_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  status_reason TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_transition_at TEXT NOT NULL,
  CHECK (status IN ('Planned', 'Ready', 'Coding', 'PlanVerification', 'CodeReview', 'Testing', 'MergeWaiting', 'Merged', 'Done', 'Blocked')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (epic_id) REFERENCES epics(id) ON DELETE SET NULL
);

CREATE INDEX idx_epics_project_id ON epics(project_id);
CREATE INDEX idx_tasks_project_status_sort ON tasks(project_id, status, sort_order);

CREATE TABLE task_external_refs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  ref_type TEXT NOT NULL,
  ref_value TEXT NOT NULL,
  ref_title TEXT,
  created_at TEXT NOT NULL,
  CHECK (ref_type IN ('JiraEpic', 'JiraTask', 'MarkdownPlan', 'PlainText', 'Url')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX idx_task_external_refs_task_id ON task_external_refs(task_id);

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (json_valid(payload_json)),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX idx_audit_logs_project_created ON audit_logs(project_id, created_at);
