-- 오케스트레이터 ↔ 계획자 ↔ 작업자 진행을 한 채팅 스레드에 누적한다.
-- 세션을 바꾸거나 앱을 재시작해도 사라지지 않으며 append-only로 계속 쌓인다.
-- source_run_id는 작업자 run 요약을 스레드에 한 번만 기록하기 위한 멱등 키다.
-- (3초 폴링으로 같은 요약이 반복 도착해도 UNIQUE + INSERT OR IGNORE로 1건만 남는다.
--  일반 메시지는 source_run_id가 NULL이고, SQLite는 NULL을 서로 distinct로 보므로 충돌하지 않는다.)
CREATE TABLE conversation_messages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  source_run_id TEXT,
  created_at TEXT NOT NULL,
  CHECK (role IN ('user', 'assistant')),
  UNIQUE (project_id, source_run_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX idx_conversation_messages_project_seq
  ON conversation_messages(project_id, seq);
