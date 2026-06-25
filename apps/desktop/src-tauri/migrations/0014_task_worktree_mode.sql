-- 작업 시작 시 "현재 체크아웃된 브랜치에서 in-place 작업" / "새 워크트리 생성"을 고르게 한다.
-- 기본은 'current_branch'(in-place). 'worktree'면 기존처럼 새 워크트리+새 브랜치를 만든다.
ALTER TABLE tasks ADD COLUMN worktree_mode TEXT NOT NULL DEFAULT 'current_branch'
  CHECK (worktree_mode IN ('current_branch', 'worktree'));

-- in-place 모드는 task worktree가 프로젝트 root를 가리키므로 여러 작업이 같은 경로를
-- 공유한다. 기존 UNIQUE(worktree_path)는 이를 막아버리므로 제거한다. run은 큐 워커가
-- 프로젝트당 1개씩 직렬화하므로 경로 충돌 위험은 없다. UNIQUE(project_id, task_id)는 유지.
-- task_worktrees를 참조하는 incoming FK가 없어 rename/recreate가 안전하다.
ALTER TABLE task_worktrees RENAME TO task_worktrees_old;

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
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

INSERT INTO task_worktrees SELECT * FROM task_worktrees_old;
DROP TABLE task_worktrees_old;
