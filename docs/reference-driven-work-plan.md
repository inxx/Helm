# Helm Reference-Driven Work Plan

작성일: 2026-05-25
상태: Draft

## 목적

이 문서는 Harnss, Multica, Hive, AIF Handoff, AI Factory, Envoy, Hermes Desktop에서 확인한 패턴을 Helm의 실제 작업 계획으로 묶는다.

핵심 목표는 하나다.

```text
사용자가 계획을 승인하면 Helm이 테스트 완료까지 진행 상황을 믿을 수 있게 보여주고,
막히면 왜 막혔는지와 다음 복구 행동을 Task 안에서 설명한다.
```

Helm의 source of truth는 계속 Helm backend와 repo-local `.helm` 데이터다. 외부 레퍼런스에서 가져올 것은 코드가 아니라 제품 모델, 상태 계약, 복구 UX, 검증 전략이다.

레퍼런스에서 가져올 제품/운영 패턴과 기술 blocker 제거 순서는 [Reference Product Quality Upgrade Plan](reference-product-quality-upgrade-plan.md)를 기준으로 한다.

## 참고 레퍼런스

- Harnss: multi-engine session, rich tool visualization, plan mode/permission control, background task agents.
  - https://github.com/OpenSource03/harnss
- Multica: agents as teammates, issue assignment, lifecycle management, blockers/status updates, reusable skills, runtime dashboard.
  - https://github.com/multica-ai/multica
- Hive: real PTY orchestrator/workers, shared markdown task graph, explicit report-based completion, local-first safety model, worker stop/restart UX.
  - https://github.com/tt-a1i/hive
- AIF Handoff: staged handoff, heartbeat/stale stage watchdog, manual handoff.
  - https://github.com/lee-to/aif-handoff
- AI Factory: plan/implement/verify 흐름과 agent work breakdown.
  - https://github.com/lee-to/ai-factory
- Envoy: shared context, authority/provenance model.
  - https://github.com/statecraft-protocol/envoy
- Hermes Desktop: direct source-of-truth, local API/diagnostics, safe file editing.

## 현재 기준선

이미 반영된 기준:

- Task 카드 클릭은 read-only selection이다. 클릭만으로 worktree/run/context가 생기지 않는다.
- Plan Document 승인 후 자동 진행은 backend queue/supervisor 책임이다.
- Task board와 Task detail은 active run 상태를 표시한다.
- 조용한 실행은 완료로 추정하지 않는다. `structured-result.json` 또는 명시 report를 기준으로 다음 상태로 이동한다.
- planner UI 지연은 hard failure가 아니라 soft notice로 처리한다.
- UI 문구 변경 계획은 Plan Document에 `Proposed Copy`를 보여준다.

남은 핵심 문제:

- blocker가 아직 timeline의 1급 객체로 충분히 보이지 않는다.
- `.helm` 안에 사람이 읽을 수 있는 task graph가 없다.
- planning 단계의 기본 산출물이 아직 executable task graph/task card/ownership/barrier/gate로 고정되어 있지 않다.
- run lifecycle이 backend 데이터 모델에서는 아직 `Queued/Running/Succeeded/...` 중심이라 claim, heartbeat, stale reason이 약하다.
- 실행 evidence가 raw artifact 중심이라 Harnss식 카드화가 부족하다.
- repair loop가 targeted blocker repair로 닫히지 않았다.
- runtime/CLI readiness가 설정 화면 안에 묻혀 있어 실행 전 실패를 예측하기 어렵다.

## 제품 원칙

1. **Task가 중심이다.**
   - run, approval, gate, blocker, repair는 모두 Task의 lifecycle event다.

2. **완료는 추정하지 않는다.**
   - stdout이 조용하거나 프로세스가 오래 걸려도 완료로 보지 않는다.
   - 상태 전환은 명시 report, structured result, gate result로만 한다.

3. **토스트는 보조다.**
   - blocker, failure, retry 근거는 반드시 Task timeline/evidence에 남는다.

4. **Plan Document는 승인 가능한 문서여야 한다.**
   - UI 문구 변경이면 어떤 문구로 바꿀지 보여준다.
   - 코드 변경이면 범위, 파일 후보, acceptance, test plan을 보여준다.
   - non-trivial 작업이면 phase 목록이 아니라 executable task graph를 포함한다.
   - task card, ownership map, merge barrier, verification gate가 없으면 approval-ready로 보지 않는다.

5. **자동 진행은 테스트 완료까지만이다.**
   - merge decision은 자동화하지 않는다.
   - `MergeWaiting` 이후는 사용자의 명시 판단이다.

6. **로컬 우선, 안전 우선이다.**
   - agent는 사용자의 shell 권한을 가진 실행자로 취급한다.
   - bypass flag, workspace trust, runtime readiness를 UI에서 숨기지 않는다.

## 전체 마일스톤

### M0. 현재 UX 안정화

목표:

- 사용자가 “지금 움직이는지, 막혔는지, 뭘 기다리는지”를 Task board/detail에서 바로 이해한다.

작업:

- Task card에 active run overlay 표시.
- Task detail에 liveness card 표시.
- empty event state 문구 추가.
- Plan Document에 Proposed Copy 표시.
- planner soft timeout 처리.

상태:

- 대부분 반영됨.
- commit: `e46318e Improve task run visibility on board`

남은 작업:

- running run의 stale threshold를 설정값으로 노출할지 결정.
- liveness card에서 `Restart`, `Mark blocked` 액션까지 연결할지 결정.

완료 기준:

- 앱 open만으로 runner가 생기지 않는다.
- Task가 running이면 board와 detail 양쪽에서 같은 active role을 보여준다.
- 조용한 run은 `Running`으로 유지되고, 완료 추정 문구가 나오지 않는다.

### M1. Blocker Card와 Timeline 정리

목표:

- 실패/지연/권한 문제를 토스트가 아니라 Task timeline에서 복구 가능한 blocker로 다룬다.

레퍼런스:

- Multica: agent가 blocker를 작업 업데이트처럼 남긴다.
- Harnss: raw JSON/log 대신 rich card로 보여준다.
- Envoy: decision/evidence provenance를 남긴다.

작업:

- `TaskBlocker` view model 도입.
  - source: `agent_run`, `gate_result`, `repair_request`, `runner_check`, `worktree`
  - kind: `timeout`, `launch_failed`, `runner_missing`, `auth_required`, `schema_invalid`, `gate_failed`, `worktree_conflict`, `manual_decision`
  - actions: `retry`, `open_settings`, `open_git`, `rebuild_context`, `mark_blocked`, `dismiss`
- Task detail timeline에 blocker card 섹션 추가.
- toast 발생 시 같은 내용을 run event 또는 blocker event로 저장.
- blocker가 해결되면 resolved 상태와 근거를 남김.

Backend 후보:

- P0에서는 새 enum/table을 최소화한다.
- 기존 `repair_requests`, `gate_results`, `run_events`, `agent_runs.failure_kind`를 조합해 blocker DTO를 계산한다.
- 이후 필요하면 `task_blockers` table을 추가한다.

Acceptance Criteria:

- `planner timeout`, `worktree already exists`, `runner not logged in`이 각각 다른 blocker card로 보인다.
- blocker card에서 사용자가 다음 행동을 알 수 있다.
- blocker가 토스트에만 남는 경우가 없다.

Test Plan:

- fixture로 `TimedOut`, `NeedsInspection`, `runner missing` 상태를 만들어 blocker card가 표시되는지 확인한다.
- UI snapshot 또는 manual QA checklist로 action copy를 확인한다.

### M2. `.helm/tasks.md` Task Graph

목표:

- UI/DB 상태가 헷갈릴 때도 사용자가 repo 안에서 현재 작업판을 읽을 수 있게 한다.
- Planning 단계에서 생성된 executable task graph를 repo-local markdown과 Helm Task로 일관되게 추적한다.

진행 상태:

- 2026-05-25 P0 export-only 구현됨: Helm DB 상태를 `.helm/tasks.md`로 내보내고, Task 화면에서 `tasks.md 열기`와 `tasks.md 재생성`을 실행할 수 있다.
- 파일에는 Helm hash marker를 포함한다. 외부 편집으로 hash가 맞지 않으면 재생성 전에 사용자 확인을 요구한다.
- import/sync는 아직 구현하지 않았고, DB가 source of truth인 mirror 정책을 유지한다.

레퍼런스:

- Hive: `<workspace>/.hive/tasks.md`를 공유 task graph로 사용하고 파일 충돌 배너를 둔다.
- Hermes Desktop: direct source-of-truth와 safe file editing.
- Helm 계약: [Executable Planning Contract](executable-planning-contract.md)

작업:

- `.helm/tasks.md` export 생성.
- 포함 항목:
  - Task title/status
  - active role/run status
  - latest blocker
  - latest artifact paths
  - next action
  - source plan link
- backend command:
  - `export_task_graph(project_id)`
  - `read_task_graph(project_id)`
  - `check_task_graph_conflict(project_id)`
- UI:
  - Task board 상단에 `tasks.md` 열기/재생성 버튼.
  - 파일이 UI보다 최신이면 `Reload from disk` / `Keep Helm state` banner.

정책:

- P0는 export-only로 시작한다.
- import/sync는 P1 이후에만 다룬다.
- DB가 source of truth이고, markdown은 사람이 읽는 mirror다.

Acceptance Criteria:

- Task 0개, running 1개, blocker 1개 상태가 markdown에 각각 표현된다.
- 앱을 재시작해도 export 결과가 현재 DB와 일치한다.
- 외부 편집으로 conflict가 생기면 overwrite 전에 경고한다.

Test Plan:

- DB fixture로 task graph export를 unit test한다.
- markdown diff가 deterministic한지 확인한다.

### M3. Run Lifecycle/Liveness 모델 확장

목표:

- `Queued`, `Running`, `TimedOut`만으로는 부족한 실행 상태를 더 정확히 분류한다.

진행 상태:

- 2026-05-25 additive migration 구현됨: `agent_runs`에 `lifecycle_phase`, `claimed_at`, `heartbeat_at`, `failure_kind`, `failure_reason`, `attempt`를 추가했다.
- 기존 `agent_runs.status` CHECK는 유지한다. UI label과 `.helm/tasks.md`는 `status + lifecycle_phase + failure_kind`를 조합해 표시한다.
- run event가 들어오면 running run의 `heartbeat_at`을 갱신하고, app restart orphan은 `failure_kind=orphaned_after_restart`로 분류한다.

레퍼런스:

- Multica: enqueue, claim, start, complete/fail lifecycle.
- AIF Handoff: heartbeat/stale watchdog.
- Hive: process activity로 완료를 추정하지 않음.

작업:

- additive DB column 후보:
  - `lifecycle_phase`
  - `claimed_at`
  - `heartbeat_at`
  - `failure_kind`
  - `failure_reason`
  - `attempt`
- 기존 `agent_runs.status` CHECK는 P0에서 건드리지 않는다.
- UI label은 `status + lifecycle_phase + failure_kind`에서 계산한다.
- stale classifier:
  - `queued_stale`
  - `claim_stale`
  - `running_quiet`
  - `orphaned_after_restart`
  - `process_timeout`

Acceptance Criteria:

- spawn 실패와 agent report failure가 서로 다르게 보인다.
- app restart 후 orphaned running run이 `NeedsInspection + orphaned_after_restart`로 분류된다.
- stale run은 자동 완료되지 않고 복구 액션을 보여준다.

Test Plan:

- Rust DB tests로 stale classification 검증.
- fixture runner로 timeout/failure/orphan flow 검증.

### M4. Evidence Cards

목표:

- artifact viewer를 raw text 창에서 “무엇을 했는지 이해하는 카드”로 바꾼다.

진행 상태:

- 2026-05-25 P0 frontend evidence feed 구현됨: Task Detail `산출물` 탭에서 각 run의 `structured-result.json`, `changed-files.json`, lifecycle/failure metadata를 읽어 Run Summary, Blocker, Gate Result, File Changes 카드를 보여준다.
- raw artifact 접근은 유지한다. 카드의 `summary/result/events` 버튼으로 원문을 바로 열 수 있다.

레퍼런스:

- Harnss: tool call card, word-level diff, inline bash output, changes panel.
- Envoy: command evidence와 provenance.

카드 종류:

- Run Summary Card
- Command Card
- Diff Card
- File Changes Card
- Gate Result Card
- Blocker Card
- Approval Card
- Repair Request Card

작업:

- `structured-result.json`, `changed-files.json`, `diff.patch`, `stdout/stderr`를 파싱해 evidence card DTO 생성.
- Task detail `산출물` 탭을 evidence feed로 전환.
- raw artifact는 접힌 dev/debug 영역으로 이동.

Acceptance Criteria:

- 사용자가 `summary.md`를 열지 않아도 role 결과, changed files, blocking gate를 이해한다.
- diff.patch가 있으면 파일별 diff summary가 카드로 보인다.
- raw logs는 여전히 접근 가능하다.

Test Plan:

- fixture artifact를 넣고 evidence card DTO snapshot 검증.

### M5. Targeted Repair Loop

목표:

- review/test 실패 후 “뭘 고쳐야 하는지”가 repair task로 이어진다.

진행 상태:

- 2026-05-25 P0 targeted repair 구현됨: blocking gate가 만든 `repair_requests`에서 `repair 준비`를 실행하면 `agent_runs.repair_request_id`로 연결된 repair run이 생성된다.
- Repair Context Pack에는 failed gate, affected files, 이전 summary, allowed/disallowed scope, repair output contract가 포함된다.
- repair run은 일반 role 상태 제약과 분리해 실행할 수 있고, 성공 시 연결된 repair request를 `Resolved`로 닫는다.
- 반복 실패 limit은 동일 repair request 기준 3회로 제한했다. 반복 초과 시 manual handoff 안내를 반환한다.

레퍼런스:

- AIF Handoff: staged repair/manual handoff.
- Multica: blocker/status update.
- Envoy: objection/repair record.

작업:

- `repair_request_id`를 run과 연결.
- repair context pack 생성:
  - failed gate
  - affected files
  - previous summary
  - allowed scope
  - disallowed scope
- 버튼:
  - `repair 준비`
  - `repair 실행`
  - `gate 재검증`
  - `manual handoff`
- 반복 실패 limit 도입.

Acceptance Criteria:

- tester failure가 repair request로 남는다.
- repair run은 해당 blocker만 수정하도록 context가 제한된다.
- repair 성공 후 tester rerun이 명시적으로 생성된다.

Test Plan:

- fixture tester fail -> repair -> tester pass 경로 검증.

### M6. Runtime Readiness Dashboard

목표:

- 사용자가 실행 전에 CLI 설치, 로그인, timeout, bypass flag, worktree root 문제를 알 수 있게 한다.

진행 상태:

- 2026-05-25 P0 Task board 상단 Runtime readiness 패널 구현됨: 역할별 runner 배정 상태, health check 결과, command, timeout, approval/sandbox policy, bypass flag를 표시한다.
- `runtime 점검` 버튼은 기존 `check_role_runner` command를 역할별로 실행해 CLI 로그인/경로/health failure를 보드 안에서 확인한다.
- Settings 이동 버튼을 함께 제공해 runner 문제를 바로 수정할 수 있게 했다.

레퍼런스:

- Multica: runtime dashboard와 CLI auto-detection.
- Hive: PATH/login/troubleshooting이 명확함.
- Harnss: Agent Store/agent configuration.

작업:

- Settings 또는 하단 bar에 runtime readiness matrix 추가.
- 표시 항목:
  - provider
  - command path
  - version
  - logged-in/usable
  - assigned roles
  - planning timeout
  - execution timeout
  - sandbox/approval/bypass policy
  - last check
- Task next action에서 readiness failure와 연결.

Acceptance Criteria:

- Claude 미로그인, Codex PATH 없음, worktree root 문제를 각각 다른 안내로 표시한다.
- readiness check가 Task 실행 버튼 옆에 축약 표시된다.

Test Plan:

- mock settings로 ready/missing/auth-required 상태 표시 확인.

### M7. Plan/Permission/Autonomy Mode 정리

목표:

- plan mode, approval policy, automation policy, conductor mode가 섞이지 않게 한다.

진행 상태:

- 2026-05-25 P0 automation boundary 정리됨: Plan Document 승인 후 생성된 Task는 `start_next_role_run`으로 자동 queue에 올라가고, background worker가 host run을 실행한다.
- planner host run이 성공해 `PlanApproval`을 만들면 automation policy가 이를 자동 승인하고 coder -> plan verifier -> code reviewer -> tester 순서로 이어간다.
- tester 통과 후 `MergeWaiting`에서 자동 진행은 멈추며 merge decision은 수동으로 남는다.
- Planning CTA와 Runtime readiness copy를 `승인하고 테스트까지 자동 진행`, `테스트 완료까지 자동 · 머지 수동`으로 갱신했다.

레퍼런스:

- Harnss: plan mode와 permission control을 실행 중에도 명확히 표시.
- Helm 기존 이슈: planner 승인 후 왜 planner가 또 도는지 혼동.

작업:

- 설정 개념 분리:
  - planning mode: plan draft를 어떻게 만들지
  - permission policy: agent command/file edit 허용 범위
  - automation policy: 다음 role 자동 진행 범위
  - conductor mode: queued run 전 hold/run gate
- UI copy 정리:
  - `승인하고 Task 생성`
  - `구현 시작 승인`
  - `테스트 완료까지 자동 진행`
  - `머지는 수동`

Acceptance Criteria:

- Plan Document 승인, PlanApproval, Coder run이 각각 무엇인지 UI에서 구분된다.
- 자동 진행 범위가 `테스트 완료까지`로 명확히 보인다.

### M8. Session Search/History and Reusable Skills

목표:

- 과거 run을 찾고, 반복 해결책을 재사용 가능한 지식으로 축적한다.

진행 상태:

- 2026-05-25 P0 Task board history search 구현됨: Task title/description/status/external refs와 로드된 run role/status/lifecycle/failure/repair request id를 한 입력창에서 검색한다.
- 검색 결과는 기존 Kanban 보드 필터로 반영되어 이전 tester failure, blocker, repair 대상 task를 빠르게 찾을 수 있다.
- artifact 본문 full-text index와 `.helm/skills` 후보 저장은 P1로 남겼다.

레퍼런스:

- Harnss: session search/history.
- Multica: reusable skills.
- Hive: 장기 기억/팀 memory 방향.

작업:

- run/session search:
  - task title
  - role
  - status
  - artifact text
  - blocker kind
- skill candidate:
  - repeated blocker
  - repeated repair
  - successful workflow
- export target:
  - `.helm/skills`
  - Obsidian project memory

Acceptance Criteria:

- 이전 tester failure를 검색해 찾을 수 있다.
- 반복된 해결책을 skill candidate로 표시한다.

## 실행 순서

권장 순서:

1. M1 Blocker Card
2. M2 `.helm/tasks.md`
3. M3 Run Lifecycle/Liveness
4. M4 Evidence Cards
5. M5 Targeted Repair Loop
6. M6 Runtime Readiness Dashboard
7. M7 Mode 정리
8. M8 Search/Skills

이 순서를 권장하는 이유:

- M1/M2가 먼저 들어가면 사용자가 현재 상태를 믿을 수 있다.
- M3가 들어가야 M4/M5에서 failure 종류를 안정적으로 쓸 수 있다.
- M6/M7은 UX 혼동을 줄이지만, M1-M3의 데이터 기반이 있어야 더 정확해진다.
- M8은 앞 단계에서 쌓인 evidence가 있어야 의미가 있다.

## MVP Slice

가장 작게 잘라서 다음 작업으로 바로 구현할 slice:

```text
M1-A. Blocker DTO 계산 + Task Detail blocker card
```

진행 상태:

- 2026-05-25 구현됨: 기존 `AgentRunSummary`, `RunEventSummary`, runner readiness, worktree 준비 오류에서 frontend computed blocker DTO를 만들고 Task Detail 상단에 blocker card로 표시한다.
- 새 DB table이나 status enum은 추가하지 않았다.

범위:

- 새 DB table 없이 기존 데이터에서 blocker DTO 계산.
- TaskDetail에 blocker card 표시.
- `TimedOut`, `NeedsInspection`, `runner missing`, `worktree conflict` 네 종류만 우선 지원.
- 각 blocker는 reason과 next action을 가진다.

Acceptance Criteria:

- timeout run을 선택하면 "시간 초과" blocker card가 보인다.
- runner 설정이 없으면 "runner 설정 필요" blocker card가 보인다.
- blocker card의 action은 실제 Settings/Git/Retry 버튼과 연결된다.
- 기존 run/timeline/artifact 표시를 깨지 않는다.

Test Plan:

- `pnpm --dir apps/desktop typecheck`
- `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`
- fixture DB 상태 또는 수동 task로 blocker card 확인

## 주요 리스크

- 상태 모델을 한 번에 크게 바꾸면 SQLite CHECK 제약과 기존 UI mapping이 깨질 수 있다.
  - 대응: 새 enum보다 additive column과 computed DTO를 우선한다.
- 자동 진행을 강화하면 사용자가 원하지 않는 실행이 생길 수 있다.
  - 대응: click은 read-only, 자동 진행은 Plan Document 승인 이후 테스트 완료까지만.
- `tasks.md`를 양방향 source로 만들면 conflict가 복잡해진다.
  - 대응: P0는 export-only.
- evidence card가 너무 많으면 상세 패널이 복잡해질 수 있다.
  - 대응: 기본은 summary cards, raw artifact는 접힌 debug 영역.

## 완료 정의

전체 계획의 완료 기준:

- 사용자가 Task board만 보고도 어떤 Task가 실행 중/대기/막힘인지 구분한다.
- Task detail에서 마지막 활동, blocker, next action, evidence, retry 경로가 한 화면에 연결된다.
- 앱을 재시작해도 planning/task/run/evidence 상태를 재구성할 수 있다.
- 조용한 agent 실행은 완료로 추정되지 않는다.
- merge 전까지 자동화가 진행되더라도 merge decision은 항상 사용자에게 남는다.
- fixture runner로 plan -> coder -> review -> test -> merge waiting 경로와 failure -> blocker -> repair 경로가 검증된다.
