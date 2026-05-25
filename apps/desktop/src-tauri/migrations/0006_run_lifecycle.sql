ALTER TABLE agent_runs ADD COLUMN lifecycle_phase TEXT;
ALTER TABLE agent_runs ADD COLUMN claimed_at TEXT;
ALTER TABLE agent_runs ADD COLUMN heartbeat_at TEXT;
ALTER TABLE agent_runs ADD COLUMN failure_kind TEXT;
ALTER TABLE agent_runs ADD COLUMN failure_reason TEXT;
ALTER TABLE agent_runs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1;

UPDATE agent_runs
SET lifecycle_phase = CASE status
  WHEN 'Queued' THEN 'queued'
  WHEN 'Running' THEN 'running'
  WHEN 'Succeeded' THEN 'completed'
  WHEN 'Failed' THEN 'failed'
  WHEN 'Canceled' THEN 'canceled'
  WHEN 'TimedOut' THEN 'failed'
  ELSE 'blocked'
END
WHERE lifecycle_phase IS NULL;

UPDATE agent_runs
SET claimed_at = COALESCE(claimed_at, started_at)
WHERE claimed_at IS NULL AND status IN ('Running', 'Succeeded', 'Failed', 'Canceled', 'TimedOut', 'NeedsInspection');

UPDATE agent_runs
SET heartbeat_at = COALESCE(heartbeat_at, updated_at)
WHERE heartbeat_at IS NULL AND status = 'Running';

UPDATE agent_runs
SET failure_kind = CASE status
  WHEN 'Failed' THEN 'exit_failed'
  WHEN 'Canceled' THEN 'canceled'
  WHEN 'TimedOut' THEN 'timeout'
  WHEN 'NeedsInspection' THEN 'needs_inspection'
  ELSE failure_kind
END
WHERE failure_kind IS NULL AND status IN ('Failed', 'Canceled', 'TimedOut', 'NeedsInspection');

UPDATE agent_runs
SET failure_reason = CASE status
  WHEN 'Failed' THEN 'Host runner exited with a non-zero status.'
  WHEN 'Canceled' THEN 'Host runner was canceled.'
  WHEN 'TimedOut' THEN 'Host runner exceeded its timeout.'
  WHEN 'NeedsInspection' THEN 'Run requires manual inspection before continuing.'
  ELSE failure_reason
END
WHERE failure_reason IS NULL AND status IN ('Failed', 'Canceled', 'TimedOut', 'NeedsInspection');

CREATE INDEX IF NOT EXISTS idx_agent_runs_lifecycle_phase ON agent_runs(project_id, lifecycle_phase);
CREATE INDEX IF NOT EXISTS idx_agent_runs_heartbeat ON agent_runs(project_id, heartbeat_at);
