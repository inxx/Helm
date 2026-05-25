# Helm Reference Product Quality Upgrade Plan

작성일: 2026-05-25
상태: In progress (Q1 durable approval/artifact follow-up implemented 2026-05-25)

## 목적

이 문서는 레퍼런스 프로젝트에서 Helm에 가져올 제품/운영 패턴을 실제 구현 계획으로 정리한다.

기준은 하나다.

```text
Helm은 AI 작업자 실행 앱이 아니라, 로컬 repo에서 계획 -> 실행 -> 검증 -> 복구 -> 머지 판단을 믿을 수 있게 운영하는 control plane이다.
```

따라서 레퍼런스에서 가져올 것은 UI 모양이나 코드가 아니라, 제품 품질을 높이는 상태 모델, UX 계약, 검증 루프, 장애 복구 방식이다.

## 참고 레퍼런스

| 레퍼런스 | URL | 가져올 것 | 가져오지 않을 것 |
| --- | --- | --- | --- |
| Harnss | https://github.com/OpenSource03/harnss | multi-engine session visibility, rich tool/evidence cards, plan/permission mode, background task panel, notifications, session search | Harnss UI 복제, ACP registry 전체 의존, 모든 tool call renderer를 한번에 구현 |
| Multica | https://github.com/multica-ai/multica | agents as teammates, issue/task lifecycle, blocker/status update, runtime dashboard, reusable skills, autopilot 개념 | hosted queue/cloud runtime 기본값, agent가 Helm 상태 전이를 직접 소유하는 구조 |
| Hive | https://github.com/tt-a1i/hive | real PTY workers, shared `.hive/tasks.md`, explicit `team report`, worker stop/restart, local-first safety copy, tasks file conflict banner | AI orchestrator가 Helm 대신 다음 실행자를 결정하는 구조, bypass flag를 숨기는 UX |
| AIF Handoff | https://github.com/lee-to/aif-handoff | staged pipeline, heartbeat/stale watchdog, review rework loop, convergence-aware manual handoff, runtime profile separation | fully hands-off 기본값, review pass를 조용히 추정하는 자동화 |
| AI Factory | https://github.com/lee-to/ai-factory | spec-driven workflow, plan files, artifact ownership, quality gates, self-improvement patch/evolve loop, external skill security scan | slash command 중심 UX, 외부 command가 Helm state를 직접 수정하는 구조 |
| Envoy | https://github.com/statecraft-protocol/envoy | shared context, decision/evidence/authority/provenance model | relay/Connected/billing/capability crypto, Envoy를 runtime dependency로 강제 |
| Hermes Desktop | https://github.com/dodo-reach/hermes-desktop | direct source-of-truth clarity, profile-aware diagnostics, conflict-aware editing, real terminal, calm native UX | remote host를 Helm의 기본 전제로 삼는 것, Hermes 전용 Kanban/Cron/Skills 전체 복제 |

## 현재 Helm Gap 요약

현재 코드와 문서 기준의 주요 gap:

- Planning은 2026-05-25 Q1 vertical slice로 DB-backed session/revision/materialization을 갖고, follow-up으로 `planning_approvals`, draft artifact path/hash, 승인 후 materialize gate까지 연결됐다. 남은 gap은 materialization repair command와 frontend local stub 제거다.
- `Executable Planning Contract`는 2026-05-25 Q1 vertical slice에서 planner prompt/schema/frontend type/backend validation에 연결됐다. follow-up으로 새 contract field가 있는 draft의 `ownedFiles/sharedFiles` overlap, `generatedFilePolicy`, `reportContract` 검증이 추가됐다. 남은 gap은 report result 저장과 richer graph view다.
- automation policy가 project setting이 아니라 backend helper에 하드코딩되어 있다.
- run lifecycle metadata는 일부 있으나 claim/start/running/stale 구분이 충분하지 않다.
- blocker/evidence UI는 생겼지만 backend evidence feed DTO가 없어 raw artifact parsing이 frontend에 남아 있다.
- `MergeWaiting` 이후 accept/merge/readiness 화면이 약하다.
- runtime readiness, permission mode, bypass flag가 실행 직전 UX의 1급 정보로 항상 보이지 않는다.
- 반복 실패를 reusable skill/rule로 승격하는 제품 루프가 아직 없다.

## 구현 원칙

1. **DB가 기준이다.**
   - planning, task, run, approval, blocker, gate, repair, evidence는 모두 repo-local DB에서 재구성 가능해야 한다.
   - markdown은 사람이 읽는 mirror 또는 artifact다.

2. **명시 report만 완료다.**
   - 조용한 실행, process 종료, UI unmount는 완료 근거가 아니다.
   - `structured-result.json`, gate result, report event, audit row가 상태 전이 기준이다.

3. **자동화는 보이고 선택 가능해야 한다.**
   - plan mode, permission policy, automation policy, conductor gate는 다른 설정이다.
   - 버튼 문구에는 side effect가 드러나야 한다.

4. **병렬화는 ownership 이후다.**
   - task graph, file ownership, barrier, verification gate가 없으면 병렬 실행하지 않는다.

5. **복구는 first-class UX다.**
   - blocker는 toast가 아니라 Task timeline/evidence에 남는다.
   - retry, repair, rerun, manual handoff가 분리되어야 한다.

## Phase Q0. Adoption Baseline과 Technical Blocker 제거

목표:

- 이후 단계에서 migration, enum, UX policy, 검증 harness 때문에 막히지 않게 선행 결정을 고정한다.

작업:

1. `docs/reference-adoption-application-plan.md`와 이 문서의 blocker matrix를 동기화한다.
2. SQLite enum/CHECK 확장 정책을 고정한다.
   - P0는 additive column/table 우선.
   - CHECK enum 확장은 table rebuild 전용 milestone으로 분리.
3. Frontend 검증 정책을 고정한다.
   - P0: `pnpm --dir apps/desktop typecheck`, `pnpm --dir apps/desktop build`, Rust tests, manual QA checklist.
   - P1: Playwright 또는 Vitest/RTL 중 하나를 선택해 Planning/TaskDetail smoke를 자동화.
4. automation policy 기본값을 문서와 코드에서 하나로 맞춘다.
   - `manual`
   - `prepare_after_approval`
   - `run_to_testing`
   - `full_auto_without_merge`
5. migration compatibility note를 작성한다.
   - 기존 `.helm/helm.sqlite`에 planning table이 없어도 앱이 열려야 한다.
   - 기존 local-only planning session은 migration 대상이 아니다.

완료 기준:

- 구현자가 enum 확장, approval table, automation setting 위치를 다시 결정하지 않아도 된다.
- 문서상 P0/P1 경계가 코드 변경 단위와 맞다.

검증:

- 문서 diff check.
- DB migration이 들어가는 첫 PR부터 Rust migration test 추가.

## Phase Q1. DB-backed Planning + Executable Plan

가져올 레퍼런스:

- AI Factory plan files와 artifact ownership.
- Hive `.hive/tasks.md` task graph.
- Multica issue/task assignment lifecycle.

목표:

- Planning output을 local React state가 아니라 repo-local durable artifact로 만든다.
- 큰 작업은 `executablePlan`으로 task graph, task card, ownership map, barrier, verification gate를 가진다.

2026-05-25 구현 상태:

- 완료:
  - migration `apps/desktop/src-tauri/migrations/0008_planning_workspace.sql` 추가.
  - migration `apps/desktop/src-tauri/migrations/0009_planning_approvals_artifacts.sql` 추가.
  - `planning_sessions`, `planning_messages`, `plan_draft_revisions`, `planning_materializations`, `planning_materialization_items` 생성.
  - `planning_approvals` 생성 및 기존 current draft approval backfill.
  - Tauri command 추가: `list_planning_sessions`, `create_planning_session`, `get_planning_session`, `save_plan_draft_revision`, `approve_plan_draft`, `reject_plan_draft`, `materialize_plan_draft`.
  - `build_planner_prompt` JSON schema에 `executablePlan.taskGraph/taskCards/ownershipMap/barriers/verificationGates` 추가.
  - `build_planner_prompt` JSON schema에 `taskCards.ownedFiles/sharedFiles/generatedFiles/generatedFilePolicy/reportContract` 추가.
  - backend draft 저장 시 `executablePlan` presence/count validation 추가.
  - 새 contract field가 있는 draft에 대해 parallel `ownedFiles` overlap, `sharedFiles` vs parallel `ownedFiles`, graph/card id consistency, missing report/generated policy validation 추가.
  - draft markdown artifact를 `.helm/planning/{session_id}/draft-v{n}.md`에 저장하고 DB row에 `artifact_path`, `content_hash`를 남김.
  - `materialize_plan_draft`는 승인되지 않은 draft를 `PlanDraftApprovalRequired`로 차단하고, 기존 materialization의 Task가 사라졌으면 `MaterializationBroken`을 반환.
  - Planning UI가 DB session list를 로드하고 draft revision을 저장한 뒤 `materializePlanDraft`로 Task를 생성한다.
  - Planning UI 승인 흐름이 `approvePlanDraft -> materializePlanDraft` 순서로 분리됐다.
  - Plan preview에 Task Graph, Barriers, Verification Gates 요약을 표시한다.
- 남음:
  - `MaterializationBroken`을 사용자가 확인하고 복구하는 `repair_planning_materialization` command/UX.
  - `PlanningSessionStub` 이름과 일부 optimistic local mutation 제거.
  - report result를 `reportContract` 기준으로 저장/표시하는 evidence DTO.
  - browser smoke 및 frontend automated smoke.

Backend 작업:

1. 새 table 추가.
   - `planning_sessions`
   - `planning_messages`
   - `plan_draft_revisions`
   - `planning_materializations`
   - `planning_materialization_items`
   - `planning_approvals`
2. `planning_approvals`를 별도 table로 둔다.
   - 기존 `approvals.entity_type` CHECK 때문에 P0에서 `PlanDraft`를 넣지 않는다.
3. draft 저장은 `.tmp -> rename` 방식으로 artifact atomicity를 보장한다.
   - 예: `.helm/planning/{session_id}/draft-v{n}.md`
   - DB row에는 artifact relative path와 content hash를 저장한다.
4. `executablePlan` JSON validation을 추가한다.
   - `classification`
   - `taskGraph.serialSpine`
   - `taskGraph.parallelLanes`
   - `taskGraph.barriers`
   - `taskCards`
   - `ownershipMap`
   - `verificationGates`
   - `reportContract`
5. parallel task validation:
   - `ownedFiles` overlap 금지.
   - `sharedFiles`는 parallel task의 owned files에 들어가면 invalid.
   - generated file policy가 없는 task는 approval-ready 불가.
6. materialize는 idempotent 해야 한다.
   - `planning_materializations.draft_id UNIQUE`.
   - `planning_materialization_items(materialization_id, source_index) UNIQUE`.
   - materialized task가 삭제된 경우 자동 재생성하지 않고 `MaterializationBroken` error를 반환한다.

Frontend 작업:

1. `PlanningSessionStub` 제거.
2. `create_planning_session`, `get_planning_session`, `save_plan_draft_revision` command 결과만 UI state로 반영한다.
3. Plan Document preview에 아래 섹션 추가.
   - `Task Graph`
   - `Task Cards`
   - `Ownership Map`
   - `Barriers`
   - `Verification Gates`
4. 승인 버튼 문구 분리.
   - `Task 생성 승인`
   - `생성 후 자동 진행 시작`은 별도 checkbox 또는 automation setting 기반 copy.
5. 기존 Task `PlanApproval`과 Plan Draft approval copy를 분리한다.

기술 blocker와 결정:

| Blocker | 결정 |
| --- | --- |
| 기존 `approvals` CHECK가 PlanDraft를 허용하지 않음 | `planning_approvals` 별도 table |
| Planning detail을 `ProjectSnapshot`에 모두 넣으면 느려짐 | list는 summary, detail은 lazy command |
| planner가 executablePlan 없는 JSON을 반환할 수 있음 | validation status `Invalid`, approve disabled |
| 기존 prompt schema와 문서 contract 불일치 | `build_planner_prompt` JSON schema에 `executablePlan` 추가 |
| 여러 Task materialize 중 일부 실패 | transaction으로 묶고 실패 시 rollback |
| artifact write와 DB transaction atomicity | 현재는 `.tmp -> final` 파일 쓰기를 먼저 성공시킨 뒤 DB row를 저장해 DB가 missing artifact를 가리키는 상태를 피한다. DB 실패 시 orphan artifact가 남을 수 있으므로 retention/cleanup은 후속으로 둔다. |

완료 기준:

- 앱 재시작 후 planning session, messages, active draft가 복원된다.
- 승인 전 `executablePlan`을 볼 수 있다.
- `executablePlan`이 invalid이면 승인할 수 없다.
- 같은 draft를 두 번 승인해도 Task가 중복 생성되지 않는다.

검증:

- Rust DB tests:
  - session create/list/get
  - draft revision supersede
  - invalid executablePlan rejection
  - overlapping ownedFiles rejection
  - materialize idempotency
- Frontend:
  - 목표 입력 시 `createTask`가 호출되지 않음.
  - session reload 후 draft가 유지됨.

## Phase Q2. Automation/Permission Mode 분리

가져올 레퍼런스:

- Harnss plan mode와 permission control.
- Hive local safety copy와 bypass flag visibility.
- AIF Handoff human-in-the-loop mode.

목표:

- 사용자가 지금 Helm이 어디까지 자동으로 진행하는지 항상 알아야 한다.

새 설정:

```text
planningMode:
  native_plan | prompt_guarded | fixture

permissionPolicy:
  ask_first | accept_edits | allow_all

automationPolicy:
  manual
  prepare_after_approval
  run_to_testing
  full_auto_without_merge

conductorGateMode:
  off | observe | gate
```

Backend 작업:

1. `project_automation_policy` 하드코딩 제거.
2. project settings에 `automationPolicy` 추가.
3. 모든 자동 handoff 경로가 같은 policy helper를 사용하게 한다.
   - plan draft materialize 후 next role
   - Task `PlanApproval` approve 후 coder
   - run success 후 next role
   - supervisor reconcile
   - queue worker host run
4. `requireExplicitHostRun`은 `automationPolicy`에서 계산한다.
5. `run_to_testing`은 tester pass 후 `MergeWaiting`에서 반드시 멈춘다.

Frontend 작업:

1. Task board 상단에 mode strip 표시.
   - Planning
   - Permission
   - Automation
   - Conductor gate
2. 실행 버튼 옆에 side effect summary 표시.
   - DB row 생성
   - worktree 생성
   - host CLI 실행
   - 파일 변경 가능
3. approval button 문구를 mode별로 바꾼다.
   - `승인만`
   - `승인하고 실행 준비`
   - `승인하고 테스트까지 자동 진행`
4. bypass flag 경고를 runtime readiness와 next action에 표시한다.

기술 blocker와 결정:

| Blocker | 결정 |
| --- | --- |
| `ConductorConfig.mode`와 automation mode가 섞임 | `automationPolicy` 별도 project setting |
| 기존 DB settings JSON shape migration | missing value는 `manual` 또는 현재 제품 결정값으로 default |
| queue worker가 이미 켜져 있음 | worker loop 시작 조건도 automation policy 확인 |
| approval copy와 실제 side effect 불일치 | action helper가 `ActionEffectSummary` DTO 반환 |
| bypass flag 탐지 provider별 차이 | command args scanner를 provider-agnostic warning으로 시작 |

완료 기준:

- 자동 진행 범위가 UI에서 항상 보인다.
- `manual`에서는 approval/run success가 새 run을 만들지 않는다.
- `run_to_testing`은 tester pass 후 MergeWaiting에서 멈춘다.
- bypass flag가 있는 runner는 실행 전 warning으로 보인다.

검증:

- Rust tests:
  - manual approval does not queue next run.
  - prepare_after_approval queues but does not run host.
  - run_to_testing auto-runs until tester pass.
- Frontend QA:
  - mode strip copy와 버튼 side effect가 일치.

## Phase Q3. Run Lifecycle, Liveness, Worker Recovery

가져올 레퍼런스:

- Multica `enqueue -> claim -> start -> complete/fail`.
- Hive worker stop/restart와 explicit report.
- AIF Handoff stale-stage watchdog.

목표:

- "대기", "claim됨", "spawn 중", "실행 중", "조용함", "stale", "orphan"을 구분한다.

Backend 작업:

1. 기존 `agent_runs.status` CHECK는 유지한다.
2. `lifecycle_phase` 의미를 표준화한다.
   - `queued`
   - `claimed`
   - `starting`
   - `running`
   - `quiet`
   - `stale`
   - `completed`
   - `failed`
   - `orphaned`
3. `claim_host_run`은 claim 시 `lifecycle_phase='claimed'`로 둔다.
4. process spawn 직전/직후 `starting`, stdout/stderr 또는 adapter ready 후 `running`.
5. heartbeat source를 통합한다.
   - run event insert
   - stdout/stderr
   - adapter status
   - structured result write
6. stale classifier 추가.
   - `queued_stale`
   - `claim_stale`
   - `start_stale`
   - `running_quiet`
   - `process_timeout`
   - `orphaned_after_restart`
7. retry policy를 `failure_kind` 기반으로 계산한다.

Frontend 작업:

1. Task card overlay에 lifecycle label과 last heartbeat 표시.
2. Task Detail current run panel에 recovery action 표시.
   - stop
   - restart
   - retry prepare
   - mark blocked
   - inspect artifact
3. stuck worker는 "완료 추정"이 아니라 "명시 report 대기"로 표시한다.

기술 blocker와 결정:

| Blocker | 결정 |
| --- | --- |
| status enum에 `Claimed` 추가 불가 | `status='Running'`, `lifecycle_phase='claimed'` |
| process registry는 app restart 시 사라짐 | restart reconcile은 `orphaned_after_restart`로 분류 |
| host process kill 가능 여부 | Phase Q3 P0는 DB cancel + best-effort kill, hard kill tracking은 P1 |
| retry 가능한 failure와 repair 필요한 failure 혼동 | `retry_policy_for_failure_kind` helper 추가 |
| quiet run이 정말 멈췄는지 알 수 없음 | UI는 quiet/stale로 표시하되 완료로 전환하지 않음 |

완료 기준:

- spawn failure와 timeout과 orphan이 다른 blocker로 보인다.
- queue에 오래 남은 run이 `queued_stale`로 분류된다.
- restart 후 running run은 `NeedsInspection + orphaned_after_restart`.
- Retry button은 retry 가능한 failure에만 primary로 보인다.

검증:

- Rust tests:
  - claim phase transition
  - spawn failure
  - stale queued/claimed/running classification
  - interrupted run reconcile

## Phase Q4. Backend Evidence Feed와 Rich Task Timeline

가져올 레퍼런스:

- Harnss rich tool visualization.
- Envoy decision/evidence/provenance.
- AI Factory quality gate result.

목표:

- UI가 raw artifact를 직접 해석하지 않아도 run 결과, gate, blocker, command, diff, approval을 카드로 보여준다.

Backend 작업:

1. `get_task_evidence_feed(project_id, task_id)` command 추가.
2. Evidence DTO kind:
   - `run_summary`
   - `command`
   - `stdout`
   - `stderr`
   - `file_changes`
   - `diff_summary`
   - `gate_result`
   - `blocker`
   - `repair_request`
   - `approval`
   - `artifact`
3. `command_evidence`, `gate_results`, `repair_requests`, `approvals`, `run_events`, run artifacts를 join해서 feed 생성.
4. artifact parser는 backward compatible이어야 한다.
   - missing artifact는 warning card.
   - invalid JSON은 blocker card.
5. raw artifact viewer는 debug/details로 유지한다.

Frontend 작업:

1. Task Detail `산출물` 탭의 evidence card source를 backend DTO로 전환한다.
2. Timeline 탭은 decision/evidence feed를 시간순으로 보여준다.
3. 카드 action:
   - open artifact
   - open diff
   - retry
   - prepare repair
   - approve/reject
4. command card에는 command, cwd, exit code, duration, truncated 여부를 표시한다.

기술 blocker와 결정:

| Blocker | 결정 |
| --- | --- |
| `run_events.kind` CHECK에 tool_call 등 새 kind 불가 | P0는 existing kind + payload normalization, P1에서 event details table 검토 |
| diff.patch가 큰 경우 UI freeze | backend에서 summary만 계산, raw diff는 별도 open |
| artifact path 안전성 | existing relative artifact path validation 재사용 |
| 여러 source join 순서 | `created_at`, run seq, fallback order로 deterministic sort |
| frontend parser 중복 | 단계적으로 backend feed를 기본, raw parser는 fallback |

완료 기준:

- Task Detail 첫 화면에서 최근 run 결과와 blocker를 raw JSON 없이 이해할 수 있다.
- invalid structured-result는 evidence card로 보인다.
- gate failure는 repair action으로 이어진다.

검증:

- Rust DTO snapshot tests.
- Fixture artifact set으로 evidence feed deterministic test.
- Frontend typecheck/build.

## Phase Q5. Review/Test Repair Convergence와 Manual Handoff

가져올 레퍼런스:

- AIF Handoff convergence-aware review loop.
- Multica blocker/status update.
- AI Factory patch/fix record.

목표:

- 실패한 gate를 무한 retry하지 않고, 수렴하지 않으면 명시적으로 human handoff한다.

Backend 작업:

1. `repair_requests`에 additive metadata 추가.
   - `phase`
   - `attempt_count`
   - `max_attempts`
   - `last_repair_run_id`
   - `verification_run_id`
   - `handoff_required`
2. repair success는 즉시 resolved가 아니라 verification을 요구한다.
   - `ResolvedPendingVerification`
   - existing CHECK 때문에 status는 `Open/Resolved/Dismissed` 유지, phase column으로 표현.
3. convergence policy:
   - 같은 repair request 3회 실패 시 `manual_handoff_required`.
   - 같은 blocker summary/affected files 반복 시 convergence failed.
4. `request_manual_handoff` command 추가.
5. successful repair는 patch candidate로 저장한다.
   - `.helm/patches/YYYY-MM-DD-{slug}.md`
   - Obsidian/project memory 반영은 사용자 승인 뒤.

Frontend 작업:

1. Repair panel에 attempt count와 convergence status 표시.
2. 반복 실패 시 primary action을 `manual handoff`로 바꾼다.
3. manual handoff에는 다음 내용을 보여준다.
   - blocker summary
   - failed attempts
   - affected files
   - suggested human action
   - last artifacts

기술 blocker와 결정:

| Blocker | 결정 |
| --- | --- |
| `repair_requests.status` CHECK 확장 어려움 | `phase` additive column |
| repair run과 gate rerun 생성 주체 혼동 | explicit repair flow command가 rerun 생성 |
| successful repair 자동 skill 반영 위험 | patch candidate만 저장, 채택은 사용자 승인 |
| repeated failure 판정이 모호함 | summary hash + affectedFiles hash + gate id 기준 |

완료 기준:

- 같은 blocker가 반복 실패하면 manual handoff가 보인다.
- repair run은 allowed scope를 넘지 않는 context pack을 가진다.
- repair 후 verification run이 연결된다.

검증:

- fixture tester fail -> repair fail x3 -> manual handoff.
- repair pass -> verification pass -> repair resolved.

## Phase Q6. Merge Readiness와 Accept/Merge Decision

가져올 레퍼런스:

- AI Factory verify/review gates.
- Spec-style accept/merge stage.
- Harnss Git integration.

목표:

- `MergeWaiting`은 끝이 아니라 사용자 merge decision workspace가 되어야 한다.

Backend 작업:

1. `get_merge_readiness(project_id, task_id)` command 추가.
2. DTO:
   - task status
   - worktree branch/path/head
   - base branch
   - dirty/staged/untracked count
   - changed files summary
   - last passing tester run
   - open blockers
   - unresolved repair requests
   - pending approvals
   - suggested merge command
   - risk summary
3. `merge_decisions` table 추가.
   - `Approved`
   - `Rejected`
   - `Deferred`
   - `MergedExternally`
4. Phase Q6 P0에서는 actual merge command를 자동 실행하지 않는다.
5. `gate_results.gate='merge_readiness'`는 CHECK 때문에 쓰지 않고 DTO/merge_decisions basis에 저장한다.

Frontend 작업:

1. Task Detail `MergeWaiting` next action을 `Merge readiness 열기`로 변경.
2. Git screen에 Merge Readiness panel 추가.
3. Approve/Defer/Reject decision을 audit에 저장.
4. suggested command는 copyable text로 제공하고, 실행은 후속 phase에서 다룬다.

기술 blocker와 결정:

| Blocker | 결정 |
| --- | --- |
| merge gate를 `gate_results`에 저장 불가 | `merge_decisions.basis_json` 사용 |
| worktree branch가 사라진 경우 | readiness status `blocked_missing_worktree` |
| user dirty changes와 task worktree changes 혼동 | project root와 task worktree status를 분리 표시 |
| 자동 merge 위험 | Q6 P0는 decision/audit only |

완료 기준:

- MergeWaiting에서 diff/gate/blocker/command를 한 화면에서 볼 수 있다.
- 사용자가 merge decision을 남기면 audit과 timeline에 남는다.
- open blocker가 있으면 approve disabled.

검증:

- Rust merge readiness DTO tests.
- Manual QA with clean, dirty, missing worktree states.

## Phase Q7. Runtime Dashboard, Agent Store Lite, Notifications

가져올 레퍼런스:

- Multica runtime dashboard.
- Harnss Agent Store, notifications.
- Hive first-run/preflight/troubleshooting.
- Hermes Desktop diagnostics.

목표:

- 실행 전 실패를 Settings 안에 숨기지 않는다.

Backend 작업:

1. `get_runtime_dashboard(project_id)` command 추가.
2. DTO:
   - assigned roles
   - provider
   - command
   - command exists
   - login/auth status
   - version/model availability
   - timeout
   - approval policy
   - sandbox
   - bypass flag detected
   - last check
   - suggested fix
3. Agent Store Lite:
   - fixture
   - Codex CLI
   - Claude CLI
   - custom process
4. OS notification events:
   - approval pending
   - run completed
   - run blocked
   - manual handoff required

Frontend 작업:

1. Task board 상단 runtime dashboard compact view.
2. Settings runtime detail view.
3. Next Action에서 runtime blocker와 직접 연결.
4. First-run demo fixture route 제공.

기술 blocker와 결정:

| Blocker | 결정 |
| --- | --- |
| provider별 login check가 다름 | provider adapter별 health check, unknown은 warning |
| notification permission OS별 차이 | Tauri notification capability를 optional로 두고 fallback toast |
| Agent Store가 커지면 scope 폭발 | P0는 built-in templates + custom only |
| model listing이 느리거나 실패 | cached availableModels + refresh button |

완료 기준:

- 사용자는 실행 전 runner 문제를 board에서 확인한다.
- bypass flag가 있는 role은 warning으로 보인다.
- approval/blocker/run completion notification이 선택적으로 동작한다.

검증:

- role runner check tests.
- UI manual QA: missing CLI, auth required, bypass enabled.

## Phase Q8. Source-of-Truth와 Conflict-Aware Editing

가져올 레퍼런스:

- Hermes Desktop direct source-of-truth.
- Hive `.hive/tasks.md` conflict banner.
- AI Factory artifact ownership metadata.

목표:

- Helm이 만든 markdown/artifact를 사람이 수정해도 충돌을 안전하게 처리한다.

작업:

1. `.helm/tasks.md`는 계속 mirror로 둔다.
2. `Plan Document` markdown export는 hash marker를 가진다.
3. 외부 편집 감지:
   - hash mismatch
   - mtime newer than DB updated_at
   - missing file
4. conflict action:
   - reload from disk
   - keep Helm state and overwrite
   - save as new draft revision
5. artifact metadata frontmatter 도입.
   - `id`
   - `type`
   - `status`
   - `owners`
   - `depends_on`
   - `affects`
   - `implements`
   - `verifies`
6. `audit_artifacts` command 추가.
   - duplicate id
   - missing dependency
   - cycle
   - stale affected artifact

기술 blocker와 결정:

| Blocker | 결정 |
| --- | --- |
| markdown을 DB source로 만들면 sync 복잡 | P0는 DB source, markdown mirror/export |
| 외부 편집을 무시하면 사용자 신뢰 하락 | overwrite 전 conflict confirmation 필수 |
| artifact metadata 없는 기존 파일 | warn only, strict mode는 새 artifact부터 |
| cycle detection 구현 범위 | P0는 docs/.helm explicit target만 scan |

완료 기준:

- 외부 편집된 Plan Document를 덮어쓰기 전 경고한다.
- 새 draft revision으로 import할 수 있다.
- artifact audit가 duplicate/missing reference를 잡는다.

검증:

- hash conflict unit tests.
- artifact audit fixture tests.

## Phase Q9. Reusable Skills와 Knowledge Evolution

가져올 레퍼런스:

- Multica reusable skills.
- AI Factory fix patch/evolve.
- Hive long-term shared memory 방향.

목표:

- 반복되는 blocker와 성공한 repair를 다음 run의 품질 향상 재료로 만든다.

작업:

1. `skill_candidates` table 또는 `.helm/skill-candidates/*.md` 추가.
2. 생성 조건:
   - 같은 failure_kind 2회 이상.
   - 같은 gate blocker hash 반복.
   - repair 성공 후 같은 파일/도메인에서 재발 방지 규칙이 명확함.
3. candidate schema:
   - problem
   - rootCause
   - solution
   - prevention
   - files
   - tags
   - source run/repair ids
4. 채택 workflow:
   - candidate 생성
   - 사용자 review
   - project rule/context pack에 반영
   - Obsidian/project memory 저장은 명시 승인 또는 작업 종료 루틴에서 수행
5. 외부 skill 설치는 P2 이후.
   - security scan 없이는 자동 설치하지 않는다.

기술 blocker와 결정:

| Blocker | 결정 |
| --- | --- |
| 자동 skill 반영은 위험 | candidate만 자동, adoption은 사용자 승인 |
| Obsidian 저장 위치 혼동 | Helm project memory path를 명시하고 저장 로그 남김 |
| private artifact 유출 위험 | candidate에는 raw secret/log 전문 저장 금지 |
| 너무 많은 candidate noise | severity/blocker recurrence threshold 적용 |

완료 기준:

- 반복 blocker가 skill candidate로 제안된다.
- 사용자가 채택한 rule만 다음 context pack에 포함된다.
- candidate source run/repair provenance가 남는다.

검증:

- repeated blocker fixture -> candidate generated.
- adopted candidate -> context pack includes rule.

## 통합 Task Graph

```text
Q0 blocker baseline
-> Q1 DB-backed planning + executablePlan
-> Q2 automation/permission mode split
-> Q3 run lifecycle/liveness
-> Q4 backend evidence feed
-> Q5 repair convergence/manual handoff
-> Q6 merge readiness
-> Q7 runtime dashboard/notifications
-> Q8 conflict-aware source-of-truth
-> Q9 skill evolution
```

병렬 가능 구간:

- Q3 run lifecycle과 Q7 runtime dashboard는 Q2 setting contract 이후 병렬 가능.
- Q4 evidence feed와 Q6 merge readiness는 Q3의 lifecycle/failure_kind 안정화 이후 일부 병렬 가능.
- Q8 artifact metadata는 Q1 planning artifact path가 고정된 뒤 Q4와 병렬 가능.
- Q9 skill evolution은 Q5 repair records와 Q4 evidence feed가 안정화된 뒤 시작한다.

## Coordinator-owned Files

아래 파일은 병렬 작업자가 직접 동시에 수정하지 않는다.

- `apps/desktop/src-tauri/src/db.rs`
- `apps/desktop/src-tauri/src/main.rs`
- `apps/desktop/src/lib/types.ts`
- `apps/desktop/src/lib/api.ts`
- `README.md`
- `docs/reference-*.md`
- `.helm/tasks.md`
- root package manager files

정책:

- 각 phase 구현자는 owned files를 task card에 명시한다.
- shared files는 phase integration barrier에서 coordinator가 갱신한다.
- generated files는 직접 수정하지 않는다.

## Final Verification Gate

각 phase는 가능한 범위에서 아래를 실행한다.

```bash
pnpm --dir apps/desktop typecheck
pnpm --dir apps/desktop build
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
git diff --check
```

브라우저/앱 smoke가 필요한 phase:

- Q1 Planning DB-backed flow
- Q2 automation/permission mode strip
- Q4 evidence feed
- Q6 merge readiness
- Q7 runtime dashboard

Smoke checklist:

- 앱 실행 후 runner가 의도치 않게 시작되지 않는다.
- Planning session reload가 유지된다.
- Task card click은 read-only다.
- approval button copy와 실제 side effect가 일치한다.
- blocker가 toast에만 남지 않는다.
- MergeWaiting에서 open blocker가 있으면 approve가 막힌다.

## Definition of Done

이 계획이 완료됐다고 보려면 아래가 모두 충족되어야 한다.

- Planning은 DB-backed이고 executablePlan validation을 통과해야 승인 가능하다.
- automation/permission/conductor mode가 분리되어 UI에 보인다.
- run lifecycle은 claim/start/running/stale/orphan을 구분한다.
- evidence feed는 backend DTO로 제공된다.
- repair loop는 convergence failure를 manual handoff로 닫는다.
- MergeWaiting은 merge readiness decision 화면을 가진다.
- runtime dashboard가 실행 전 실패를 예측한다.
- markdown/artifact 외부 편집은 conflict-aware로 처리된다.
- 반복 blocker는 skill candidate로 축적되며 자동 채택되지 않는다.
