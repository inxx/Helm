CREATE TABLE command_evidence (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT,
  run_id TEXT,
  command_json TEXT NOT NULL,
  cwd TEXT NOT NULL,
  exit_code INTEGER,
  timed_out INTEGER NOT NULL DEFAULT 0,
  canceled INTEGER NOT NULL DEFAULT 0,
  stdout_path TEXT,
  stderr_path TEXT,
  changed_files_path TEXT,
  diff_path TEXT,
  duration_ms INTEGER,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  CHECK (json_valid(command_json)),
  CHECK (timed_out IN (0, 1)),
  CHECK (canceled IN (0, 1)),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE SET NULL
);

CREATE INDEX idx_command_evidence_task_created ON command_evidence(task_id, created_at);
CREATE INDEX idx_command_evidence_run_id ON command_evidence(run_id);

CREATE TABLE gate_results (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  run_id TEXT,
  gate TEXT NOT NULL,
  status TEXT NOT NULL,
  blocking INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL,
  blockers_json TEXT NOT NULL,
  affected_files_json TEXT NOT NULL,
  suggested_next_json TEXT,
  created_at TEXT NOT NULL,
  CHECK (gate IN ('plan_verification', 'code_review', 'test', 'security', 'rules')),
  CHECK (status IN ('pass', 'warn', 'fail', 'needs_inspection')),
  CHECK (blocking IN (0, 1)),
  CHECK (json_valid(blockers_json)),
  CHECK (json_valid(affected_files_json)),
  CHECK (suggested_next_json IS NULL OR json_valid(suggested_next_json)),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE SET NULL
);

CREATE INDEX idx_gate_results_task_created ON gate_results(task_id, created_at);
CREATE INDEX idx_gate_results_run_id ON gate_results(run_id);

CREATE TABLE repair_requests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  run_id TEXT,
  gate_result_id TEXT,
  status TEXT NOT NULL,
  severity TEXT NOT NULL,
  summary TEXT NOT NULL,
  required_action TEXT NOT NULL,
  affected_files_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (status IN ('Open', 'Resolved', 'Dismissed')),
  CHECK (severity IN ('error', 'warning')),
  CHECK (json_valid(affected_files_json)),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE SET NULL,
  FOREIGN KEY (gate_result_id) REFERENCES gate_results(id) ON DELETE SET NULL
);

CREATE INDEX idx_repair_requests_task_status ON repair_requests(task_id, status);
