# Synara-style ACP Session Direction

작성일: 2026-06-18

## 배경

기존 Helm 방향은 `Planning -> Tasks -> Git -> Terminal` 탭을 기준으로, 계획과 태스크 보드를 비교적 강하게 제품 중심에 두고 있었다. 하지만 Synara처럼 ACP 기반 provider session을 1급 객체로 두면 사용자가 실제로 보고 싶은 진행 내용은 대부분 채팅/세션 타임라인에 모인다.

따라서 Helm도 칸반을 상세 진행 화면으로 쓰기보다 세션별 요약 상태를 보여주는 얇은 현황판으로 낮추고, 실제 작업 상세는 ACP session chat 안에서 보이도록 방향을 조정한다.

## 참조한 Synara 관찰

- Synara는 `thread`를 중심 객체로 두고, 메시지, provider session, 활동 로그, proposed plan, diff summary, worktree, handoff를 thread에 붙인다.
- ACP 계층은 `packages/effect-acp`처럼 protocol/client/agent/terminal 책임을 분리한다.
- ACP client는 session lifecycle을 직접 다룬다: create/load/list/fork/resume/close session, set model, prompt, cancel.
- 터미널은 프로젝트별 고정 화면이라기보다 thread/session 표면에 붙을 수 있는 독립 surface로 구성된다.
- 칸반은 실행 전체의 세부 로그를 대체하지 않고, thread/session의 현재 단계와 dispatch 상태를 요약하는 control-center 역할에 가깝다.

## 새 제품 원칙

1. 상세 진행 내용의 기준 소스는 ACP session chat이다.
2. 칸반은 세션별 상태 요약만 보여준다.
3. 터미널은 프로젝트별로 강하게 귀속하지 않고 공통 terminal surface로 둔다.
4. 프로젝트, worktree, branch, task는 session에 붙는 context이지 terminal의 소유자가 아니다.
5. handoff, provider 전환, 재개, fork는 task보다 session lifecycle에 먼저 붙인다.
6. Helm의 task/plan 개념은 남기되, 사용자에게 노출되는 주 화면은 session workspace가 우선이다.

## 화면 구조 변경

기존:

```text
Planning
Tasks / Kanban
Git
Terminal
Settings
```

변경:

```text
Sessions
  - session list
  - chat transcript
  - run/activity timeline
  - diff / files / browser preview / approvals
  - attached terminals

Board
  - session cards grouped by status
  - provider, project, branch, last signal, next action
  - 상세 로그 대신 session open으로 이동

Terminal
  - 공통 terminal workspace
  - 필요 시 session/project/worktree context를 attach
  - terminal 자체는 전역 pool로 관리

Projects
  - repo settings, branch/worktree, scripts, runner config

Settings
```

## 데이터 모델 방향

### `agent_sessions`

ACP/provider session을 표현하는 중심 테이블.

```text
id
provider
provider_session_id
project_id nullable
task_id nullable
title
status: draft | running | waiting_input | waiting_approval | completed | failed | archived
model
branch
worktree_path
created_at
updated_at
last_signal_at
```

### `agent_session_messages`

채팅과 상세 진행 내용을 저장한다.

```text
id
session_id
role: user | assistant | system | tool
content
metadata_json
created_at
```

### `agent_session_events`

실행 상태, 승인 요청, tool call, diff summary, handoff 등을 시간순으로 저장한다.

```text
id
session_id
kind
payload_json
created_at
```

### `terminal_sessions`

전역 terminal pool. 프로젝트는 optional context다.

```text
id
title
cwd
project_id nullable
session_id nullable
worktree_path nullable
status
created_at
updated_at
last_activity_at
```

## 칸반 역할 축소

Board card는 아래 정보만 가진다.

- session title
- provider/model
- project label
- status
- last signal
- current branch/worktree
- changed file count
- next action

Board card에서 보여주지 않을 것:

- 긴 실행 로그
- 상세 plan markdown
- terminal output 전문
- diff 전문
- 세부 agent narration

이 정보들은 session detail/chat에서만 본다.

## 구현 순서

### Phase 1: 방향 정리와 명명 정렬

- `TaskBoard`의 제품 의미를 `SessionBoard` 또는 `ControlBoard`로 재정의한다.
- 기존 task status card가 상세 정보를 너무 많이 담고 있는 부분을 줄인다.
- `PlanningScreen`은 장기적으로 `SessionWorkspace`에 흡수한다.
- 기존 `AgentRunSummary` 중심 UI와 새 `AgentSessionSummary` 사이 매핑 계층을 둔다.

### Phase 2: ACP session adapter

- ACP client abstraction을 추가한다.
- provider별 CLI 실행을 직접 run 단위로만 보지 않고 session lifecycle로 감싼다.
- create/load/resume/fork/prompt/cancel 흐름을 Helm backend command로 노출한다.
- ACP session update를 `agent_session_messages`와 `agent_session_events`로 저장한다.

### Phase 3: Session Workspace

- 세션 리스트와 채팅 상세 화면을 만든다.
- 메시지, tool/event timeline, approval, diff summary를 같은 session 화면에 배치한다.
- 기존 Planning 대화는 별도 planner 화면이 아니라 planner provider session으로 표현한다.

### Phase 4: 공통 터미널

- terminal state key를 project 중심에서 global terminal id 중심으로 바꾼다.
- terminal은 `project_id`와 `session_id`를 optional attachment로 가진다.
- 프로젝트를 바꿔도 terminal pool은 유지한다.
- session detail에서 terminal을 attach/detach할 수 있게 한다.

### Phase 5: Board 간소화

- Board는 session summary projection만 읽는다.
- drag/drop은 session status나 next action 변경 정도로 제한한다.
- 상세 확인은 session detail로 이동한다.

## 성공 기준

- 사용자는 한 세션의 상세 진행을 chat transcript에서 시간순으로 확인할 수 있다.
- Board는 세션별 현재 상태만 빠르게 보여주며 상세 로그를 중복 표시하지 않는다.
- 터미널은 특정 프로젝트 화면에 갇히지 않고 전역 terminal workspace로 유지된다.
- project/worktree/branch는 terminal과 session에 attach되는 context로 동작한다.
- ACP provider session을 재개하거나 fork해도 메시지, event, terminal attachment가 끊기지 않는다.

## 제외 범위

- 기존 task/core-loop DB를 즉시 삭제하지 않는다.
- 칸반을 완전히 제거하지 않는다.
- terminal을 agent runner의 판정 근거로 승격하지 않는다.
- provider별 모든 ACP 구현을 한 번에 끝내지 않는다. 우선 Codex/Claude 중 하나로 vertical slice를 만든다.
