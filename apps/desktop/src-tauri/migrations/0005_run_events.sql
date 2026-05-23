CREATE TABLE IF NOT EXISTS run_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (kind IN ('status', 'stdout', 'stderr', 'artifact', 'result', 'approval', 'system')),
  UNIQUE (run_id, seq),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_run_events_run_seq ON run_events(run_id, seq);
CREATE INDEX IF NOT EXISTS idx_run_events_project_created ON run_events(project_id, created_at);
