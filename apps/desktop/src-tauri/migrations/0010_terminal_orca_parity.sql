CREATE TABLE IF NOT EXISTS terminal_saved_scripts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  command TEXT NOT NULL,
  cwd_mode TEXT NOT NULL DEFAULT 'active_pane',
  node_bin_path TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(trim(name)) > 0),
  CHECK (length(trim(command)) > 0),
  CHECK (cwd_mode IN ('active_pane', 'project_root', 'fixed_cwd')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_terminal_saved_scripts_project_updated
  ON terminal_saved_scripts(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_terminal_saved_scripts_project_last_used
  ON terminal_saved_scripts(project_id, last_used_at DESC);

CREATE TABLE IF NOT EXISTS terminal_layouts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL UNIQUE,
  layout_version INTEGER NOT NULL DEFAULT 1,
  layout_json TEXT NOT NULL,
  active_terminal_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (layout_version >= 1),
  CHECK (json_valid(layout_json)),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
