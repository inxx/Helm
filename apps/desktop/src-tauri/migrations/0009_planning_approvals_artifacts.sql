ALTER TABLE plan_draft_revisions ADD COLUMN artifact_path TEXT;
ALTER TABLE plan_draft_revisions ADD COLUMN content_hash TEXT;

CREATE TABLE IF NOT EXISTS planning_approvals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  draft_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  requested_reason TEXT NOT NULL,
  decision_reason TEXT,
  requested_at TEXT NOT NULL,
  decided_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (status IN ('Pending', 'Approved', 'Rejected')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES planning_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (draft_id) REFERENCES plan_draft_revisions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_planning_approvals_session_status
  ON planning_approvals(session_id, status);

INSERT INTO planning_approvals (
  id,
  project_id,
  session_id,
  draft_id,
  status,
  requested_reason,
  decision_reason,
  requested_at,
  decided_at,
  created_at,
  updated_at
)
SELECT
  lower(hex(randomblob(16))),
  drafts.project_id,
  drafts.session_id,
  drafts.id,
  CASE WHEN sessions.status = 'Approved' THEN 'Approved' ELSE 'Pending' END,
  'Backfilled approval request for existing Plan Document revision',
  CASE WHEN sessions.status = 'Approved' THEN 'Backfilled from approved planning session' ELSE NULL END,
  drafts.created_at,
  CASE WHEN sessions.status = 'Approved' THEN sessions.updated_at ELSE NULL END,
  drafts.created_at,
  sessions.updated_at
FROM plan_draft_revisions AS drafts
JOIN planning_sessions AS sessions
  ON sessions.id = drafts.session_id
 AND sessions.project_id = drafts.project_id
WHERE sessions.current_draft_id = drafts.id
  AND NOT EXISTS (
    SELECT 1
    FROM planning_approvals AS approvals
    WHERE approvals.draft_id = drafts.id
  );
