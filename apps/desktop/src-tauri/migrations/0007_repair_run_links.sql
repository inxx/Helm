ALTER TABLE agent_runs ADD COLUMN repair_request_id TEXT;

CREATE INDEX IF NOT EXISTS idx_agent_runs_repair_request_id
  ON agent_runs(repair_request_id);
