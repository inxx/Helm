-- 역할별 회고(retrospective) 학습 루프의 원본 저장소.
-- run이 끝날 때 산출물에서 lesson 후보를 결정적으로 캡처해 pending으로 쌓는다.
-- 사람이 승인하면 active가 되어 .helm/policies/{roleId}.lessons.md로 재생성되고
-- 다음 run의 컨텍스트 팩에 주입된다. status로 게이트(pending)와 롤백(disabled)을 처리한다.

CREATE TABLE IF NOT EXISTS role_retrospectives (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  role_id TEXT NOT NULL CHECK (role_id IN ('planner', 'coder', 'plan_verifier', 'code_reviewer', 'tester')),
  outcome TEXT NOT NULL,
  lesson TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_role_retrospectives_role_status
  ON role_retrospectives (project_id, role_id, status, created_at DESC);
