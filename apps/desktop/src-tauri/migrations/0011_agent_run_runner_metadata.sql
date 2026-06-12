ALTER TABLE agent_runs ADD COLUMN provider TEXT;
ALTER TABLE agent_runs ADD COLUMN connection_id TEXT;
ALTER TABLE agent_runs ADD COLUMN model TEXT;

UPDATE agent_runs
SET
  provider = (
    SELECT json_extract(run_events.payload_json, '$.provider')
    FROM run_events
    WHERE run_events.run_id = agent_runs.id
      AND run_events.message = 'Runner request captured'
      AND json_valid(run_events.payload_json)
    ORDER BY run_events.seq DESC
    LIMIT 1
  ),
  connection_id = (
    SELECT json_extract(run_events.payload_json, '$.connectionId')
    FROM run_events
    WHERE run_events.run_id = agent_runs.id
      AND run_events.message = 'Runner request captured'
      AND json_valid(run_events.payload_json)
    ORDER BY run_events.seq DESC
    LIMIT 1
  ),
  model = (
    SELECT json_extract(run_events.payload_json, '$.model')
    FROM run_events
    WHERE run_events.run_id = agent_runs.id
      AND run_events.message = 'Runner request captured'
      AND json_valid(run_events.payload_json)
    ORDER BY run_events.seq DESC
    LIMIT 1
  )
WHERE EXISTS (
  SELECT 1
  FROM run_events
  WHERE run_events.run_id = agent_runs.id
    AND run_events.message = 'Runner request captured'
    AND json_valid(run_events.payload_json)
);
