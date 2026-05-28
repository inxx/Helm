# Agent Orchestrator Reference Integration Goal

작성일: 2026-05-28

## 목적

`awesome-agent-orchestrators`에서 추린 레퍼런스(`swarm-protocol`, `gnap`, `wit`, `ORCH`, `bernstein`)와 추가 검토 대상 `orca`를 Helm에 붙일 만한 아이디어로 훑는 데서 끝내지 않는다. 각 프로젝트가 해결하는 운영 문제를 리버스 엔지니어링하듯 분해하고, Helm에서 완전히 동작한다고 말할 수 있는 종료 조건까지 구현 goal로 고정한다.

이 문서의 목표는 PoC가 아니다. 한 번 동작하는 데모가 아니라, Helm의 agent board가 실제 운영 중에도 상태를 정확히 설명하고, run을 복구 가능하게 만들며, 병렬 작업 충돌과 audit gap을 기술적으로 닫는 것이다.

Helm의 현재 핵심 문제는 다음 네 가지다.

- 실행 상태가 UI, DB, 실제 프로세스 사이에서 어긋날 수 있다.
- `Running`이 오래 유지될 때 사용자에게 필요한 것은 스피너가 아니라 `대기 중`, `승인 대기`, `실행 중`, `정체`, `점검 필요` 같은 명시 상태다.
- 여러 에이전트/런이 같은 파일 또는 같은 작업 범위를 건드릴 때 사전 충돌 감지가 약하다.
- 재시작, orphan, schema invalid, approval pending 같은 사건이 “왜 멈췄는지”를 한 번에 설명하는 복구 계약으로 충분히 정리되지 않았다.

## Source Snapshot

- `awesome-agent-orchestrators`: agent orchestrator 목록. `bernstein`, `gnap`, `ORCH`, `swarm-protocol`, `wit`이 각각 병렬 러너, swarm, coordination 영역에 포함되어 있다.
- `swarm-protocol`: MCP 기반 headless coordination layer. `claim_work`, `heartbeat`, `release_claim`, `complete_claim`, `check_conflicts`, `get_context` 같은 도구와 Intent/Claim/Signal/Context Package 원시 개념을 둔다.
- `gnap`: Git-native 프로토콜. 서버와 DB 없이 `agents.json`, `tasks/*.json`, `runs/*.json`, `messages/*.json` 네 엔티티를 git으로 동기화한다.
- `wit`: 파일이 아니라 symbol/function 단위 lock을 제공한다. Tree-sitter WASM, SQLite WAL, Unix socket JSON-RPC를 사용하고 TypeScript/JavaScript/Python을 우선 지원한다.
- `ORCH`: CLI/TUI 기반 agent team runtime. worktree isolation, state machine, retry, zombie detection, review gate를 강조한다.
- `bernstein`: audit-grade orchestration. HMAC chained audit log, signed agent cards, artefact lineage, deterministic scheduler 쪽이 핵심이다.
- `orca`: desktop/mobile fleet IDE. 여러 CLI agent를 repo/worktree별로 병렬 실행하고, terminals, source control, GitHub integration, remote SSH, notifications를 한 곳에서 다룬다.

## Source Links

- `awesome-agent-orchestrators`: https://github.com/andyrewlee/awesome-agent-orchestrators
- `swarm-protocol`: https://github.com/phuryn/swarm-protocol
- `gnap`: https://github.com/farol-team/gnap
- `wit`: https://github.com/amaar-mc/wit
- `ORCH`: https://github.com/oxgeneral/ORCH
- `bernstein`: https://github.com/sipyourdrink-ltd/bernstein
- `orca`: https://github.com/stablyai/orca

## 결론 요약

Helm에 직접 통합할 1차 goal은 `swarm-protocol`과 `gnap` 아이디어를 내부 모델로 흡수하는 것이다. `wit`은 병렬 코딩 충돌을 실제로 줄이는 단계까지 붙인다. `ORCH`와 `bernstein`은 전체 도입보다 상태 전이, audit, deterministic recovery 패턴을 Helm의 기존 lifecycle에 녹이는 편이 안전하다. `orca`는 orchestration protocol보다 제품 UX 레퍼런스다. Helm에는 worktree-native IDE 경험, multi-agent terminal visibility, source-control review, notifications, remote execution UX 기준으로 반영한다.

권장 goal 순서:

1. `swarm-protocol`식 Claim/Heartbeat 상태를 Helm DB의 existing run/task 위에 얇게 투영한다.
2. `gnap`식 파일 스냅샷을 `.helm/coordination/` 아래 복구 가능한 export로 만든다.
3. `wit`식 conflict detection은 file overlap에서 시작해 symbol 후보까지 확장한다.
4. `bernstein`식 audit chain은 `run_events`와 artifacts의 integrity check로 구현한다.
5. `ORCH`는 직접 붙이지 않고 Helm state machine gap checklist로만 사용한다.
6. `orca`는 agent board와 task detail의 UX completion 기준으로 사용한다.

## Goal Completion Contract

이 goal은 아래 조건이 모두 만족될 때만 완료로 본다.

- `host 실행` 후 UI에는 시스템 로딩바가 아니라 `실행 요청 중`, `대기 중`, `실행 중`, `승인 대기`, `정체 후보`, `점검 필요` 중 하나가 보인다.
- `Running` run은 이유 없이 무기한 남지 않는다. 오래 조용한 run, pending approval run, orphaned run, timed out run이 서로 다른 상태로 분류된다.
- pending approval이 발생하면 board card, detail next action, run history가 같은 의미의 상태를 보여준다.
- app restart 후 orphaned run은 자동으로 복구 가능한 상태가 되고, 사용자는 retry/inspect 중 무엇을 해야 하는지 UI에서 알 수 있다.
- `.helm/coordination/` export만으로 현재 agent/task/run 상태를 사람이 재구성할 수 있다.
- 병렬 run이 같은 파일 또는 같은 symbol 후보를 건드릴 때 host 실행 전에 conflict warning이 표시된다.
- run 종료 시 context/result/summary/diff의 hash가 기록되고, 사후 변경을 감지할 수 있다.
- 각 worktree의 terminal, diff, changed files, PR/issue references, attention-needed 상태가 task detail에서 한 번에 연결된다.
- agent가 끝났거나 승인을 요구할 때 사용자가 앱을 계속 보고 있지 않아도 알 수 있다.
- 기본 Helm 사용자는 외부 Postgres, Bun daemon, ORCH CLI, Bernstein runtime을 설치하지 않아도 기존 기능이 깨지지 않는다.
- build/typecheck가 통과하고, 최소 1개 실제 host run이 `Queued -> Running -> terminal` 경로로 종료된다. terminal은 `Succeeded`, `Failed`, `Canceled`, `TimedOut`, `NeedsInspection` 중 하나이며, 각 terminal status는 `lifecycle_phase`, `failure_kind`, `failure_reason`, result event, retry 가능 여부가 일관되게 표시된다.

## Helm Canonical Lifecycle Contract

이 goal에서 가장 먼저 고정해야 할 것은 persisted status와 UI 진단 상태를 섞지 않는 것이다. Helm의 현재 DB status는 이미 존재하므로, 새 단어를 `agent_runs.status`에 무리하게 넣지 않는다.

- `agent_runs.status`는 persisted state machine이다: `Queued -> Running -> Succeeded | Failed | Canceled | TimedOut | NeedsInspection`.
- `agent_runs.lifecycle_phase`는 설명 metadata다: `queued | running | completed | failed | canceled | blocked | orphaned`.
- `live_state`는 UI/export/read model 전용 derived state다. DB status로 저장하지 않는다.
- `live_state` 입력은 `status`, `lifecycle_phase`, `heartbeat_at`, latest significant event, pending RunApproval, in-memory process registry, `failure_kind`, `failure_reason`이다.
- `heartbeat_at`은 Helm이 마지막으로 관찰한 runner activity다. stdout/stderr/status/system/approval event로 갱신될 수 있으므로 OS process 생존 증명으로 단독 사용하지 않는다.

`live_state` 우선순위:

1. terminal `agent_runs.status`가 우선한다.
2. `NeedsInspection + lifecycle_phase='orphaned'`는 `orphaned_after_restart`로 설명한다.
3. `Running + Pending RunApproval`은 heartbeat age와 무관하게 `approval_pending`이다.
4. `Running + recent activity`는 `running`이다.
5. `Running + old activity`는 `quiet`이다.
6. `Running + very old activity`는 `stalled_candidate`다.
7. `Queued`는 `queued`다.

`quiet`와 `stalled_candidate`는 UI 진단이다. 별도 reconciler가 명시적으로 status를 바꾸기 전까지는 terminal 상태가 아니다.

## Spinner Ban UX Contract

Helm은 host run lifecycle에서 indefinite system spinner를 사용하지 않는다. 모든 async gap은 명시 상태와 다음 행동으로 표현한다.

| Moment | Label | Helper text | Primary action |
| --- | --- | --- | --- |
| Button clicked, command pending | 실행 요청 중 | 실행 요청을 저장하고 있습니다. | 없음 |
| Run row created, not claimed | 대기 중 | runner가 작업을 가져가길 기다립니다. | 취소 |
| Claimed, process not ready | 시작 중 | agent process를 준비하고 있습니다. | 취소 |
| Output/heartbeat active | 실행 중 | 마지막 신호: n초 전 | 로그 보기 |
| No recent output | 조용함 | 오래 걸리는 작업일 수 있습니다. 완료로 추정하지 않습니다. | 로그 보기 |
| Stale threshold passed | 정체 후보 | 최근 신호가 없어 점검이 필요할 수 있습니다. | 점검 |
| Pending approval | 승인 대기 | 사용자 승인이 필요해서 run이 멈췄습니다. | 승인 열기 |
| Approval decided, runner resuming | 재개 중 | 승인 결과를 반영하고 실행을 이어갑니다. | 로그 보기 |
| Restart orphan | 점검 필요 | 앱 재시작 후 process를 확인할 수 없습니다. | 재시도 / artifact 점검 |

RunApproval Pending은 `Running`의 부가 설명이 아니라 top-level attention state다.

- Board badge: `승인 대기`
- Board helper: `다음 진행을 위해 사용자 결정이 필요합니다.`
- Detail banner: `이 run은 승인 대기 중입니다. 승인 전에는 다음 단계로 진행하지 않습니다.`
- History event: `approval.created`, approval type, requested action, requester role, created time
- Notification title: `Helm 승인 필요`
- Notification body: `{task title} · {role} run이 승인을 기다립니다.`
- Deep link target: project id, task id, run id, approval id

### Approval Policy Boundary

Approval은 UI 상태가 아니라 side-effect safety boundary다.

명시 승인이 필요한 작업:

- dependency installation or update
- normal provider API 밖에서 runner가 수행하는 network call
- task worktree 밖 파일 쓰기
- git push, PR creation, branch deletion, merge, rebase, force operation
- remote execution
- credential or token configuration change
- destructive filesystem operation

Approval decision은 actor, timestamp, run id, requested action, normalized command/action summary, one-time/bounded-retry 적용 범위를 기록한다.

## Orphan And Stale Running Contract

Startup reconciliation은 DB에 `Running`으로 남은 run을 다음 상태로 전환할 수 있다: `status='NeedsInspection'`, `lifecycle_phase='orphaned'`, `failure_kind='orphaned_after_restart'`.

Runtime stale detection은 output이 조용하다는 이유만으로 run을 terminal 처리하지 않는다.

- `quiet`: Running, pending approval 없음, last activity가 quiet threshold보다 오래됨. UI-only.
- `stalled_candidate`: Running, pending approval 없음, last activity가 stalled threshold보다 오래됨. UI-only unless user chooses inspect/cancel.
- `timed_out`: Helm-owned process timeout이 실제로 만료됐을 때만 persisted status로 설정한다.
- `orphaned_after_restart`: startup reconciliation에서 DB는 Running인데 in-memory process registry가 비어 있을 때만 설정한다.
- reconciliation은 idempotent해야 하며 같은 run에 duplicate blocker/event를 쌓지 않는다.

Project-level `Running` run은 자동 queue claim을 막는다. 따라서 stale/orphan 처리는 장식이 아니라 queue unblock 계약이다. 모든 Running run에는 active process, pending approval, user-cancelable quiet/stalled, startup-reconciled NeedsInspection 중 하나의 owner path가 있어야 한다.

## Task And Run Gate Contract

Run completion은 task completion을 자동 의미하지 않는다. Task status는 role-specific gate를 통과할 때만 전진한다.

- planner pass -> PlanApproval Pending/Approved path
- coder pass -> PlanVerification
- verifier pass -> CodeReview
- reviewer pass -> Testing
- tester pass -> MergeWaiting
- schema invalid, diff mismatch, timeout, cancel, launch failure, approval rejection은 task status를 조용히 전진시키지 않는다.

## 1. swarm-protocol Reverse Engineering

### 무엇을 베낄 것인가

`swarm-protocol`은 작업을 티켓이 아니라 Intent로 보고, 실행자가 Claim을 잡고 heartbeat를 갱신하며, 완료/차단/충돌을 Signal로 남긴다. Helm에는 이미 `tasks`, `agent_runs`, `run_events`, `approvals`가 있으므로 새 orchestrator를 붙이기보다 다음 매핑을 실제 구현 단위로 삼는다.

- `Intent` -> Helm `tasks`
- `Claim` -> Helm `agent_runs` 중 `Queued`/`Running`
- `Heartbeat` -> `agent_runs.heartbeat_at`
- `Signal` -> `run_events`
- `Context Package` -> `.helm/artifacts/runs/{run_id}/context-pack.md`

### Helm에 넣을 구현 Goal

- `agent_run_claims` 테이블을 새로 만들지 말고, 우선 view/query helper로 구현한다. 이후 중복 query가 늘면 DB view 또는 derived field로 승격한다.
- `Running` run의 `heartbeat_at`, 최신 `run_events.created_at`, pending approval 여부를 조합해 `live_state`를 계산한다.
- UI에는 `Running` 하나만 보여주지 않고 `queued`, `running`, `approval_pending`, `quiet`, `stalled`, `orphaned`, `needs_inspection`으로 표시한다.
- host runner 시작 전에 예상 변경 파일 목록이 있으면 `check_conflicts` 성격의 내부 함수를 호출한다.
- `live_state`는 board/detail/history에서 같은 helper를 쓰게 만들어 상태 용어가 갈라지지 않게 한다.

### 기술 블로커

- Helm은 SQLite/local-first 구조인데 `swarm-protocol`은 PostgreSQL 단일 인스턴스를 전제로 한다. 외부 프로토콜을 그대로 붙이면 Helm의 per-project `.helm/helm.sqlite` 구조와 충돌한다.
- `swarm-protocol`의 conflict는 advisory이며 file lock을 강제하지 않는다. Helm에서 “충돌 없음”처럼 보여주면 위험하다.
- `claimed_by`가 trust-based identity라 Helm의 connected agents/role assignment와 보안 의미가 다르다.
- MCP polling 모델은 Helm의 Tauri event stream과 중복될 수 있다. 이중 polling이 생기면 UI가 다시 stale state에 취약해진다.
- heartbeat 주기가 10-15분이면 Helm의 짧은 로컬 run UX에는 너무 느리다. Helm은 5-30초 단위 liveness가 필요하다.

### 성공 기준

- `Running` stuck 상태가 UI에서 하나의 spinner가 아니라 원인별 상태로 분류된다.
- pending approval 발생 시 보드/상세에서 `승인 대기`가 즉시 보인다.
- 최신 run을 보고 “실제 진행 중인지, 승인 대기인지, 조용한 실행인지, orphan인지”를 DB query 하나로 판정할 수 있다.
- `host 실행` 버튼을 눌러도 시스템 로딩바는 나오지 않는다.
- stale run reconciliation을 여러 번 실행해도 같은 run에 중복 blocker/event가 쌓이지 않는다.

## 2. gnap Reverse Engineering

### 무엇을 베낄 것인가

`gnap`은 서버 없이 git을 transport와 audit log로 쓴다. 네 엔티티만 둔다: Agent, Task, Run, Message. Helm은 이미 DB가 있지만 재시작/배포/복구 상황에서는 DB 내부 상태만으로 사람이 읽기 어렵다.

Helm에는 `gnap`을 primary store로 쓰기보다 export/read model로 붙이는 게 적합하다.

- `agents.json` -> Helm settings의 AI connections/role assignments export
- `tasks/*.json` -> Helm task summary export
- `runs/*.json` -> Helm agent_runs export
- `messages/*.json` -> compacted semantic event export. stdout/stderr delta와 heartbeat-only tick은 제외한다.

### Helm에 넣을 구현 Goal

- `.helm/coordination/agents.json`
- `.helm/coordination/tasks/{task_id}.json`
- `.helm/coordination/runs/{run_id}.json`
- `.helm/coordination/messages/{event_id}.json`

초기 구현은 export-only로 둔다. import/sync는 하지 않는다. 단, export는 “나중에 쓸 수도 있는 파일”이 아니라 실제 복구 점검에 쓸 수 있을 만큼 deterministic해야 한다.

### GNAP Export Source-of-Truth Contract

Helm의 source of truth는 `.helm/helm.sqlite`, Helm-managed `.helm/artifacts`, 그리고 local Git working tree다. `.helm/coordination/`은 import/sync 대상이 아니라 export-only read model이다.

- DB row는 task/run/approval/event의 canonical state를 가진다.
- artifact file은 context/result/summary/diff/log의 canonical bytes를 가진다.
- Git은 실제 worktree diff와 commit state의 canonical source다.
- coordination JSON은 위 세 source에서 재생성 가능해야 하며, JSON 수정은 Helm 상태를 바꾸지 않는다.

coordination export에는 `manifest.json`을 둔다.

- `schemaVersion`
- `exportedAt`
- `projectId`
- `dbSchemaVersion`
- `sourceDbRelativePath`
- `files`
- `counts`
- `warnings`
- `exportContentHash`

복구/점검 시 manifest가 없거나 hash/count가 맞지 않으면 coordination export는 stale 또는 partial로 표시한다.

### Deterministic JSON Rules

Coordination export는 같은 source 상태에서 byte-for-byte stable해야 한다.

- UTF-8 JSON만 쓴다.
- object key order는 exporter가 고정한다.
- arrays는 stable key로 정렬한다: tasks by `id`, runs by `createdAt,id`, messages by `runId,seq,id`.
- volatile generated time은 `manifest.exportedAt`에만 둔다.
- per-entity JSON에는 export 실행 시각을 넣지 않는다.
- optional 값은 `null` 또는 omitted 중 하나로 통일한다.
- 파일 끝에는 single trailing newline을 둔다.
- pretty print indent는 2 spaces로 고정한다.
- export는 `.tmp` 파일에 쓴 뒤 atomic rename한다.
- 이전 export에만 존재하는 entity file은 manifest 기준으로 stale 처리하거나 exporter가 삭제 정책을 명시한다.

### Export Event Compaction Policy

`run_events` 전체를 GNAP message로 내보내지 않는다. Export 대상은 board/recovery에 필요한 semantic event로 제한한다.

Export 포함:

- status transition
- approval requested/decided
- result recorded
- artifact created/finalized
- needs-inspection/timed-out/orphaned/stalled system signal
- conflict warning acknowledgement

Export 제외:

- stdout delta
- stderr delta
- heartbeat-only tick
- high-frequency progress tick
- raw terminal scrollback

기존 `run_events.kind` CHECK를 확장하지 않는 동안 새 의미는 기존 kind와 `payload.type`으로 표현한다. 예: `kind='system'`, `payload.type='conflict_hint.created'`.

### 기술 블로커

- DB와 git JSON 사이에 source-of-truth가 둘이 되면 반드시 drift가 생긴다. 1차 구현은 export-only여야 한다.
- run event는 매우 잦다. 모든 stdout delta를 JSON message로 쓰면 git churn이 커진다.
- git commit을 자동으로 만들지 않으면 audit trail은 반쪽이다. 반대로 자동 commit을 만들면 사용자의 작업 트리와 충돌한다.
- Helm의 `.helm/artifacts`는 대용량 로그/patch를 포함한다. gnap식 lightweight JSON과 artifact 파일의 경계를 명확히 해야 한다.
- offline sync는 매력적이지만 Helm이 local desktop app인 이상 multi-device sync를 설계하지 않으면 기능처럼 보여도 실제 복구 가치는 제한된다.
- SQLite transaction과 filesystem write는 하나의 atomic transaction이 아니다. partial export는 manifest/hash로 감지해야 한다.

### 성공 기준

- 앱을 열지 않아도 `.helm/coordination/` 파일만 보고 현재 task/run 상태를 이해할 수 있다.
- Helm DB를 백업/복구할 때 export JSON이 sanity check 자료로 쓰인다.
- `run_events` 전체가 아니라 중요한 상태 전이만 export되어 git diff가 읽을 만하다.
- 같은 DB 상태에서 export를 두 번 실행해도 파일 내용 순서와 포맷이 안정적이다.
- export 실패는 UI 전체 실패가 아니라 warning event로 남는다.

## 3. wit Reverse Engineering

### 무엇을 베낄 것인가

`wit`의 핵심은 file lock이 아니라 symbol lock이다. 같은 파일이라도 다른 함수면 병렬 작업을 허용하고, 같은 함수나 caller chain이면 경고한다. Helm의 현재 worktree isolation은 branch 차원 충돌은 줄이지만, 나중에 merge할 때 같은 파일 내부 충돌은 막지 못한다.

### Helm에 넣을 구현 Goal

외부 `wit` daemon을 바로 필수 의존성으로 넣지 않는다. 먼저 Helm 내부 conflict warning을 완성하고, 그 다음 optional adapter로 확장한다.

- Context Pack 생성 시 “예상 touched files”를 계산한다.
- TypeScript/JavaScript 파일에 한해 changed region 또는 task description에서 symbol 후보를 뽑는다.
- `agent_run_symbol_claims` 같은 테이블은 바로 만들지 않고 `run_events.kind='system'`, `payload.type='conflict_hint.created'` 이벤트로 남긴다. 경고가 유용하다고 확인되면 테이블로 승격한다.
- `wit` CLI가 설치되어 있으면 optional adapter로 `wit status --json`, `wit declare`, `wit lock`을 호출한다.

Conflict check는 advisory다. pre-run warning에는 evidence source를 반드시 표시한다.

- `planned_files`
- `existing_worktree_diff`
- `context_pack_mentions`
- `declared_symbol_claims`
- `wit_adapter`

경고가 없다는 사실을 `conflict-free`로 표현하지 않는다.

### 기술 블로커

- Helm은 Rust/Tauri 앱이고 `wit`은 Bun daemon + Unix socket + SQLite WAL 구조다. 런타임 의존성이 추가된다.
- 지원 언어가 TS/JS/Python 위주라 Rust, Go, Java, CSS, MDX 등은 빠진다.
- symbol lock은 정확한 AST 파싱에 의존한다. generated file, barrel export, dynamic imports에서는 “안전하다”는 판단을 과신하기 쉽다.
- conflict가 warning이면 UI 문구도 warning이어야 한다. lock이라고 부르면 사용자가 강제 보호로 오해할 수 있다.
- daemon lifecycle을 Helm이 관리할지, 사용자가 별도 설치할지 결정해야 한다.

### 성공 기준

- 두 run이 같은 파일을 건드려도 다른 symbol이면 단순 file conflict보다 덜 시끄럽게 보인다.
- 같은 symbol 후보가 겹치면 host 실행 전 “충돌 가능성” 경고가 뜬다.
- `wit` 미설치 환경에서도 Helm 기본 실행이 깨지지 않는다.
- conflict warning은 실행을 막지 않되, 사용자가 무시했는지 events에 남긴다.
- TypeScript/JavaScript가 아닌 파일은 “symbol 미지원”으로 분류되고 file-level warning으로 fallback한다.

## 4. ORCH Reverse Engineering

### 무엇을 베낄 것인가

`ORCH`는 Helm과 가장 많이 겹친다. agent team, worktree isolation, state machine, retry, zombie detection, review gate가 모두 Helm의 방향과 유사하다. 그래서 직접 통합은 위험하고, 체크리스트로 역수입하는 편이 맞다.

Helm이 참고할 요소:

- state transition validation
- stalled/zombie run detection
- retry attempt/backoff
- mandatory review gate
- structured JSON logs
- headless `serve --once` 같은 검증 모드

### Helm에 넣을 구현 Goal

- `reconcile_interrupted_runs`를 확장해 stale running 판정을 더 명시적으로 만든다.
- `agent_runs.attempt`를 UI에 노출하고 retry reason을 구조화한다.
- `run_events`에 `orchestrator:tick` 성격의 system event를 남기되, stdout처럼 과다 기록하지 않는다.
- “현재 실행” 카드에서 `Running`만 보여주지 않고 `Running / approval pending / stalled candidate / quiet`을 분리한다.

### 기술 블로커

- ORCH는 자체 CLI runtime이다. Helm에 직접 붙이면 두 orchestrator가 같은 worktree와 task lifecycle을 동시에 소유하게 된다.
- ORCH의 state machine 이름과 Helm의 `Planned -> Ready -> Coding -> PlanVerification -> CodeReview -> Testing -> MergeWaiting` 흐름이 다르다.
- zombie detection이 과격하면 긴 생각/긴 테스트 run을 실패로 오판할 수 있다.
- ORCH식 “자동 retry”는 Helm의 approval-first UX와 충돌할 수 있다.
- structured logs를 추가해도 retention/compaction 정책이 없으면 `.helm`이 빠르게 커진다.

### 성공 기준

- stale `Running`이 무한히 남지 않고 `quiet`, `approval_pending`, `timed_out`, `orphaned_after_restart`로 분류된다.
- retry attempt와 원인이 상세 패널에서 한눈에 보인다.
- 사용자가 “왜 다음 단계로 안 갔는지”를 events를 열지 않고도 이해한다.
- 자동 retry는 명시 정책이 있을 때만 발생하며, manual approval UX를 우회하지 않는다.
- 긴 run은 바로 실패 처리되지 않고 `quiet` -> `stalled candidate` -> `TimedOut/NeedsInspection`으로 단계가 나뉜다.

## 5. bernstein Reverse Engineering

### 무엇을 베낄 것인가

`bernstein`은 compliance/audit 쪽이 강하다. Helm에 필요한 것은 전체 orchestrator가 아니라 audit chain과 artifact lineage다.

Helm 적용 아이디어:

- `run_events`에 이전 이벤트 hash를 연결하는 optional audit chain
- `structured-result.json`, `summary.md`, `diff.patch`, `changed-files.json`의 SHA-256 저장
- run completion 시 “이 result가 어떤 context-pack에서 왔는지” lineage 기록
- approval decision에도 hash를 연결해 사후 변조 감지

### Helm에 넣을 구현 Goal

- P0는 terminal `result/system` event payload에 artifact hash metadata를 넣는다. `previousEventHash`는 event append가 transaction-safe하고 chain start metadata가 생긴 뒤 활성화한다.
- completion/needs-inspection/timed-out 이벤트에만 hash를 붙인다.
- UI에는 노출하지 않고, artifact viewer에서 debug metadata로만 확인한다.

### Artifact Hash Contract

Hash는 artifact file bytes의 SHA-256이다. Symlink artifact, path traversal, absolute path는 기존 artifact reader와 동일하게 거부한다.

Hash 대상 P0:

- `context-pack.md`
- `context-pack.json`
- `structured-result.json`
- `summary.md`
- `diff.patch`
- `changed-files.json`

Completion event payload에는 아래를 기록한다.

- `hashAlgorithm: "sha256"`
- `hashScope: "file-bytes"`
- `artifactHashes[{ name, relativePath, sha256, sizeBytes }]`
- `hashRecordedAt`
- `hashChainStartedAt` 또는 `chainVersion`

Run이 terminal state에 들어간 뒤 Helm-managed artifact는 기본적으로 immutable로 취급한다. 후속 수정이 필요하면 기존 파일을 덮어쓰지 않고 새 artifact 또는 repair run으로 남긴다. 기존 파일 변경은 integrity warning으로 표시하되 run status를 자동 실패로 바꾸지 않는다.

### Integrity Hash Scope

초기 hash는 local debugging용 tamper-evidence이지 compliance-grade audit이 아니다.

- stable JSON key ordering
- UTF-8 bytes
- explicit hash algorithm, initially SHA-256
- recorded schema version
- recorded chain start event id

Phase 5는 newly appended terminal/approval event에만 `previousEventHash`를 기록한다. 기존 이벤트는 backfill하지 않는다. canonicalization이 실패하면 Helm은 integrity warning을 남기고 run lifecycle은 계속 진행한다.

### 기술 블로커

- 기존 `run_events`에 과거 이벤트가 많아 retroactive chain을 만들 수 없다. 특정 시점 이후부터만 chain이 유효하다.
- SQLite row update가 가능한 구조에서는 “append-only audit”이라고 말하기 어렵다. 무결성 보장은 별도 export 또는 signed log 없이는 제한적이다.
- artifact 파일이 나중에 다시 쓰이는 현재 흐름이 있으면 hash mismatch가 잦아질 수 있다.
- HMAC key를 어디에 저장할지 결정해야 한다. repo 안에 두면 보안 의미가 약하고, OS keychain은 구현 범위가 커진다.
- compliance UX를 과하게 넣으면 개인용 desktop tool의 속도가 떨어진다.

### 성공 기준

- run 종료 후 context/result/summary/diff의 hash가 기록된다.
- 파일이 사후 변경되면 debug check에서 mismatch를 감지한다.
- 이 기능이 실패해도 run 자체는 실패시키지 않는다.
- hash mismatch는 blocking gate가 아니라 integrity warning으로 시작한다.
- 어느 시점부터 chain이 시작됐는지 metadata에 기록되어 과거 이벤트와 혼동되지 않는다.

## 6. orca Reverse Engineering

### 무엇을 베낄 것인가

`orca`는 protocol-first orchestrator라기보다 fleet IDE다. README 기준으로 Claude Code, Codex, Grok, Antigravity, OpenCode 같은 CLI agents를 side-by-side로 실행하고, 각 작업을 worktree로 분리하며, terminals, source control, GitHub integration, SSH, notifications, mobile companion을 제공한다. Helm은 이미 Tauri desktop board와 task detail을 갖고 있으므로 Orca를 통째로 도입할 이유는 없다. 대신 “사용자가 여러 agent run을 실제로 운영할 때 필요한 시야”를 가져온다.

Helm에 맞는 핵심 매핑:

- Orca worktree-native UX -> Helm `task_worktrees`와 Git 탭 연결 강화
- Multi-agent terminals -> Helm run history와 terminal/artifact viewer 통합
- Built-in source control -> Helm Git tab + task detail changed files/diff action
- GitHub integration -> Helm external refs, PR/issue references, CI status 확장
- SSH support -> Helm remote runner/remote workspace future goal
- Notifications -> approval pending, run completed, run stalled, needs inspection 알림
- Mobile companion -> 지금 당장 앱을 새로 만들기보다 notification contract와 deep link부터 준비

### Orca Lessons To Borrow And Not Borrow

Borrow:

- Worktree-first operation view: 각 task/run은 worktree, terminal, diff, source control, external refs를 함께 보여줘야 한다.
- Active-at-a-glance status: 모든 run row에는 짧은 상태, last activity time, attention marker가 있어야 한다.
- Unread/attention model: completion, approval pending, stalled, needs inspection, failed notification delivery는 사용자가 돌아왔을 때도 남아 있어야 한다.
- Agent progress comment: 가능하면 raw terminal output과 별도로 현재 작업/막힘 요약을 저장한다.

Do not borrow blindly:

- terminal activity를 progress 또는 completion 증거로 보지 않는다.
- generic CLI support가 Helm structured-result contract를 우회하게 하지 않는다.
- local runner state가 명확해지기 전에는 remote/mobile controls를 노출하지 않는다.

### Helm에 넣을 구현 Goal

- Task detail에서 현재 run의 terminal/stdout/stderr/artifacts/diff/context가 한 화면 흐름으로 이어져야 한다.
- Board card는 “active at a glance” 원칙을 따른다. `Running`이라는 단어만 보여주지 않고 `승인 대기`, `실행 중`, `정체 후보`, `완료`, `점검 필요`를 시각적으로 구분한다.
- Git tab과 task detail 사이에 같은 changed files/diff 정보를 중복 구현하지 말고 같은 artifact reader/helper를 쓴다.
- external refs는 단순 문자열이 아니라 `GitHub issue`, `PR`, `Actions check`, `plain URL`, `planning draft`처럼 타입별 표시를 준비한다.
- notification은 OS notification부터 시작한다. Mobile companion은 이후 목표로 미루되, 알림 payload에는 task/run deep link에 필요한 ID를 넣는다.
- remote execution은 바로 만들지 않는다. 대신 runner connection 설정에 `local`, `ssh`, `app-server`, `process` 같은 execution location을 표현할 수 있게 모델을 열어둔다. 이 goal에서는 `executionLocation: "local"`만 valid runtime configuration이다. 다른 값은 reserved design note 또는 internal type comment로만 둔다.

### 기술 블로커

- Orca는 Electron/TypeScript 제품이고 Helm은 Tauri/Rust/React다. UI 구조나 terminal 구현을 직접 가져오기는 어렵다.
- Orca는 “IDE”에 가까운 surface area를 가진다. Helm이 모든 기능을 따라가면 task orchestration core가 흐려질 수 있다.
- mobile companion은 push notification, auth, device pairing, deep link, background refresh가 필요하다. 단순 웹뷰로는 production UX가 나오기 어렵다.
- SSH support는 credentials, host key verification, remote path mapping, remote git worktree lifecycle을 모두 건드린다.
- GitHub integration은 token scope, rate limit, private repo permission, CI polling/backoff가 blocker가 된다.
- terminal panes를 늘리면 Tauri webview 성능, PTY lifecycle, log retention, focus/keyboard UX가 같이 어려워진다.
- Orca식 “any CLI agent” 지원은 매력적이지만 Helm의 structured-result contract와 충돌한다. 아무 CLI나 실행하면 Helm gate가 읽을 artifact를 남긴다는 보장이 없다.
- notification이 과하면 noisy product가 된다. attention-needed 상태만 알리고 stdout delta는 알림 대상에서 제외해야 한다.

### Notification Privacy Contract

Notifications must be state-only by default.

- 포함 가능: task id, run id, status, deep link.
- 기본 금지: stdout/stderr, diff content, secret-looking values, approval command body, remote hostname, private repository URL.
- expanded notification은 사용자가 명시적으로 켰을 때만 허용한다.

### Generic CLI Runner Contract

Generic CLI support는 adapter support이지 arbitrary shell execution이 아니다.

Generic CLI agent는 아래를 선언해야 한다.

- executable path 또는 known adapter id
- fixed argument template
- allowed working directory
- allowed environment variable names
- expected artifact paths
- structured-result schema version
- timeout and cancellation behavior

Helm은 runner definition으로 free-form shell string을 받지 않는다. adapter가 `structured-result.json`을 만들 수 없으면 run은 `Succeeded`가 아니라 `NeedsInspection`으로 종료한다.

### Remote Runner Security Gate

Remote execution은 credentials, host trust, path mapping, auditability 설계가 끝나기 전까지 구현 범위 밖이다.

`ssh` 또는 `app-server` execution을 구현하기 전 최소 조건:

- project file이나 `.helm/coordination/`에 password를 저장하지 않는다.
- SSH는 OS-managed key 또는 사용자가 명시 선택한 key path만 사용한다.
- host key verification은 필수다. unknown/changed host key는 사용자 승인 전 실행을 막는다.
- remote workspace path는 runner connection별 allowlist를 둔다.
- remote command는 declared workspace root에서만 실행한다.
- remote output과 artifact hash는 local run id에 묶어 기록한다.
- remote runner는 opt-in이며 local-only 사용자에게 노출하지 않는다.

### 성공 기준

- 사용자는 task detail 하나에서 run output, result, summary, changed files, diff, context를 순서대로 확인할 수 있다.
- `Running` run이 여러 개 있을 때 board에서 어떤 run이 attention을 요구하는지 3초 안에 구분된다.
- RunApproval Pending, NeedsInspection, Succeeded, TimedOut, Orphaned 상태는 OS notification 또는 in-app unread state로 남는다.
- 외부 ref가 GitHub PR/issue이면 task card와 detail에서 링크 타입이 구분된다.
- SSH/remote runner가 없더라도 local runner UX가 더 복잡해지지 않는다.
- generic CLI runner를 추가해도 Helm gate는 structured-result contract를 요구하고, 미충족 시 `NeedsInspection`으로 닫힌다.

### Optional Dependency Rules

Optional adapters는 명시 설정 전까지 disabled by default다.

Helm이 external tool을 감지하면 아래를 기록한다.

- executable path
- version output
- adapter name
- whether the user enabled it
- last successful health check

Helm은 이 goal의 일부로 third-party daemon을 auto-install, auto-upgrade, auto-start하지 않는다.

## Implementation Goal Plan

### Phase 1: live state mapper

대상:

- `apps/desktop/src-tauri/src/db.rs`
- `apps/desktop/src/lib/types.ts`
- `apps/desktop/src/components/TaskDetail.tsx`
- `apps/desktop/src/components/TaskBoard.tsx`

작업:

- `AgentRunSummary`에 pending approval, latest significant event, failure reason, lifecycle phase가 충분히 들어오지 않으면 board/detail/history가 갈라진다. 따라서 P0는 backend read model 또는 `list_task_run_activity` query로 입력을 보강한다.
- 단일 `deriveRunLiveState` helper를 만들고 board/detail/history가 같은 결과를 사용한다.
- 입력은 `status`, `lifecyclePhase`, `heartbeatAt`, `updatedAt`, latest event kind/message, pending approval 여부, in-memory process registry 신호다.
- 출력 후보는 `queued`, `starting`, `running`, `approval_pending`, `quiet`, `stalled`, `done`, `needs_inspection`.

검증:

- pending approval run이 spinner가 아니라 `승인 대기`로 보인다.
- stdout이 계속 쌓이면 `실행 중`으로 보인다.
- 최신 이벤트가 오래 없으면 `조용함` 또는 `정체 후보`로 보인다.
- board/detail/history가 같은 run을 서로 다른 상태로 표현하지 않는다.

완료 조건:

- 실제 `host 실행`을 눌러 `Queued -> Running -> approval_pending -> Running -> terminal status` 흐름을 확인한다.
- `approval_pending` 동안 시스템 로딩바가 나오지 않는다.

### Phase 2: swarm-style approval and claim signals

대상:

- `TaskDetail.tsx`
- `TaskBoard.tsx`
- `db.rs` event append path

작업:

- RunApproval Pending 발생 시 `run_events` 외에도 task card activeRun hint가 `승인 대기`를 우선 표시하게 한다.
- `host 실행` 버튼 클릭 직후는 `실행 요청 중...` 텍스트만 표시한다.
- `Queued`와 `Running`을 명확히 나눈다.

검증:

- host 실행 클릭 후 시스템 로딩바가 나오지 않는다.
- approval pending이면 board/card/detail에서 같은 의미로 보인다.

완료 조건:

- RunApproval Pending이 생긴 시점부터 2초 안에 board/detail 상태가 갱신된다.
- approval 승인 후 run이 다시 stdout/system events를 받는다.

### Phase 3: gnap export

대상:

- `apps/desktop/src-tauri/src/db.rs`
- `.helm/coordination/`

작업:

- `export_coordination_snapshot(project_id)` command 또는 내부 helper를 만든다.
- export는 Rust backend command에서 수행한다. Frontend는 raw DB row를 조합해 export JSON을 만들지 않는다.
- DB read는 하나의 consistent read transaction에서 수행한다.
- filesystem write는 DB transaction 안에 오래 묶지 않는다.
- task/run/message summary JSON을 export한다.
- `manifest.json`을 생성하고 counts/hash/warnings를 기록한다.
- stdout delta는 export하지 않는다. `status`, `approval`, `result`, `system` 중 의미 있는 이벤트만 message로 쓴다.
- 큰 artifact bytes는 coordination JSON에 inline하지 않고 relative path/hash만 기록한다.

검증:

- `.helm/coordination/tasks/*.json`과 `runs/*.json`만 보고 board 상태를 재구성할 수 있다.
- manifest가 없거나 hash/count가 맞지 않으면 stale/partial export로 표시된다.
- export가 실패해도 Helm UI는 실패하지 않는다.

완료 조건:

- export 파일이 deterministic format으로 생성된다.
- 앱 재시작 후 export를 다시 실행해도 내용이 불필요하게 흔들리지 않는다.

### Phase 4: wit-style conflict hints

대상:

- context pack generation path
- run preparation UI

작업:

- 예상 파일 목록은 context manifest, task metadata, existing worktree diff, explicit agent declaration 중 하나에서 얻는다.
- 현재 scheduler가 project-serial이면 conflict hint의 1차 가치는 “future parallelism 준비”다. true parallel run을 열기 전 per-project/per-task/per-worktree 동시성 정책을 먼저 결정한다.
- 예상 파일 목록이 있는 경우 active running/queued runs의 artifact/context와 비교한다.
- 같은 파일이면 `conflict_hint` event를 남긴다.
- TS/JS 파일은 symbol 후보 추출을 붙인다. symbol 추출이 실패하면 file overlap으로 fallback한다. UI 문구는 `symbol 후보`로 제한한다.

검증:

- 같은 파일을 건드릴 가능성이 있는 두 run이 있으면 warning이 뜬다.
- warning은 실행을 막지 않는다.

완료 조건:

- 충돌 가능성이 있는 run에서 host 실행 전 warning을 볼 수 있다.
- warning을 무시하고 실행해도 그 선택이 event로 남는다.

### Phase 5: audit hash chain

대상:

- run finish path
- artifact reader path

작업:

- 종료 이벤트 payload에 `artifactHashes`를 추가한다.
- 기존 이벤트를 migrate하지 않는다.
- debug artifact view에서 hash mismatch를 표시할 수 있는 helper만 둔다.

검증:

- 정상 run 종료 후 artifact hash가 payload에 남는다.
- artifact를 수정하면 helper가 mismatch를 감지한다.

완료 조건:

- 최소 1개 정상 종료 run에서 artifact hash가 기록된다.
- artifact를 임의 수정하면 debug check가 mismatch를 표시한다.
- hash 기록 실패가 run 성공/실패 판정을 왜곡하지 않는다.

### Phase 6: Orca-style operations UX

대상:

- `apps/desktop/src/components/TaskBoard.tsx`
- `apps/desktop/src/components/TaskDetail.tsx`
- `apps/desktop/src/screens/GitScreen.tsx`
- `apps/desktop/src-tauri/src/main.rs`
- `apps/desktop/src-tauri/src/db.rs`

작업:

- Task detail의 run section을 terminal/output/result/diff/context 순서로 재정렬한다.
- run attention state를 `approval_pending`, `needs_inspection`, `stalled`, `completed`, `unread`로 계산한다.
- OS notification command를 추가하되 stdout delta에는 알리지 않는다.
- external refs에 GitHub PR/issue/check 타입을 추가할 수 있게 표시 계층을 정리한다.
- runner connection model에 future `executionLocation` 필드를 설계한다. 구현은 local-only로 유지하며 non-local config는 dispatch/import 단계에서 거부한다.

검증:

- host run이 approval pending으로 멈추면 app이 foreground가 아니어도 알림 또는 unread state가 남는다.
- task detail에서 diff와 changed files를 열 때 Git 탭과 같은 데이터를 본다.
- notification permission이 없거나 실패해도 run lifecycle은 실패하지 않는다.

완료 조건:

- 사용자가 앱을 계속 지켜보지 않아도 attention-needed run을 놓치지 않는다.
- generic CLI/agent 지원이 늘어나도 structured-result contract가 Helm gate의 최종 기준으로 유지된다.
- local-only 사용자는 remote/mobile 관련 미구현 기능을 보지 않아도 된다.

## 구현 우선순위

1. UI live state: 가장 즉시 체감된다. 현재 “시스템 로딩바” 문제도 여기서 닫힌다.
2. approval pending 우선 표시: 실제로 host run이 멈추는 주요 원인이다.
3. gnap export: 복구성과 디버깅이 좋아진다.
4. conflict hint: 병렬성이 늘 때 필요하다.
5. Orca-style operations UX: 여러 run을 실제로 돌릴 때 사용자가 놓치는 상태를 줄인다.
6. audit hash: 품질은 높지만 UX 즉효성은 낮다.

## 이번 Goal에서 하지 말 것

- 외부 PostgreSQL 기반 `swarm-protocol` 서버를 필수 dependency로 넣지 않는다.
- GNAP JSON을 source-of-truth로 삼지 않는다.
- Wit daemon을 앱 시작 시 자동 설치/실행하지 않는다.
- ORCH를 Helm runner로 중첩 실행하지 않는다.
- Bernstein식 HMAC key management를 바로 구현하지 않는다.
- Orca식 mobile companion이나 SSH remote runner를 첫 구현 범위에 넣지 않는다.
- “any CLI agent”를 구조화된 Helm runner로 오해하지 않는다. structured-result contract는 유지한다.

## Blocker Register

| Blocker | 영향 | 완화책 |
| --- | --- | --- |
| DB와 export JSON drift | 잘못된 상태 표시 | export-only, import 금지 |
| Pending approval이 Running처럼 보임 | 사용자가 로딩으로 오해 | `approval_pending` liveState 최우선 |
| stdout delta 과다 이벤트 | UI/DB 부하 | event compaction 또는 중요 이벤트 중심 export |
| stale Running 오판 | 긴 작업을 실패 처리 | timeout과 quiet/stalled candidate 분리 |
| 외부 daemon 의존성 | 설치/배포 복잡도 증가 | optional adapter로 시작 |
| advisory conflict 오해 | 사용자가 충돌 방지로 과신 | UI 문구를 “충돌 가능성”으로 제한 |
| audit hash mismatch noise | 정상 재작성도 경고 | finish 이후 artifact immutable 규칙 정리 후 활성화 |
| app restart orphan 증가 | 사용자가 실패로 오해 | orphan reason과 retry action을 명확히 표시 |
| notification fatigue | 사용자가 알림을 꺼버림 | approval/completion/failure/stalled만 알림 |
| generic CLI output mismatch | Helm gate가 읽을 artifact가 없음 | structured-result 미충족 시 NeedsInspection |
| remote runner scope creep | SSH/auth/path mapping까지 폭발 | local-only 유지, executionLocation은 설계만 |
| board/detail state drift | 같은 run이 화면마다 다르게 보임 | backend read model 또는 `list_task_run_activity`로 liveState 입력 통합 |
| partial coordination export | stale JSON을 정상 snapshot으로 오해 | manifest/hash/count, temp file + atomic rename |
| approval policy ambiguity | 위험 작업이 승인 없이 재시도됨 | approval decision에 actor/action/scope/retry boundary 기록 |
| notification privacy leak | 민감한 stdout/diff가 알림에 노출 | state-only payload, expanded notification opt-in |
| free-form runner command | arbitrary shell 실행으로 안전 경계 붕괴 | fixed adapter contract, allowed env/cwd/template만 허용 |

## Recommendation

바로 구현할 첫 태스크는 `liveState`다. `swarm-protocol`의 Claim/Heartbeat 모델을 Helm 내부 run 상태 위에 얹으면, 외부 시스템 없이도 현재 UX 문제를 가장 작게 고칠 수 있다. 그 다음 `gnap` export를 붙이면 디버깅과 복구력이 올라간다. `orca`는 여러 run을 실제로 운영하는 화면 경험과 attention model의 기준으로 삼는다. `wit`, `ORCH`, `bernstein`은 각각 conflict precision, state-machine discipline, audit integrity의 레퍼런스로 두고 작은 조각만 가져오는 것이 맞다.
