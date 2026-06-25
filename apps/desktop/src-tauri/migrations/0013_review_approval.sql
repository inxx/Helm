-- approvals.approval_type CHECK에 'ReviewApproval'(리뷰 진행 승인)을 추가한다.
-- SQLite는 CHECK 제약을 직접 변경할 수 없어 테이블을 재생성한다.
-- approvals는 leaf 테이블(들어오는 FK 없음)이라 rename/drop이 안전하다.
ALTER TABLE approvals RENAME TO approvals_old;

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  approval_type TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_reason TEXT NOT NULL,
  decision_reason TEXT,
  requested_at TEXT NOT NULL,
  decided_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (entity_type IN ('Task', 'AgentRun')),
  CHECK (approval_type IN ('PlanApproval', 'ReviewApproval', 'RunApproval', 'ManualStatusChange')),
  CHECK (status IN ('Pending', 'Approved', 'Rejected', 'Expired')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

INSERT INTO approvals SELECT * FROM approvals_old;
DROP TABLE approvals_old;

CREATE INDEX idx_approvals_project_status ON approvals(project_id, status);
CREATE INDEX idx_approvals_entity ON approvals(entity_type, entity_id);
