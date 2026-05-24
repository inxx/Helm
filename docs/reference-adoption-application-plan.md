# Helm Reference Adoption Application Plan

작성일: 2026-05-24

## 목적

이 문서는 외부 레퍼런스 프로젝트에서 확인한 오케스트레이션 패턴을 Helm에 어떻게 적용할지 차용 포인트별로 정리한다.

Helm의 기준은 변하지 않는다.

```text
AI worker는 자기 role만 수행한다.
Helm backend가 상태, 승인, 다음 role, artifact, gate, audit의 source of truth다.
```

따라서 외부 프로젝트에서 가져올 것은 코드나 제품 구조가 아니라 아래 항목이다.

- task/run lifecycle
- planning artifact와 approval 경계
- supervisor/worker 분리
- stale stage watchdog
- review/test repair loop
- merge readiness와 accept/merge 단계
- worker session visibility
- direct source-of-truth와 safe file editing 원칙

## 현재 Helm 기준선

최근 반영된 상태:

- `planner -> PlanApproval -> coder -> plan_verifier -> code_reviewer -> tester -> MergeWaiting` role chain이 있다.
- `supervisor reconciler`가 post-approval role handoff 누락을 복구한다.
- `Conductor AI`는 queued run 시작 전 `record only` 또는 `run/hold gate` 역할만 한다.
- `gateResult`, `command_evidence`, `repair_requests`, task timeline 1차 구현이 있다.
- `retry_host_role`은 terminal failure 계열에서 새 queued run/context pack을 만든다.

남은 핵심 블로커:

1. Planning session이 아직 repo-local durable source of truth가 아니다.
2. Run lifecycle이 `queued/running/succeeded/needs inspection` 중심이라 claim/liveness/failure reason이 약하다.
3. Review/test failure 이후 targeted repair loop가 닫혀 있지 않다.
4. `MergeWaiting` 이후 accept/merge decision 화면이 약하다.
5. 실행 중 worker가 무엇을 하는지 live하게 읽는 session/tool-call visibility가 부족하다.

## 구현 전 블로커 체크리스트

아래 항목은 구현자가 먼저 결정하지 않으면 중간에 막힐 가능성이 높다.

| 블로커 | 왜 막히는가 | 결정 |
| --- | --- | --- |
| SQLite `CHECK` 제약 변경 | `agent_runs.status`, `approvals.entity_type`, `approvals.approval_type`, `run_events.kind`, `repair_requests.status`, `gate_results.gate`는 기존 migration에서 CHECK로 고정되어 있다. SQLite는 CHECK만 간단히 ALTER할 수 없다. | P0에서는 기존 CHECK를 건드리지 않는 additive 설계를 우선한다. 꼭 enum을 넓혀야 하면 table rebuild migration을 별도 milestone으로 분리한다. |
| DraftApproval 저장 위치 | 기존 `approvals`는 `entity_type IN ('Task', 'AgentRun')`, `approval_type IN ('PlanApproval', 'RunApproval', 'ManualStatusChange')`만 허용한다. | Durable Planning P0에서는 `planning_approvals` 새 테이블을 사용한다. 기존 `approvals` 확장은 table rebuild가 필요하므로 나중으로 둔다. |
| Run lifecycle status 확장 | `agent_runs.status` CHECK가 `Claimed`, `Starting`을 허용하지 않는다. | P0에서는 status는 기존 enum을 유지하고, `lifecycle_phase`, `claimed_at`, `heartbeat_at`, `failure_kind` column으로 의미를 확장한다. status enum 확장은 후속 migration으로 분리한다. |
| Run event kind 확장 | `run_events.kind` CHECK는 `tool_call`, `session`, `gate`, `repair`를 허용하지 않는다. | P1 전까지는 기존 `system`/`artifact`/`result` kind에 normalized payload를 넣는다. 새 kind가 필요해지는 Worker Visibility milestone에서 `run_event_details` 보조 테이블 또는 table rebuild를 선택한다. |
| Merge readiness gate 저장 | `gate_results.gate` CHECK는 `merge_readiness`를 허용하지 않는다. | Merge readiness는 P1에서 `gate_results`에 쓰지 않고 `get_merge_readiness`가 계산한 DTO와 `merge_approvals.basis_json`에 저장한다. gate enum 확장은 table rebuild가 필요한 후속 작업으로 둔다. |
| Repair request status 확장 | 기존 `repair_requests.status`는 `Open`, `Resolved`, `Dismissed`만 허용한다. | P0 repair loop에서는 status는 기존 enum을 유지하고 `phase` 또는 `verification_run_id` 보조 column으로 `ResolvedPendingVerification` 의미를 표현한다. |
| Artifact/DB atomicity | file write와 SQLite transaction은 한 transaction으로 묶이지 않는다. | artifact는 `.tmp`에 먼저 쓰고 DB commit 뒤 rename하거나, orphan cleanup을 허용한다. Planning draft는 처음부터 `.tmp -> rename`을 사용한다. |
| Supervisor와 repair rerun 충돌 | supervisor reconciler는 "해당 role run 기록 없음"일 때만 자동 큐잉한다. repair 뒤 gate rerun은 이미 role run 기록이 있어 자동 생성되지 않는다. | repair/gate rerun은 supervisor가 아니라 explicit repair flow command가 생성한다. |
| Planning DraftApproval과 Task PlanApproval 혼동 | 둘 다 "계획 승인"처럼 보이면 사용자가 왜 두 번 승인하는지 이해하기 어렵다. | UI 문구를 명확히 분리한다. DraftApproval은 "Task 생성 승인", PlanApproval은 "구현 시작 승인"이다. |
| Planning materialization 중복 | 같은 draft에서 Task 생성 버튼이 두 번 실행되면 중복 Task가 생길 수 있다. | `planning_materializations.UNIQUE(draft_id)`를 두고, `materialize_plan_draft`는 기존 materialization을 반환하는 idempotent command로 만든다. |
| `ProjectSnapshot` 비대화 | planning detail 전체를 snapshot에 넣으면 snapshot refresh가 무거워진다. | snapshot에는 session summary만 포함하거나 포함하지 않는다. 상세는 `get_planning_session` lazy load로 읽는다. |
| Frontend stale local state | PlanningScreen이 local stub state를 유지하면 DB-backed 전환 후 이중 source of truth가 생긴다. | DB 전환 milestone에서 local session mutation을 제거하고 optimistic update도 command 결과 기준으로만 한다. |

## 우선순위 요약

| 우선순위 | 차용 포인트 | 해결하는 Helm 블로커 |
| --- | --- | --- |
| P0 | Spec Kitty + AI Factory식 DB-backed planning artifact | 계획 근거 유실, Task 생성 근거 불명확 |
| P0 | Multica식 run lifecycle/liveness taxonomy | stuck run, launch 실패, timeout 원인 혼동 |
| P0 | AIF Handoff식 review/test repair loop | gate 실패 후 다음 행동 불명확 |
| P1 | Spec Kitty식 accept/merge 단계 | MergeWaiting 이후 결정 화면 부족 |
| P1 | CAO/Harnss식 worker session visibility | 실행 중 agent 상태 불투명 |
| P1 | Hermes Desktop식 direct source-of-truth/safe editing | 향후 remote/profile/파일 편집 안정성 |
| P2 | AI Factory식 skill/evolution loop | 반복 개선 기록과 정책 축적 |

## 1. Spec Kitty + AI Factory: Durable Planning Artifact

### 차용할 것

- `spec -> plan -> tasks -> next -> review -> accept -> merge`처럼 계획 artifact를 먼저 고정하고 downstream task를 만든다.
- Planning output은 chat state가 아니라 repo-local source of truth가 된다.
- 계획 초안, 승인, task materialization을 별도 audit trail로 남긴다.
- AI Factory의 `explore/grounded/plan/improve/implement/verify` 흐름 중 `explore/grounded/plan`을 Planning Workspace의 내부 단계로 쓴다.

### 차용하지 않을 것

- slash command 중심 UX
- 외부 CLI가 project 파일을 직접 설치/갱신하는 구조
- 계획 승인을 건너뛰고 hands-off로 task를 생성하는 기본값

### 현재 Helm 상태

- `PlanningScreen`은 `PlanningSessionStub` local state에 강하게 의존한다.
- `docs/ai-plan-conversation-approval-feature.md`에 DB-backed planning session 설계가 이미 있다.
- 생성된 Task는 external ref로 일부 planning draft 정보를 남길 수 있지만, 정식 relation은 없다.

### 적용 단계

1. Migration 추가
   - `planning_sessions`
   - `planning_messages`
   - `plan_draft_revisions`
   - `planning_materializations`
   - `planning_approvals`를 새로 둔다. 기존 `approvals`는 CHECK 제약 때문에 P0에서 재사용하지 않는다.

2. Backend command 추가
   - `create_planning_session(project_id, input)`
   - `list_planning_sessions(project_id)`
   - `get_planning_session(project_id, session_id)`
   - `append_planning_message(project_id, session_id, input)`
   - `run_planner_conversation(project_id, session_id)`
   - `save_plan_draft_revision(project_id, session_id, input)`
   - `approve_plan_draft(project_id, draft_id, reason)`
   - `materialize_plan_draft(project_id, draft_id)`

3. Planning artifact 계약
   - DB가 canonical source of truth다.
   - markdown export는 `.helm/planning/{session_id}/draft-v{n}.md`에 artifact로 저장한다.
   - Task 생성 시 `planning_materializations`에 `session_id`, `draft_id`, `task_id`를 남긴다.
   - Task external ref에는 사람이 읽을 수 있는 `planning-session:{id}` reference를 추가한다.

4. UI 전환
   - `PlanningScreen`의 local-only session list를 DB-backed list로 바꾼다.
   - 새로고침/앱 재시작 후에도 session, messages, active draft가 복원되어야 한다.
   - draft approval과 Task `PlanApproval` 문구를 분리한다.

5. Supervisor 연결
   - DraftApproval 승인 후 Task materialize.
   - materialized Task는 `Planned`로 시작한다.
   - planner role은 해당 Task의 구현 계획을 다시 검증하고 `PlanApproval`을 만든다.
   - 작은 Task에서 DraftApproval과 PlanApproval을 합칠지는 별도 정책으로 둔다. 기본은 합치지 않는다.

### 수용 기준

- 목표 입력 후 앱을 재시작해도 planning session과 draft가 보인다.
- 승인된 draft에서 생성된 Task를 열면 원본 session/draft로 되돌아갈 수 있다.
- Task 생성 전 DraftApproval과 Task 구현 전 PlanApproval이 UI/audit에서 구분된다.
- fixture로 `planning session -> draft approval -> task materialize -> planner run` 경로가 검증된다.

### 리스크와 대응

- 리스크: 승인 단계가 많아져 UX가 무거워질 수 있다.
- 대응: 작은 task에는 "Draft 승인 후 바로 Task 생성, PlanApproval은 Task Detail에서 빠른 승인" shortcut을 제공하되 audit은 분리한다.

## 2. Multica: Run Lifecycle and Liveness Taxonomy

### 차용할 것

- run lifecycle을 `enqueue -> claim/dispatch -> start -> complete/fail`로 명확히 나눈다.
- daemon/worker가 run을 claim한 시점과 실제 process가 시작된 시점을 분리한다.
- timeout, launch failure, agent runtime failure, schema failure, user cancellation을 서로 다른 failure reason으로 저장한다.
- retry 가능 여부를 failure reason에서 계산한다.

### 차용하지 않을 것

- hosted queue service
- remote daemon을 기본 source of truth로 두는 구조
- 실패 task를 무조건 자동 retry하는 정책

### 현재 Helm 상태

- `agent_runs.status`는 `Queued`, `Running`, `Succeeded`, `Failed`, `TimedOut`, `NeedsInspection`, `Canceled` 계열을 사용한다.
- `claim_host_run`은 atomic claim을 하지만 상태 표현은 `Running`으로 바로 들어간다.
- `reconcile_interrupted_runs`는 orphan `Running`을 `NeedsInspection`으로 보낸다.
- queued run liveness와 launched process liveness가 명확히 분리되어 있지 않다.

### 적용 단계

1. Lifecycle metadata 확장
   - DB `status`는 기존 CHECK 값인 `Queued`, `Running`, `Succeeded`, `Failed`, `TimedOut`, `NeedsInspection`, `Canceled`만 사용한다.
   - 화면/로직에서 필요한 `Claimed`, `Starting` 의미는 `lifecycle_phase='claimed' | 'starting'`으로 표현한다.
   - metadata 후보: `lifecycle_phase`, `claimed_at`, `started_at`, `heartbeat_at`, `finished_at`, `attempt`, `failure_kind`, `failure_reason`
   - DB migration은 additive column으로 추가한다. status enum 확장은 P0에서 하지 않는다.

2. Claim flow 수정
   - queue worker가 run을 claim하면 `status='Running'`, `lifecycle_phase='claimed'`.
   - process spawn 직전/직후 `lifecycle_phase='starting'`.
   - stdout/stderr stream 또는 adapter session이 확인되면 `lifecycle_phase='running'`.
   - process spawn 실패는 `Failed` 또는 `NeedsInspection`으로 보내되 `failure_kind='launch_failed'`.

3. Liveness reconciler 추가
   - `Queued`가 너무 오래 남아 있으면 `queue_stalled`.
   - `lifecycle_phase='claimed' | 'starting'`이 heartbeat 없이 오래 남아 있으면 `launch_stalled`.
   - `Running`이 timeout을 넘으면 `TimedOut`.
   - app restart 후 in-memory running registry가 비어 있는데 DB run이 `Running`이면 기존처럼 `NeedsInspection`, `failure_kind='orphaned_after_restart'`.

4. Retry policy
   - 자동 retry는 기본 off.
   - `launch_stalled`, `runtime_offline`은 1회 자동 retry 후보.
   - `schema_invalid`, `gate_blocking`, `diff_mismatch`, `agent_reported_needs_changes`는 자동 retry 금지.
   - retry 시 기존 artifact는 보존하고 새 attempt/run을 만든다.

5. UI 반영
   - Task timeline에는 `Queued`, `Claimed`, `Starting`, `Running`처럼 보이게 표시하되, 데이터는 `status + lifecycle_phase`에서 계산한다.
   - "멈춘 실행"과 "검토 필요" 문구를 failure_kind별로 다르게 보여준다.

### 수용 기준

- spawn 실패와 process timeout이 다른 failure_kind로 보인다.
- app restart 후 orphan run이 inspectable 상태로 전환된다.
- stale queued/claimed run을 fixture로 만들고 liveness reconciler가 분류한다.
- retry 버튼은 retry 가능한 failure_kind에서만 primary action으로 보인다.

### 리스크와 대응

- 리스크: status enum을 직접 넓히면 기존 CHECK 제약과 UI mapping을 동시에 건드려야 한다.
- 대응: P0에서는 기존 status를 그대로 두고 `lifecycle_phase` label mapping만 추가한다.

## 3. AIF Handoff: Review/Test Repair Loop

### 차용할 것

- stage failure를 단순 실패가 아니라 actionable blocker로 저장한다.
- review/test finding은 repair request로 바꾸고, repair prompt는 해당 blocker에만 집중한다.
- repair iteration limit를 둔다.
- 반복 실패하면 manual handoff로 전환한다.

### 차용하지 않을 것

- 완전 hands-off 자동 수정 루프
- review finding을 덮어쓰는 방식
- 실패한 gate를 성공처럼 자동 전이하는 정책

### 현재 Helm 상태

- blocking `gateResult`는 `repair_requests`를 만든다.
- Task Detail은 retry/repair 근거를 일부 보여준다.
- 하지만 repair request를 targeted coder repair run으로 연결하는 전용 flow는 약하다.
- 현재 supervisor reconciler는 같은 role run record가 이미 있으면 자동으로 다시 큐잉하지 않는다. 이것은 무한 루프 방지에는 좋지만, repair 성공 후 gate rerun을 명시적으로 만들어야 한다.

### 적용 단계

1. Repair run 모델
   - `agent_runs`에 `run_purpose: 'role' | 'repair' | 'gate_rerun'`을 추가한다.
   - `repair_request_id`를 run에 연결한다.
   - normal role validation과 repair validation을 분리한다.

2. Repair context pack
   - `context-pack.md`에 아래를 포함한다.
     - failed gate
     - blockers
     - affected files
     - previous run summary
     - allowed scope
     - "새 기능 추가 금지, blocker 해결만" 규칙

3. Repair execution
   - `prepare_repair_context(project_id, repair_request_id)`
   - coder 또는 configured repairer connection으로 실행한다.
   - repair 성공 시 `repair_requests.status='Open'`, `phase='resolved_pending_verification'`으로 둔다.

4. Gate rerun
   - repair 성공 후 실패했던 gate role을 다시 큐잉한다.
   - 이때 `run_purpose='gate_rerun'` 또는 `attempt`로 이전 failed run과 구분한다.
   - gate pass면 `repair_requests.status='Resolved'`, `phase='closed'`.
   - gate fail이면 iteration count 증가.
   - open repair request가 있으면 일반 supervisor handoff는 같은 task의 normal role을 새로 만들지 않는다.

5. Iteration limit
   - 기본 `maxRepairIterations=2`.
   - 초과 시 task status는 해당 gate 상태에 남기고 manual review handoff 표시.

### 수용 기준

- code review fail -> repair request -> repair run -> code review rerun -> pass 경로가 fixture로 검증된다.
- repair prompt는 failed gate의 blockers만 포함한다.
- 세 번째 반복 실패는 자동 큐잉하지 않고 manual handoff를 표시한다.

### 리스크와 대응

- 리스크: repair run이 scope를 넓혀 새 문제를 만들 수 있다.
- 대응: changed files allowlist, diff consistency gate, affectedFiles 중심 context를 강제한다.

## 4. Spec Kitty: Merge Readiness, Accept, Merge

### 차용할 것

- review/test를 통과한 뒤 `accept` 단계에서 사람의 최종 결정을 받는다.
- merge는 자동 실행보다 preview와 approval basis를 먼저 보여준다.
- merge readiness는 diff, tests, blockers, gate result, branch state를 한 화면에 모은다.

### 차용하지 않을 것

- 자동 merge 기본값
- GitHub/GitLab remote dependency를 core loop 필수로 만드는 구조
- local Git 상태를 agent summary로 대체하는 구조

### 현재 Helm 상태

- `MergeWaiting` 상태는 있다.
- Git snapshot과 worktree diff는 볼 수 있다.
- merge command preview, merge approval, blocker summary는 아직 약하다.

### 적용 단계

1. Backend command
   - `get_merge_readiness(project_id, task_id)`
   - `create_merge_approval(project_id, task_id, basis)`
   - `preview_merge_command(project_id, task_id)`
   - 실제 merge 실행은 P1 후반 또는 P2로 둔다.

2. Readiness 계산
   - worktree branch exists
   - base branch clean enough
   - changed files present
   - latest coder/verifier/reviewer/tester run pass
   - open repair request 없음
   - blocking gate 없음
   - uncommitted diff summary

3. UI
   - `MergeWaiting` Task Detail 상단을 merge readiness panel로 바꾼다.
   - "왜 merge 가능한가"와 "무엇이 아직 막는가"를 구분한다.
   - command preview는 복사/실행 전 approval basis로 남긴다.

4. Audit
   - `merge_readiness.checked`는 `run_events.kind='system'`, `payload.type='merge_readiness.checked'`로 기록한다.
   - `merge_approval.created`
   - `merge_approval.approved/rejected`
   - 나중에 실제 merge를 붙이면 `merge.executed`

### 수용 기준

- MergeWaiting task에서 merge 가능/불가 사유가 한 화면에 보인다.
- blocking repair request가 있으면 merge readiness가 fail이다.
- approval basis에 diff/gate/test summary가 남는다.

### 리스크와 대응

- 리스크: 자동 merge를 너무 빨리 붙이면 복구가 어렵다.
- 대응: 처음에는 read-only readiness + command preview까지만 구현한다.

## 5. CAO + Harnss: Worker Session Visibility and Human Attach

### 차용할 것

- supervisor와 worker session을 분리한다.
- worker가 무엇을 하고 있는지 stdout/stderr, tool call, artifact event로 보여준다.
- 사용자가 실행 중 session을 관찰하고 필요 시 steering message를 보낼 수 있다.
- Harnss의 Codex app-server wrapper와 tool-call renderer 패턴을 Helm adapter/UI에 맞게 재설계한다.

### 차용하지 않을 것

- chat cockpit을 Helm의 중심 모델로 바꾸는 것
- tmux/Electron/ACP 구조를 그대로 runtime dependency로 삼는 것
- agent session state를 Helm DB보다 상위 source of truth로 두는 것

### 현재 Helm 상태

- role PTY session과 terminal session 구조가 있다.
- run event stream과 stdout/stderr chunk event가 있다.
- Codex app-server runner bridge가 있다.
- Task Detail에서 live session/tool-call visualization은 아직 약하다.

### 적용 단계

1. Run event taxonomy 확장
   - `stdout_chunk`
   - `stderr_chunk`
   - `tool_call.started`
   - `tool_call.completed`
   - `artifact.created`
   - `session.ready`
   - `session.message`

2. Adapter normalization
   - process runner, codex app-server runner, future claude runner가 같은 event schema를 emit한다.
   - tool call payload는 provider-specific field를 `metadata.raw`에 넣고 UI용 normalized fields를 별도로 둔다.

3. UI
   - Task Detail에 "현재 실행" live panel을 둔다.
   - stdout/stderr는 접을 수 있는 stream으로 표시한다.
   - tool call은 카드로 표시한다.
   - artifact 생성 이벤트는 클릭하면 artifact viewer로 이동한다.

4. Human attach
   - P1에서는 read-only observe.
   - P2에서 `send_message_to_role_session`을 추가한다.
   - steering message는 run event/audit에 남긴다.

### 수용 기준

- 장기 실행 중 Task Detail에서 stdout/stderr가 갱신된다.
- Codex app-server tool call이 normalized tool event로 보인다.
- artifact 생성 event를 클릭해 `summary.md` 또는 `structured-result.json`을 열 수 있다.

### 리스크와 대응

- 리스크: live stream 저장량이 커질 수 있다.
- 대응: DB에는 chunk metadata와 bounded preview를 저장하고 full log는 artifact file에 둔다.

## 6. Hermes Desktop: Direct Source of Truth and Safe Editing

### 차용할 것

- remote/gateway보다 실제 대상 repo/host 상태를 직접 읽는 원칙.
- connection profile과 workspace fingerprint.
- safe file editing: UTF-8 validation, size limit, symlink check, content hash conflict, atomic write.
- service command와 user terminal의 권한 분리.

### 차용하지 않을 것

- Helm 기본 운영 모델을 remote host 중심으로 바꾸는 것
- SwiftUI/SwiftTerm UI 코드
- Hermes Desktop식 Kanban/Cron/Skills 전체 제품 구조

### 현재 Helm 상태

- Helm source of truth는 `.helm/helm.sqlite`, artifacts, local Git이다.
- 기본 terminal/role runner 권한은 분리되고 있다.
- safe file edit abstraction은 아직 명시적이지 않다.

### 적용 단계

1. Workspace fingerprint
   - project root
   - base branch
   - worktree root
   - runner profile id
   - local machine identity는 저장 최소화

2. Safe edit helper
   - plan/draft/config 편집에 먼저 적용
   - content hash precondition
   - symlink refusal
   - max file size
   - atomic write

3. Runner profile
   - local process profile
   - codex app-server profile
   - future SSH service profile
   - user terminal profile과 service runner profile 분리

4. Diagnostics
   - profile check 결과를 Settings에 저장하지 않고 최신 check result로만 표시
   - credential value는 DB에 저장하지 않고 OS secret store/keychain reference만 저장

### 수용 기준

- planning draft/config 저장 시 hash conflict가 감지된다.
- symlink target 편집이 거부된다.
- runner profile과 terminal profile이 UI/DB에서 분리된다.

### 리스크와 대응

- 리스크: safe editing abstraction이 과도하게 커질 수 있다.
- 대응: 처음에는 planning draft markdown export와 project settings edit에만 적용한다.

## 7. AI Factory: Quality Gate and Knowledge Evolution

### 차용할 것

- quality gate 결과를 role output의 핵심 계약으로 둔다.
- repeated failure나 reusable lesson을 memory/pattern으로 승격한다.
- implementation 이후 verify를 별도 단계로 둔다.

### 차용하지 않을 것

- project에 skill 파일을 자동 설치/수정하는 구조
- agent가 memory를 무제한으로 쓰는 구조

### 현재 Helm 상태

- `gateResult` schema가 있다.
- diff consistency gate가 있다.
- Obsidian memory save는 Codex 세션 차원에서 운영 중이다.
- Helm 내부 "project memory record"는 아직 없다.

### 적용 단계

1. Gate catalog 정리
   - `plan_verification`
   - `code_review`
   - `test`
   - `security`
   - `rules`
   - `merge_readiness`는 P1에서 계산형 readiness DTO로 먼저 제공하고, `gate_results.gate`에는 저장하지 않는다.

2. Gate result 강화
   - severity
   - confidence
   - evidence links
   - repair suggestion
   - machine-readable blocker fingerprint

3. Knowledge record
   - P2 기본안은 `project_memory_records` 새 테이블이다.
   - Obsidian export relation은 사용자가 durable memory 승격을 승인한 뒤 연결하는 보조 경로로 둔다.
   - repeated repair finding이 2회 이상 나오면 "project pattern 후보"로 표시한다.

4. UI
   - Task timeline에서 gate pass/fail만이 아니라 "근거"와 "다음 수리 단위"를 보여준다.

### 수용 기준

- gate failure가 repair request와 1:1로 연결된다.
- 같은 blocker가 반복되면 UI에서 반복 이슈로 보인다.
- project memory 승격은 자동 write가 아니라 사용자 승인 기반이다.

## Cross-Cutting Policy: Automation Modes

현재 용어 혼동을 줄이기 위해 아래 모드로 정리한다.

| Mode | 의미 | 기본값 후보 |
| --- | --- | --- |
| `manual` | Helm이 다음 run을 만들지 않고 사용자가 버튼으로 진행 | 보수적 프로젝트 |
| `record` | Conductor AI는 선택 기록만 남김. Supervisor repair는 별도 설정에 따름 | 현재 observe 이름 대체 |
| `repair` | Supervisor가 누락된 post-approval next role을 큐잉 | 기본 추천 |
| `gate` | Supervisor가 만든 queued run을 Conductor AI가 `run/hold` 판단 | 위험 작업 |
| `full_auto` | approval까지 자동화 | 초기에는 금지 |

추천 기본값:

```text
DraftApproval: human
PlanApproval: human
Post-approval role handoff: repair
Conductor AI: record
MergeApproval: human (stored in merge_approvals)
```

## 적용 로드맵

### Milestone A. Durable Planning

목표: 계획이 새로고침/재시작에 사라지지 않고 Task 생성 근거로 남는다.

작업:

1. planning DB migration
2. planning commands
3. PlanningScreen DB-backed 전환
4. draft approval/materialization audit
5. fixture/user-flow test

완료 기준:

- 앱 재시작 후 planning session 복원
- approved draft에서 생성된 Task의 provenance 확인

### Milestone B. Liveness-Aware Runner

목표: stuck run을 원인별로 분류하고 올바른 next action을 보여준다.

작업:

1. run lifecycle metadata migration
2. claim/starting/running 분리
3. heartbeat/liveness reconciler
4. failure_kind별 retry policy
5. UI 문구/버튼 정리

완료 기준:

- launch failure, timeout, orphan running, schema invalid가 서로 다르게 보인다.

### Milestone C. Repair Loop

목표: review/test failure가 actionable repair flow로 이어진다.

작업:

1. repair run purpose/repair_request relation
2. targeted repair context pack
3. repair success 후 gate rerun
4. iteration limit
5. manual handoff

완료 기준:

- fixture로 `review fail -> repair -> review rerun -> pass` 검증

### Milestone D. Merge Readiness

목표: MergeWaiting에서 사용자가 merge 가능 여부를 판단할 수 있다.

작업:

1. merge readiness backend
2. MergeWaiting panel
3. merge approval basis
4. command preview

완료 기준:

- blocker가 있으면 readiness fail
- pass면 command preview와 approval basis 표시

### Milestone E. Worker Visibility

목표: 실행 중 worker 상태를 볼 수 있다.

작업:

1. normalized run event schema
2. stdout/stderr bounded live panel
3. tool-call event cards
4. artifact event links
5. read-only human attach foundation

완료 기준:

- 장기 실행 중 Task Detail이 live하게 갱신된다.

## 기술 구현 분석

이 섹션은 위 차용 계획을 현재 Helm 코드 구조에 맞춰 구현 가능한 단위로 내린다.

현재 구현 경계:

- DB migration: `apps/desktop/src-tauri/migrations/0001_phase1.sql` ~ `0005_run_events.sql`
- migration loader: `apps/desktop/src-tauri/src/db.rs`의 `SUPPORTED_SCHEMA_VERSION`, `*_MIGRATION`, `run_migrations`
- Rust DTO: `apps/desktop/src-tauri/src/models.rs`
- DB/service 함수: `apps/desktop/src-tauri/src/db.rs`
- Tauri command/worker: `apps/desktop/src-tauri/src/main.rs`
- Frontend API/types: `apps/desktop/src/lib/api.ts`, `apps/desktop/src/lib/types.ts`
- 주요 UI: `PlanningScreen.tsx`, `TaskDetail.tsx`, `SettingsScreen.tsx`

마이그레이션 순서 결정:

- `0006_planning_workspace.sql`: planning tables/indexes only. 기존 CHECK 제약을 건드리지 않는다.
- `0007_run_lifecycle_repair.sql`: `agent_runs` lifecycle column과 `repair_requests` phase/iteration column. table rebuild 없이 `ALTER TABLE ADD COLUMN`만 사용한다.
- `0008_merge_readiness.sql`: `merge_approvals` table. `approvals`와 `gate_results` CHECK는 건드리지 않는다.
- migration을 추가할 때마다 `SUPPORTED_SCHEMA_VERSION`, `include_str!`, `run_migrations` 순서를 같이 올린다.
- column 추가 migration은 `apply_schema_patch`로 전체 SQL을 재실행하면 중복 column 오류가 날 수 있다. schema patch fallback이 필요하면 `column_exists(conn, table, column)` helper로 column별 보강을 한다.

### A. Durable Planning 기술 설계

#### Migration

새 migration은 `0006_planning_workspace.sql`로 추가한다.

`db.rs` 변경:

```rust
const SUPPORTED_SCHEMA_VERSION: i64 = 6;
const PHASE6_MIGRATION: &str = include_str!("../migrations/0006_planning_workspace.sql");
```

`run_migrations`에는 아래 순서로 추가한다.

```rust
if current_version < 6 {
    apply_migration(conn, 6, "planning_workspace", PHASE6_MIGRATION)?;
} else if !table_exists(conn, "planning_sessions")? {
    apply_schema_patch(conn, PHASE6_MIGRATION)?;
}
```

`PHASE6_MIGRATION`은 새 table 생성만 포함하므로 이 fallback을 둘 수 있다. `0007_run_lifecycle_repair.sql`처럼 column을 추가하는 migration에는 같은 방식의 전체 `apply_schema_patch`를 쓰지 않는다.

권장 schema:

```sql
CREATE TABLE planning_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  goal_text TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'Drafting',
    'ReadyForApproval',
    'Approved',
    'Materialized',
    'Archived'
  )),
  active_draft_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE planning_messages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  body TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES planning_sessions(id) ON DELETE CASCADE
);

CREATE TABLE plan_draft_revisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'Draft',
    'ReadyForApproval',
    'Approved',
    'Rejected',
    'Materialized'
  )),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  body_markdown TEXT NOT NULL,
  draft_json TEXT NOT NULL,
  artifact_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(session_id, version),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES planning_sessions(id) ON DELETE CASCADE
);

CREATE TABLE planning_materializations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  task_id TEXT,
  epic_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES planning_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (draft_id) REFERENCES plan_draft_revisions(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL,
  FOREIGN KEY (epic_id) REFERENCES epics(id) ON DELETE SET NULL,
  UNIQUE(draft_id)
);

CREATE INDEX idx_planning_sessions_project_updated
  ON planning_sessions(project_id, updated_at DESC);
CREATE INDEX idx_planning_messages_session_created
  ON planning_messages(session_id, created_at ASC);
CREATE INDEX idx_plan_drafts_session_version
  ON plan_draft_revisions(session_id, version DESC);
```

`planning_approvals`:

기존 `approvals` table은 CHECK 제약 때문에 P0에서 확장하지 않는다. DraftApproval은 planning 전용 테이블로 둔다.

```sql
CREATE TABLE planning_approvals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('Pending', 'Approved', 'Rejected', 'Expired')),
  requested_reason TEXT NOT NULL,
  decision_reason TEXT,
  requested_at TEXT NOT NULL,
  decided_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES planning_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (draft_id) REFERENCES plan_draft_revisions(id) ON DELETE CASCADE,
  UNIQUE(draft_id)
);

CREATE INDEX idx_planning_approvals_session_status
  ON planning_approvals(session_id, status);
```

장기적으로 통합 approval inbox가 필요해지면 `approvals` table rebuild 또는 union query view 중 하나를 선택한다. P0/P1 기본은 union query view 또는 frontend aggregation이다.

#### Rust DTO

`models.rs`에 추가할 구조:

```rust
pub struct PlanningSessionSummary {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub goal_text: String,
    pub status: String,
    pub active_draft_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

pub struct PlanningMessageSummary {
    pub id: String,
    pub project_id: String,
    pub session_id: String,
    pub role: String,
    pub body: String,
    pub metadata: Value,
    pub created_at: String,
}

pub struct PlanDraftRevisionSummary {
    pub id: String,
    pub project_id: String,
    pub session_id: String,
    pub version: i64,
    pub status: String,
    pub title: String,
    pub summary: String,
    pub body_markdown: String,
    pub draft_json: Value,
    pub artifact_path: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

pub struct PlanningApprovalSummary {
    pub id: String,
    pub project_id: String,
    pub session_id: String,
    pub draft_id: String,
    pub status: String,
    pub requested_reason: String,
    pub decision_reason: Option<String>,
    pub requested_at: String,
    pub decided_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

pub struct PlanningSessionDetail {
    pub session: PlanningSessionSummary,
    pub messages: Vec<PlanningMessageSummary>,
    pub drafts: Vec<PlanDraftRevisionSummary>,
    pub approvals: Vec<PlanningApprovalSummary>,
}
```

입력 DTO:

- `CreatePlanningSessionInput { title, goal_text, jira_ref? }`
- `AppendPlanningMessageInput { body, metadata? }`
- `SavePlanDraftRevisionInput { title, summary, body_markdown, draft_json }`
- `ApprovePlanningDraftInput { reason }`
- `RejectPlanningDraftInput { reason }`
- `MaterializePlanDraftInput { draft_id }`

#### DB 함수

`db.rs`에 추가할 함수:

- `create_planning_session`
- `list_planning_sessions`
- `get_planning_session_detail`
- `append_planning_message`
- `save_plan_draft_revision`
- `approve_plan_draft`
- `reject_plan_draft`
- `materialize_plan_draft`

트랜잭션 경계:

- `create_planning_session`: session + first user message + audit를 하나의 transaction으로 묶는다.
- `save_plan_draft_revision`: artifact temp write 준비 후 next version 계산 + draft insert + session active_draft_id update를 DB transaction으로 묶고, commit 뒤 temp file을 final path로 rename한다.
- `approve_plan_draft`: pending planning approval update + draft status update + session status update + audit를 묶는다.
- `materialize_plan_draft`: draft status update + task/epic create + materialization rows + external refs + audit를 하나의 transaction으로 묶는다.

주의점:

- artifact file write와 DB transaction은 완전 atomic하지 않다. Planning draft는 `.tmp` 파일을 쓰고 DB commit 후 rename한다. commit 실패 시 `.tmp`만 cleanup한다.
- draft artifact path는 `validate_relative_artifact_path`와 같은 방어를 재사용한다.
- `materialize_plan_draft`는 idempotency를 가져야 한다. 같은 approved draft를 두 번 materialize하면 기존 `planning_materializations`와 Task 목록을 반환하고 새 Task를 만들지 않는다.

#### Tauri command/API

`main.rs` command:

- `create_planning_session`
- `list_planning_sessions`
- `get_planning_session`
- `append_planning_message`
- `save_plan_draft_revision`
- `approve_plan_draft`
- `reject_plan_draft`
- `materialize_plan_draft`

`api.ts`:

```ts
createPlanningSession(projectId, input)
listPlanningSessions(projectId)
getPlanningSession(projectId, sessionId)
appendPlanningMessage(projectId, sessionId, input)
savePlanDraftRevision(projectId, sessionId, input)
approvePlanDraft(projectId, draftId, reason)
rejectPlanDraft(projectId, draftId, reason)
materializePlanDraft(projectId, draftId)
```

`types.ts`에는 Rust DTO와 1:1 camelCase 타입을 둔다.

#### UI 전환

`PlanningScreen.tsx` 단계:

1. 기존 `PlanningSessionStub` local state를 DB-backed DTO로 대체한다.
2. 화면 진입 시 `listPlanningSessions`.
3. session 선택 시 `getPlanningSession`.
4. user message append 후 `runPlannerConversation`은 기존 command를 임시 사용하되, 결과를 `planning_messages`와 `plan_draft_revisions`에 저장한다.
5. "Task로 만들기"는 `materializePlanDraft`를 호출한다.

상태 저장 원칙:

- optimistic local-only session 생성 금지. command가 성공한 뒤 반환된 session을 화면에 반영한다.
- assistant 답변이 실패해도 user message는 저장하고 session status는 `Drafting`으로 유지한다.
- draft 생성 실패는 toast + message row error metadata로 표시하고, session 자체는 유지한다.

중요한 UX 구분:

- DraftApproval: "이 계획 초안으로 Task를 만들어도 된다."
- PlanApproval: "이 Task의 planner 결과를 기준으로 구현을 시작해도 된다."

### B. Run Lifecycle/Liveness 기술 설계

#### Migration

새 migration 후보: `0007_run_lifecycle_repair.sql`.

기존 `agent_runs`에 nullable column을 추가한다.

```sql
ALTER TABLE agent_runs ADD COLUMN claimed_at TEXT;
ALTER TABLE agent_runs ADD COLUMN heartbeat_at TEXT;
ALTER TABLE agent_runs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1;
ALTER TABLE agent_runs ADD COLUMN failure_kind TEXT;
ALTER TABLE agent_runs ADD COLUMN failure_reason TEXT;
ALTER TABLE agent_runs ADD COLUMN parent_run_id TEXT;
ALTER TABLE agent_runs ADD COLUMN run_purpose TEXT NOT NULL DEFAULT 'role';
ALTER TABLE agent_runs ADD COLUMN lifecycle_phase TEXT NOT NULL DEFAULT 'queued';
ALTER TABLE agent_runs ADD COLUMN repair_request_id TEXT;

CREATE INDEX idx_agent_runs_project_status_updated
  ON agent_runs(project_id, status, updated_at);
CREATE INDEX idx_agent_runs_parent
  ON agent_runs(parent_run_id);
CREATE INDEX idx_agent_runs_repair_request
  ON agent_runs(repair_request_id);
```

기존 데이터 backfill:

```sql
UPDATE agent_runs
SET lifecycle_phase = CASE
    WHEN status = 'Queued' THEN 'queued'
    WHEN status = 'Running' THEN 'running'
    ELSE 'completed'
  END;

UPDATE agent_runs
SET claimed_at = COALESCE(claimed_at, started_at),
    heartbeat_at = COALESCE(heartbeat_at, updated_at)
WHERE status = 'Running';
```

중요 결정:

- 현재 `agent_runs.status` CHECK는 `Claimed`, `Starting`을 허용하지 않는다.
- P0에서는 status enum을 확장하지 않는다.
- `status`는 기존 값으로 유지하고, 세부 lifecycle은 `lifecycle_phase`로 표현한다.
- `lifecycle_phase` 후보: `queued`, `claimed`, `starting`, `running`, `finishing`, `completed`.
- 나중에 status enum을 넓힐 때는 `agent_runs` table rebuild migration을 별도로 만든다.

#### Status 의미

권장 mapping:

| DB status | lifecycle_phase | 의미 | source |
| --- | --- | --- |
| `Queued` | `queued` | context pack 준비 완료, worker claim 전 | `prepare_role_context` |
| `Running` | `claimed` | queue worker가 run 소유권 확보 | `claim_host_run` |
| `Running` | `starting` | process/session spawn 진행 중 | host runner wrapper |
| `Running` | `running` | stdout/stderr/session heartbeat 확인 | runner adapter |
| `Succeeded` | `completed` | schema/gate/diff checks 통과 | `run_host_role` |
| `Failed` | `completed` | process/runtime 실패 | runner adapter |
| `TimedOut` | `completed` | timeout 초과 | runner adapter |
| `NeedsInspection` | `completed` | schema/gate/diff/orphan 등 사람 검토 필요 | Helm checks |
| `Canceled` | `completed` | 사용자 취소 | cancel command |

#### failure_kind

권장 값:

- `launch_failed`
- `queue_stalled`
- `claim_stalled`
- `runtime_timeout`
- `runtime_nonzero_exit`
- `schema_invalid`
- `gate_blocking`
- `diff_mismatch`
- `orphaned_after_restart`
- `user_canceled`
- `conductor_held`
- `conductor_failed`

`failure_kind`는 UI next action과 retry 가능 여부의 핵심 입력이다.

#### DB 함수 변경

- `claim_host_run`: `Queued -> Running`, `lifecycle_phase='claimed'`, `claimed_at`, `heartbeat_at` 기록.
- process spawn 직전: `mark_host_run_starting`이 `lifecycle_phase='starting'`을 기록.
- stream 첫 chunk 또는 session ready: `mark_host_run_running`이 `lifecycle_phase='running'`을 기록.
- output chunk/event마다 `heartbeat_at` 갱신. 너무 자주 쓰면 DB write가 많으므로 2~5초 throttle.
- `mark_host_run_launch_error`: `failure_kind='launch_failed'`.
- `mark_host_run_needs_inspection`: caller가 failure_kind를 넘기게 확장.

#### Liveness reconciler

`reconcile_interrupted_runs`와 별개로 `reconcile_stale_runs`를 둔다.

입력:

- project_id
- now
- thresholds

기본 threshold:

- `Queued`: 10분
- `lifecycle_phase='claimed'`: 2분
- `lifecycle_phase='starting'`: 2분
- `lifecycle_phase='running'`: role timeout 또는 heartbeat 5분 이상 없음

동작:

- stale `Queued`: `NeedsInspection`, `queue_stalled`
- stale `lifecycle_phase='claimed' | 'starting'`: `NeedsInspection`, `claim_stalled` 또는 `launch_failed`
- stale `lifecycle_phase='running'`: `TimedOut` 또는 `NeedsInspection`, 상황에 따라 `runtime_timeout`/`orphaned_after_restart`

`open_project(... reconcileStaleRuns=true)` 때 실행하고, queue worker idle loop에서도 저빈도로 실행한다.

#### UI 변경

`TaskDetail.tsx`:

- `isRetryableRunStatus`를 status만 보지 말고 `failureKind`를 함께 본다.
- retry 가능: `launch_failed`, `queue_stalled`, `runtime_timeout`, `runtime_nonzero_exit`, `orphaned_after_restart`
- retry 비권장: `gate_blocking`, `diff_mismatch`, `schema_invalid`

`types.ts`:

```ts
export interface AgentRunSummary {
  ...
  claimedAt?: string | null;
  heartbeatAt?: string | null;
  attempt?: number;
  failureKind?: string | null;
  failureReason?: string | null;
  parentRunId?: string | null;
  lifecyclePhase?: string | null;
  repairRequestId?: string | null;
  runPurpose?: "role" | "repair" | "gate_rerun" | string;
}
```

### C. Repair Loop 기술 설계

#### DB 확장

기존 `repair_requests`를 유지하되 아래 column을 추가한다.

```sql
ALTER TABLE repair_requests ADD COLUMN iteration INTEGER NOT NULL DEFAULT 0;
ALTER TABLE repair_requests ADD COLUMN max_iterations INTEGER NOT NULL DEFAULT 2;
ALTER TABLE repair_requests ADD COLUMN fingerprint TEXT;
ALTER TABLE repair_requests ADD COLUMN resolved_by_run_id TEXT;
ALTER TABLE repair_requests ADD COLUMN verification_run_id TEXT;
ALTER TABLE repair_requests ADD COLUMN phase TEXT NOT NULL DEFAULT 'open';
```

기존 데이터 backfill:

```sql
UPDATE repair_requests
SET phase = CASE
    WHEN status = 'Resolved' THEN 'closed'
    WHEN status = 'Dismissed' THEN 'manual_handoff'
    ELSE 'open'
  END;
```

`repair_requests.status` CHECK는 `Open`, `Resolved`, `Dismissed`만 허용한다. `ResolvedPendingVerification` 같은 새 status를 넣지 않는다. 대신 `phase`로 세부 단계를 표현한다.

권장 `phase`:

- `open`
- `in_repair`
- `resolved_pending_verification`
- `closed`
- `manual_handoff`

`agent_runs`에는 `run_purpose`, `parent_run_id`, `repair_request_id`가 필요하다. 이 column들은 위 Run Lifecycle migration에서 함께 추가하므로 Repair migration에서 중복 ALTER하지 않는다.

#### Backend 함수

- `prepare_repair_context(project_id, repair_request_id)`
- `run_repair_role(project_id, run_id)` 또는 기존 `run_host_role` 재사용
- `queue_gate_rerun_after_repair(project_id, repair_request_id)`
- `close_repair_request_if_gate_passed`

`prepare_repair_context`는 normal role의 `validate_role_run_state`를 그대로 쓰면 안 된다. 예를 들어 task가 `CodeReview` 상태이고 code review가 fail한 뒤 repair coder를 다시 돌려야 하는데, normal coder는 `Ready`에서만 허용된다. 따라서 repair 전용 validation이 필요하다.

권장 validation:

- repair request status가 `Open`
- repair request phase가 `open` 또는 `in_repair`
- related failed gate/run이 task에 속함
- iteration < max_iterations
- active repair run 없음
- affected files가 task worktree 안에 있음

#### Repair Context Pack

repair context는 normal context보다 좁아야 한다.

필수 포함:

- 원래 task title/description
- failed run id/role
- failed gate
- blockers
- affected files
- previous summary
- changed files/diff excerpt
- allowed scope
- forbidden: unrelated refactor, new feature, broad dependency update

artifact:

- `repair-context-pack.md`
- `repair-request.json`
- 기존 `structured-result.schema.json`

#### Gate rerun

repair run이 pass하면 즉시 task status를 다음 단계로 전이하지 않는다.

순서:

```text
CodeReview fail
-> repair_request Open
-> coder repair run Succeeded
-> repair_request status Open, phase resolved_pending_verification
-> code_reviewer gate_rerun Queued
-> code_reviewer pass
-> repair_request status Resolved, phase closed
-> task Testing
```

이 flow는 supervisor reconciler와 충돌하지 않아야 한다. supervisor는 "해당 role run 기록 없음"일 때만 자동 큐잉하므로, gate rerun은 별도 explicit function이 만들어야 한다.

추가 guard:

- open repair request가 있으면 supervisor reconciler는 해당 task의 일반 next role을 큐잉하지 않는다.
- repair run이 active인 동안 normal retry 버튼은 비활성화한다.
- gate rerun은 `run_purpose='gate_rerun'`이므로 `has_role_run` 중복 방지와 별도 경로를 탄다.

### D. Merge Readiness 기술 설계

#### DTO

`models.rs`:

```rust
pub struct MergeReadinessSummary {
    pub task_id: String,
    pub status: String, // pass | fail | needs_inspection
    pub branch_name: Option<String>,
    pub worktree_path: Option<String>,
    pub base_branch: Option<String>,
    pub head_hash: Option<String>,
    pub changed_files: Vec<GitFileStatus>,
    pub blockers: Vec<MergeBlockerSummary>,
    pub gate_summary: Value,
    pub command_preview: Vec<String>,
}

pub struct MergeBlockerSummary {
    pub id: String,
    pub kind: String,
    pub severity: String,
    pub summary: String,
    pub source_id: Option<String>,
}
```

`types.ts`에 동일 타입 추가.

#### Backend command

- `get_merge_readiness(project_id, task_id)`
- `create_merge_approval(project_id, task_id, basis_json)`
- `preview_merge_command(project_id, task_id)`

첫 단계에서는 실제 `merge` command 실행을 만들지 않는다.

기존 `approvals` table은 `approval_type='MergeApproval'`을 허용하지 않는다. P1 merge approval은 아래 중 하나를 선택한다.

- 단기: `merge_approvals` 새 테이블을 만든다.
- 장기: `approvals` table rebuild로 `MergeApproval`을 허용한다.

P1 권장안은 새 `merge_approvals` table이다. 이유는 기존 approval inbox와 충돌 없이 merge basis JSON을 넉넉히 저장할 수 있기 때문이다.

```sql
CREATE TABLE merge_approvals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('Pending', 'Approved', 'Rejected', 'Expired')),
  readiness_status TEXT NOT NULL CHECK (readiness_status IN ('pass', 'fail', 'needs_inspection')),
  basis_json TEXT NOT NULL,
  command_preview_json TEXT NOT NULL,
  requested_reason TEXT NOT NULL,
  decision_reason TEXT,
  requested_at TEXT NOT NULL,
  decided_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX idx_merge_approvals_task_status
  ON merge_approvals(task_id, status);
```

`basis_json`에는 readiness DTO, 최신 required role run id, blocking gate summary, diff hash, head hash를 넣는다. 승인 직전에는 `get_merge_readiness`를 다시 실행해서 `basis_json`의 head hash와 현재 head hash가 다르면 승인을 막는다.

#### Readiness 계산 기준

Fail blockers:

- task status != `MergeWaiting`
- task worktree 없음
- changed files 없음
- open repair request 있음
- latest required role run이 pass가 아님
- blocking gate 있음
- worktree path 없음/삭제됨
- base branch 확인 실패

NeedsInspection:

- Git diff 읽기 실패
- branch head_hash 없음
- gate result metadata 일부 누락

Pass:

- required role runs pass
- open repair 없음
- diff 읽기 성공
- blocking gate 없음

Command preview 정책:

- preview는 문자열이 아니라 argv 배열로 저장한다.
- 예: `["git", "-C", "<repo>", "merge", "--no-ff", "<task-branch>"]`
- 실제 실행 전에는 base branch checkout, dirty state, worktree path를 다시 검증한다.

#### UI

`TaskDetail.tsx`의 `task.status === "MergeWaiting"` 분기에서:

- readiness badge
- blockers
- changed files summary
- latest gate results
- command preview
- "merge approval 요청" button

### E. Worker Session Visibility 기술 설계

#### Event schema

P1에서는 기존 `run_events`를 재사용한다. `kind`, `message`, `payload_json` 구조가 이미 있으므로 새 table은 필요하지 않지만, `kind` CHECK는 당장 확장하지 않는다.

P0/P1에서 그대로 사용할 기존 kind:

- `status`
- `stdout`
- `stderr`
- `artifact`
- `approval`
- `system`
- `result`

현재 `run_events.kind` CHECK는 `tool_call`, `session`, `gate`, `repair`를 허용하지 않는다. P1 전까지는 아래 매핑을 사용한다.

| 원하는 의미 | 기존 kind | payload.type |
| --- | --- | --- |
| tool call | `system` | `tool_call.started/completed/failed` |
| session ready/message | `system` | `session.ready/message` |
| gate event | `result` | `gate.recorded` |
| repair event | `system` | `repair.created/updated` |

Worker Visibility milestone에서 새 kind를 직접 쓰고 싶으면 `run_events` table rebuild 또는 `run_event_details` 보조 table을 만든다.

권장 payload:

```json
{
  "schemaVersion": 1,
  "stream": "stdout",
  "preview": "bounded text",
  "bytes": 1200,
  "sequence": 42,
  "artifact": "stdout.log"
}
```

tool call payload:

```json
{
  "schemaVersion": 1,
  "toolName": "shell",
  "status": "started|completed|failed",
  "summary": "npm run typecheck",
  "startedAt": "...",
  "finishedAt": null,
  "raw": {}
}
```

#### Adapter normalization

`db.rs` runner adapter code에서 provider-specific events를 바로 UI로 내보내지 않는다.

권장 helper:

- `append_stdout_event`
- `append_stderr_event`
- `append_tool_call_event` 내부 kind는 당분간 `system`
- `append_session_event` 내부 kind는 당분간 `system`
- `append_artifact_event`

각 helper는 DB `run_events`와 Tauri `agent-run://event` emit을 같은 payload로 유지한다.

#### Storage policy

- full stdout/stderr는 artifact file이 canonical.
- DB event에는 bounded preview와 byte count만 저장.
- preview max: 4 KiB per event.
- event count가 많아질 경우 Task Detail은 최신 N개를 먼저 렌더링하고 "전체 로그 열기"로 artifact를 읽는다.

#### UI

`TaskDetail.tsx`:

- 현재 실행 panel
- stream tabs: stdout/stderr/events
- tool-call cards
- artifact event link
- session ready/running indicator

P1은 read-only observe만 제공한다. steering input은 P2로 둔다.

### F. Safe Editing 기술 설계

#### Helper 위치

Rust module 후보:

- `apps/desktop/src-tauri/src/safe_edit.rs`

기능:

- path가 project root 내부인지 확인
- symlink 거부
- max bytes
- UTF-8 확인
- expected hash precondition
- temp file write
- fsync 후 rename

path containment 규칙:

- 입력은 relative path만 받는다.
- `..`, absolute path, Windows drive prefix, NUL byte를 거부한다.
- `std::fs::canonicalize`는 파일이 아직 없으면 실패하므로 parent directory를 canonicalize하고 final path를 join한다.
- final parent가 project root canonical path 아래인지 확인한다.
- symlink는 parent component와 existing target 모두 검사한다.

API 후보:

```rust
pub struct SafeWriteInput {
    pub relative_path: String,
    pub expected_sha256: Option<String>,
    pub content: String,
    pub max_bytes: usize,
}

pub fn safe_write_text(root: &Path, input: SafeWriteInput) -> CommandResult<SafeWriteResult>
```

적용 대상:

1. planning draft markdown export
2. project settings JSON export/import
3. future workflow preset

처음부터 일반 파일 편집기로 열지 않는다.

Atomic write 순서:

1. validate path and size
2. read existing hash if file exists
3. compare expected hash
4. write `{filename}.tmp-{uuid}`
5. flush and fsync file
6. rename tmp to final path
7. best-effort fsync parent directory
8. return new sha256

### G. 테스트 전략

#### Rust unit tests

Planning:

- migration idempotent
- planning migration does not touch existing approvals CHECK
- create/list/get planning session
- append messages order
- draft version unique
- planning approval approve/reject
- materialize same draft twice is idempotent
- `planning_materializations.UNIQUE(draft_id)` prevents duplicate Task creation
- materialize draft creates task and relation
- draft artifact path validation

Lifecycle:

- queued -> status Running/lifecycle claimed -> starting -> running -> succeeded
- existing terminal runs backfill to `lifecycle_phase='completed'`
- launch failure sets failure_kind
- orphan running on open becomes NeedsInspection
- stale claimed becomes NeedsInspection
- retry preserves parent_run_id/attempt
- status CHECK still accepts all written statuses

Repair:

- blocking gate creates repair request
- existing resolved repair requests backfill to `phase='closed'`
- repair context includes blockers/affected files
- repair iteration limit blocks third auto run
- repair success queues gate rerun
- gate rerun pass closes repair request
- supervisor skips normal next-role queue while open repair exists

Merge:

- no worktree -> fail blocker
- open repair -> fail blocker
- required gates pass -> readiness pass
- merge readiness does not insert `gate_results.gate='merge_readiness'`
- command preview uses local branch/worktree
- merge approval stores basis without touching generic approvals CHECK

#### Frontend checks

- `npm run typecheck`
- PlanningScreen session reload smoke
- TaskDetail retry button visibility by failureKind
- MergeWaiting panel renders pass/fail blockers
- Run event stream renders stdout/tool/artifact rows

#### End-to-end fixture

최종 fixture는 아래 경로를 검증해야 한다.

```text
planning session
-> draft approval
-> materialize task
-> planner PlanApproval
-> coder
-> code review fail
-> repair run
-> code review rerun pass
-> tester pass
-> MergeWaiting
-> merge readiness pass
```

### H. 구현 리스크와 순서 제약

1. Planning DB를 먼저 해야 한다.
   - 이유: Task provenance와 approval basis가 planning artifact에 의존한다.

2. Run lifecycle metadata는 repair loop보다 먼저 해야 한다.
   - 이유: repair loop가 어떤 실패를 수리해야 하는지 failure_kind를 봐야 한다.

3. Repair loop는 merge readiness보다 먼저 해야 한다.
   - 이유: merge readiness의 핵심 blocker가 open repair request다.

4. Worker visibility는 P1로 미뤄도 되지만 event schema는 lifecycle 작업 때 같이 정해야 한다.
   - 이유: 나중에 schema를 바꾸면 run timeline migration이 어려워진다.

5. Automation mode는 UI label부터 정리한다.
   - `observe`는 내부 enum으로 남겨도 되지만 사용자 label은 `기록만` 또는 `record`로 고정한다.
   - `repair`는 supervisor reconciler 설정으로 분리한다.
   - `gate`는 Conductor AI 설정이다.

6. 기존 CHECK 제약은 기능 milestone 안에서 즉흥적으로 바꾸지 않는다.
   - 이유: SQLite table rebuild는 데이터 보존/foreign key/index 재생성이 필요해 위험하다.
   - 원칙: P0/P1은 보조 column/table로 우회하고, enum 통합은 별도 migration PR로 한다.

7. 새 command는 snapshot을 무조건 비대화하지 않는다.
   - Planning detail, run event stream, merge readiness는 lazy command로 읽는다.
   - 이유: `ProjectSnapshot`이 커지면 앱 시작/refresh가 느려진다.

## 구현 순서 추천

가장 먼저 할 일:

1. `docs/ai-plan-conversation-approval-feature.md`를 기준으로 Planning DB migration부터 구현한다.
2. 동시에 `agent_runs` lifecycle metadata를 설계만 확정한다.
3. Planning이 durable해지면 liveness-aware runner를 구현한다.
4. 그 다음 repair loop와 merge readiness를 붙인다.

이 순서가 좋은 이유:

- Planning이 durable하지 않으면 Task provenance가 계속 흔들린다.
- Run lifecycle이 약하면 repair loop가 실패 원인을 잘못 해석한다.
- Repair loop가 없으면 reviewer/tester chain이 사용자에게 부담만 준다.
- Merge readiness는 앞 단계의 gate/repair/evidence가 있어야 제대로 닫힌다.
