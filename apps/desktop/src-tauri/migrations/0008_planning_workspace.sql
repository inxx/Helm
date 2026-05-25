CREATE TABLE IF NOT EXISTS planning_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  goal_text TEXT NOT NULL,
  status TEXT NOT NULL,
  jira_ref TEXT,
  jira_state TEXT NOT NULL DEFAULT 'Missing',
  current_draft_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (status IN ('Drafting', 'ReadyForApproval', 'Approved', 'Archived')),
  CHECK (jira_state IN ('Linked', 'Missing', 'AlreadyTracked')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (current_draft_id) REFERENCES plan_draft_revisions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_planning_sessions_project_updated
  ON planning_sessions(project_id, updated_at);

CREATE TABLE IF NOT EXISTS planning_messages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  draft_revision_id TEXT,
  created_at TEXT NOT NULL,
  CHECK (role IN ('user', 'planner', 'system')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES planning_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (draft_revision_id) REFERENCES plan_draft_revisions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_planning_messages_session_created
  ON planning_messages(session_id, created_at);

CREATE TABLE IF NOT EXISTS plan_draft_revisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  plan_markdown TEXT,
  draft_json TEXT NOT NULL,
  validation_json TEXT NOT NULL,
  task_count INTEGER NOT NULL DEFAULT 0,
  task_graph_count INTEGER NOT NULL DEFAULT 0,
  barrier_count INTEGER NOT NULL DEFAULT 0,
  verification_gate_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  CHECK (json_valid(draft_json)),
  CHECK (json_valid(validation_json)),
  UNIQUE (session_id, revision),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES planning_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_plan_draft_revisions_session_revision
  ON plan_draft_revisions(session_id, revision);

CREATE TABLE IF NOT EXISTS planning_materializations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  draft_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  task_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (status IN ('Succeeded', 'Failed')),
  CHECK (json_valid(task_ids_json)),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES planning_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (draft_id) REFERENCES plan_draft_revisions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS planning_materialization_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  materialization_id TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  draft_task_key TEXT,
  sort_order INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (materialization_id, sort_order),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (materialization_id) REFERENCES planning_materializations(id) ON DELETE CASCADE,
  FOREIGN KEY (draft_id) REFERENCES plan_draft_revisions(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_planning_materialization_items_materialization
  ON planning_materialization_items(materialization_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_planning_materialization_items_task
  ON planning_materialization_items(task_id);
