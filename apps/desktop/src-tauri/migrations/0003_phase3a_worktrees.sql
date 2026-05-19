CREATE TABLE task_worktrees (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  base_branch TEXT,
  head_hash TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (status IN ('Active', 'Archived')),
  UNIQUE (project_id, task_id),
  UNIQUE (worktree_path),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX idx_task_worktrees_project_status ON task_worktrees(project_id, status);
