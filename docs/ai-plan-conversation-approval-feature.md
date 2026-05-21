# Planner Conversation Approval Feature

작성일: 2026-05-20

## 목적

사용자가 "하고 싶은 일"을 자연어로 말하면 Helm이 `planner` role과의 계획 대화를 통해 계획 문서를 만들고, 목표를 실행 가능한 Epic/Task/Subtask로 나눈다. 사용자는 그 계획 문서를 수정 요청하거나 직접 편집한 뒤 승인해야만 Epic/Task로 변환할 수 있다.

이 기능은 현재 Planning 화면의 부족한 지점을 닫기 위한 제품 기능 문서다.

```text
목표 입력
-> planning session 생성
-> repo context snapshot 구성
-> planner와 계획 대화
-> Epic/Task/Subtask 분해
-> 계획 문서 draft 생성
-> 사용자 수정 요청 또는 직접 편집
-> 승인 가능한 draft 고정
-> 사용자 승인
-> Epic/Task/External Ref materialize
-> Task core loop로 이동
```

## 현재 구현 검토 결과

현재 `apps/desktop/src/screens/PlanningScreen.tsx`는 Planning Workspace의 UI skeleton에 가깝다.

확인된 동작:

- 계획 세션은 React local state인 `PlanningSessionStub`에만 존재한다.
- 목표 입력 후 `createPlanTask()`가 바로 `api.createTask()`를 호출한다.
- 새로고침하면 planning session과 draft 이력은 사라진다.
- Plan Draft 영역은 Jira 설정과 기존 Task 연결 여부를 보여주는 preview에 가깝다.
- `planner` role과 대화해 draft를 만들고 고치는 command/API가 없다.
- 목표를 Epic/Task/Subtask로 나누는 구조화 단계가 없다.
- plan draft를 승인하는 별도 approval이 없다.
- 기존 `PlanApproval`은 Task가 이미 생긴 뒤 planner role 실행 결과를 승인하는 흐름이다. Task 생성 전 계획 문서 승인을 대체하지 못한다.

따라서 현재 흐름은 아래와 같다.

```text
목표 입력
-> 임시 세션 생성
-> Task 즉시 생성
-> Task Detail 이동
```

사용자가 기대한 흐름과 다른 점은 "계획 문서가 승인되기 전에 Task가 생긴다"는 것이다.

## 기능 목표

- 목표 입력만으로 Task를 만들지 않는다.
- planning session, messages, draft revision을 repo-local DB에 저장한다.
- Planning 탭의 중심 경험은 Task 카드 생성기가 아니라 Codex Desktop처럼 `planner`와 주고받는 대화 스레드다.
- Task breakdown은 대화 본문이 아니라 승인 대상 Plan Document draft의 한 섹션으로 표시한다.
- `planner` 응답은 자유 텍스트만이 아니라 구조화된 Plan Draft와 사람이 읽는 Markdown 계획 문서로 저장한다.
- `planner`는 목표를 Epic/Task/Subtask로 나누고 각 Task에 acceptance criteria, risk, test plan을 붙인다.
- 사용자는 `planner`에게 수정 요청을 보내거나 draft를 직접 편집할 수 있다.
- 승인 시점의 draft version을 불변 record로 남긴다.
- 승인된 draft만 Epic/Task/External Ref로 materialize한다.
- materialize 이후에도 어떤 대화와 draft에서 Task가 생성됐는지 추적할 수 있다.

## 제외 범위

- Jira issue 자동 생성과 Jira status sync
- Obsidian 자동 backfill
- 여러 AI가 동시에 토론하는 multi-agent planning
- 승인 후 자동 구현 실행
- full semantic codebase indexing

## 사용자 흐름

### 1. 새 계획 시작

사용자가 Planning 탭에서 목표를 입력한다.

완료 후 Helm은 Task를 만들지 않고 `planning_session`을 만든다.

필수 입력:

- goal text
- optional external reference: Jira key, Jira URL, Markdown path, URL

자동 수집 context:

- project id/root
- current branch/head
- dirty/staged/unstaged/untracked count
- 기존 Epic/Task 요약
- 최근 audit tail 요약
- 사용자 첨부 reference

### 2. planner와 계획 대화

Planning 탭의 대화 상대는 범용 채팅 AI가 아니라 Helm의 `planner` role이다. `planner`는 목표와 context를 보고 둘 중 하나를 반환한다.

- 추가 질문: 요구사항이 부족해 draft를 만들기 어렵다.
- draft 제안: 목표를 Epic/Task/Subtask로 나누고 승인 가능한 계획 문서 초안을 만든다.

`planner` 응답은 항상 `planning_messages`에 저장한다.

`planner`가 해야 하는 일:

- 사용자의 목표를 1개 이상의 Epic 후보로 묶는다.
- 각 Epic을 실행 가능한 Task로 나눈다.
- 큰 Task는 Subtask 또는 checklist로 더 쪼갠다.
- 각 Task에 description, acceptance criteria, risk, test plan을 붙인다.
- Task 간 순서와 dependency를 제안한다.
- 모호한 요구사항은 blocking open question으로 남긴다.
- 너무 큰 범위는 smaller milestone으로 줄이는 선택지를 제안한다.

`planner`가 하면 안 되는 일:

- 사용자 승인 없이 Task를 생성하지 않는다.
- 사용자 승인 없이 coder, verifier, reviewer, tester를 실행하지 않는다.
- 사용자 승인 없이 Git 작업을 하지 않는다.

### 3. 계획 문서 draft 생성

`planner`가 draft를 만들면 Helm은 두 표현을 함께 저장한다.

- `draft_json`: UI와 materialize에 쓰는 구조화 데이터
- `plan_markdown`: 사용자가 읽고 승인하는 계획 문서

Plan Draft는 version을 가진다. 사용자가 수정 요청을 보내거나 직접 편집하면 새 version을 만든다.

### 4. 수정 요청과 직접 편집

사용자는 승인 전 아래 작업을 할 수 있다.

- `planner`에게 "범위를 줄여줘", "테스트 계획을 더 자세히 써줘", "Task를 더 작게 나눠줘" 같은 수정 요청 전송
- plan title, summary, task title, acceptance criteria, risk 직접 편집
- external reference 추가/삭제
- draft 폐기

모든 수정은 기존 draft를 덮어쓰지 않고 새 revision으로 저장한다.

### 5. 승인 요청

draft가 schema validation을 통과하면 `ReadyForApproval` 상태가 된다.

승인 화면에는 최소한 아래 항목이 보여야 한다.

- 계획 문서 Markdown
- 생성될 Epic/Task/Subtask 목록
- acceptance criteria
- risk와 검증 계획
- 연결될 external reference
- materialize 후 이동할 첫 Task

### 6. 승인과 materialize

사용자가 승인하면 Helm은 승인된 draft version을 기준으로 Epic/Task/External Ref를 생성한다.

원칙:

- 승인 전에는 `tasks` row를 만들지 않는다.
- 승인 후 materialize는 idempotent 해야 한다.
- 같은 draft version을 두 번 승인해도 Task가 중복 생성되면 안 된다.
- 생성된 Task에는 planning session/draft reference를 external ref 또는 별도 relation으로 남긴다.

### 7. Task core loop 연결

materialize가 끝나면 Helm은 생성된 Task Detail로 이동한다.

이후 흐름은 기존 core loop를 따른다.

```text
Planned
-> Planner 실행
-> PlanApproval
-> Ready
-> Coder
-> PlanVerification
-> CodeReview
-> Testing
-> MergeWaiting
```

Task 생성 전 draft approval과 Task 생성 후 `PlanApproval`은 다른 승인이다.

- Draft approval: "이 계획 문서로 Task를 만들겠다"는 승인
- PlanApproval: "Planner 산출물을 기준으로 구현을 시작해도 된다"는 승인

## 상태 모델

### PlanningSessionStatus

```text
Drafting
NeedsUserInput
ReadyForApproval
Approved
Materialized
Rejected
Archived
```

상태 의미:

| 상태 | 의미 |
| --- | --- |
| `Drafting` | 목표 입력 후 planner 대화 또는 draft 생성 중 |
| `NeedsUserInput` | AI가 추가 질문을 요청함 |
| `ReadyForApproval` | 승인 가능한 draft version이 있음 |
| `Approved` | draft version이 승인됐지만 아직 materialize 전 |
| `Materialized` | Epic/Task 생성 완료 |
| `Rejected` | 사용자가 승인 거절 |
| `Archived` | 보관 처리 |

### PlanDraftStatus

```text
Draft
ReadyForApproval
Approved
Rejected
Superseded
Materialized
```

새 draft version이 생기면 이전 승인 전 draft는 `Superseded`가 된다.

## DB 모델

### planning_sessions

```text
id TEXT PRIMARY KEY
project_id TEXT NOT NULL
title TEXT NOT NULL
status TEXT NOT NULL
goal_text TEXT NOT NULL
repo_context_snapshot_json TEXT NOT NULL
active_draft_id TEXT
approved_draft_id TEXT
materialized_at TEXT
created_at TEXT NOT NULL
updated_at TEXT NOT NULL
```

### planning_messages

```text
id TEXT PRIMARY KEY
project_id TEXT NOT NULL
session_id TEXT NOT NULL
role TEXT NOT NULL -- user | assistant | system | tool
content TEXT NOT NULL
metadata_json TEXT NOT NULL
created_at TEXT NOT NULL
```

### plan_drafts

```text
id TEXT PRIMARY KEY
project_id TEXT NOT NULL
session_id TEXT NOT NULL
version INTEGER NOT NULL
status TEXT NOT NULL
title TEXT NOT NULL
draft_json TEXT NOT NULL
plan_markdown TEXT NOT NULL
source_message_id TEXT
validation_status TEXT NOT NULL
validation_errors_json TEXT NOT NULL
created_at TEXT NOT NULL
updated_at TEXT NOT NULL
UNIQUE(session_id, version)
```

### plan_materializations

```text
id TEXT PRIMARY KEY
project_id TEXT NOT NULL
session_id TEXT NOT NULL
draft_id TEXT NOT NULL
epic_id TEXT
first_task_id TEXT
created_task_ids_json TEXT NOT NULL
created_external_ref_ids_json TEXT NOT NULL
created_at TEXT NOT NULL
UNIQUE(draft_id)
```

`UNIQUE(draft_id)`로 같은 draft가 두 번 materialize되는 것을 막는다.

### approvals 확장

기존 `approvals`는 `entity_type IN ('Task', 'AgentRun')`이고 `approval_type IN ('PlanApproval', 'RunApproval', 'ManualStatusChange')`다.

Plan Draft approval을 Approval Inbox와 같은 UX에 태우려면 migration으로 아래 값을 추가한다.

```text
entity_type: PlanDraft
approval_type: PlanDraftApproval
```

대안은 `plan_draft_approvals` 별도 table을 두는 것이다. 하지만 사용자가 승인 대기 항목을 한 곳에서 처리해야 하므로 기존 `approvals` 확장이 더 단순하다.

## Plan Draft JSON v1

```json
{
  "schemaVersion": 1,
  "title": "planner 계획 대화 승인 흐름 구현",
  "summary": "사용자가 planner와 계획 문서를 확정하고 승인해야 Task를 생성한다.",
  "scope": {
    "in": ["planning session 저장", "planner 대화", "draft versioning", "draft approval", "Task materialize"],
    "out": ["Jira 자동 생성", "자동 구현 실행"]
  },
  "epics": [
    {
      "title": "Planning Conversation",
      "description": "목표 입력을 planner 대화와 계획 문서 draft로 전환한다.",
      "tasks": [
        {
          "title": "planning session DB 모델 추가",
          "description": "세션, 메시지, draft version을 repo-local DB에 저장한다.",
          "subtasks": [
            "planning_sessions migration 추가",
            "planning_messages migration 추가",
            "plan_drafts migration 추가"
          ],
          "acceptanceCriteria": [
            "목표 입력 후 새로고침해도 planning session이 유지된다.",
            "Task는 승인 전 생성되지 않는다."
          ],
          "risks": ["draft approval과 기존 PlanApproval 의미가 섞일 수 있다."],
          "testPlan": ["DB migration 테스트", "PlanningScreen smoke test"]
        }
      ]
    }
  ],
  "openQuestions": [],
  "externalReferences": [],
  "recommendedNextStep": "사용자 승인 후 materialize한다."
}
```

## Tauri command 계약

필수 command:

```text
create_planning_session(project_id, input) -> PlanningSessionSummary
list_planning_sessions(project_id) -> PlanningSessionSummary[]
get_planning_session(project_id, session_id) -> PlanningSessionDetail
append_planning_message(project_id, session_id, input) -> PlanningMessageSummary
run_planner_conversation(project_id, session_id) -> PlannerConversationResult
save_plan_draft_revision(project_id, session_id, input) -> PlanDraftSummary
request_plan_draft_approval(project_id, draft_id) -> ApprovalSummary
approve_plan_draft(project_id, draft_id, approval_id, reason) -> PlanMaterializationSummary
reject_plan_draft(project_id, draft_id, approval_id, reason) -> PlanDraftSummary
materialize_plan_draft(project_id, draft_id) -> PlanMaterializationSummary
```

구현 원칙:

- `create_planning_session`은 Task를 만들지 않는다.
- `run_planner_conversation`은 기존 role runner가 아니라 AI 연결의 `planningCommandArgs`를 사용한다.
- `run_planner_conversation`은 planner raw output을 artifact로 남기고 schema validation을 통과한 draft만 active draft로 올린다.
- `save_plan_draft_revision`은 기존 draft를 update하지 않고 새 version을 insert한다.
- `approve_plan_draft`는 승인과 materialize를 하나의 transaction으로 처리한다.
- `materialize_plan_draft`는 이미 materialized된 draft면 기존 결과를 반환한다.

### AI plan mode 연결

Planning 탭은 `planner` role에 배정된 AI connection의 planning 전용 command를 먼저 사용한다.

```json
{
  "id": "claude-local",
  "provider": "claude",
  "planningMode": "native_plan",
  "planningCommandArgs": ["claude", "--permission-mode", "plan", "-p", "{planPrompt}"]
}
```

provider별 기본값:

| provider | planning mode | command 원칙 |
| --- | --- | --- |
| `claude` | `native_plan` | `claude --permission-mode plan -p {planPrompt}` |
| `codex` | `prompt_guarded` | `codex exec --sandbox read-only --cd {projectRoot} -- {planPrompt}` |
| `fixture` | `fixture` | `fixture-runner.mjs --planning` |

Codex CLI는 현재 로컬 help 기준으로 별도 `plan` subcommand가 없으므로 read-only sandbox와 planning prompt로 감싼다. Claude는 native `--permission-mode plan`을 사용한다.

## Frontend 변경

Planning 화면은 세 구역을 가진다.

- 좌측: planning session 목록과 status
- 중앙: `planner` 대화와 사용자 수정 요청 입력
- 하단 또는 우측: 승인 대상 Plan Document preview/editor
- Plan Document 내부 섹션: scope, open questions, context, Epic/Task/Subtask breakdown, acceptance criteria, risk, test plan

현재 버튼 의미 변경:

| 현재 | 변경 후 |
| --- | --- |
| `계획 추가하기` | `계획자와 시작` |
| 즉시 `api.createTask()` | `api.createPlanningSession()` |
| local session state | DB-backed session list |
| static Plan Draft preview | versioned plan document preview |
| Task Detail 즉시 이동 | draft 승인 후 materialize 결과로 이동 |

승인 버튼 노출 조건:

- active draft가 있음
- schema validation 통과
- open question이 blocking이 아님
- materialize되지 않은 draft임
- 사용자가 현재 draft version을 보고 있음

## Audit event

필수 audit event:

```text
planning_session.created
planning_message.created
plan_draft.created
plan_draft.superseded
plan_draft.approval_requested
plan_draft.approved
plan_draft.rejected
plan_draft.materialized
```

audit payload에는 최소한 `sessionId`, `draftId`, `version`, `approvalId`, `createdTaskIds`를 포함한다.

## Acceptance Criteria

- 목표 입력 후 Task가 즉시 생성되지 않는다.
- 새로고침 후에도 planning session, messages, active draft가 유지된다.
- `planner` 수정 요청을 보내면 기존 draft를 덮어쓰지 않고 새 version이 생성된다.
- `planner`가 목표를 Epic/Task/Subtask로 나누고 각 Task에 acceptance criteria와 test plan을 붙인다.
- 승인 가능한 draft가 없으면 승인 버튼이 비활성화된다.
- 승인 전에는 생성될 Epic/Task/Acceptance Criteria/Risk를 확인할 수 있다.
- 승인하면 Epic/Task/External Ref가 한 transaction으로 생성된다.
- 같은 draft를 두 번 승인해도 Task가 중복 생성되지 않는다.
- 생성된 Task에서 원본 planning session과 approved draft를 추적할 수 있다.
- draft approval과 기존 Task `PlanApproval`은 UI 문구와 audit event에서 구분된다.

## 테스트 계획

- Rust DB 테스트:
  - planning session 생성
  - message append
  - draft version 생성과 supersede
  - invalid draft validation
  - approval request
  - approve + materialize transaction
  - duplicate materialize idempotency
- Frontend 테스트:
  - 목표 입력 시 createTask가 호출되지 않음
  - session list reload
  - draft 수정 요청 후 version 표시 변경
  - 승인 전 preview 항목 표시
- Fixture runner 테스트:
  - 목표와 repo context를 받아 valid Plan Draft JSON 생성
  - 큰 목표를 2개 이상의 Task로 나누는지 확인
  - schema invalid output일 때 draft 저장 차단

## 구현 순서

1. Planning DB migration과 DTO 추가
2. create/list/get planning session command 추가
3. PlanningScreen을 DB-backed session으로 전환
4. manual draft revision 저장 기능 추가
5. Plan Draft approval과 materialize transaction 추가
6. fixture planner conversation 추가
7. Codex/Claude planner runner 연결
8. acceptance test와 README 링크 갱신

## 열린 결정

- 승인된 계획 문서를 Markdown 파일로도 저장할지, 초기에는 DB `plan_markdown`만 기준으로 둘지 결정해야 한다.
- `approvals` table을 확장할지, `plan_draft_approvals`를 별도로 둘지 결정해야 한다.
- materialize 시 Epic을 항상 만들지, Task만 만드는 단순 모드를 허용할지 결정해야 한다.
- 기존 `PlanApproval`을 draft approval 뒤에도 계속 요구할지, 작은 Task에서는 draft approval로 대체할지 정책 결정이 필요하다.
