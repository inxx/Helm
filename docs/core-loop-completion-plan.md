# Helm Core Loop Completion Plan

작성일: 2026-05-19

## 목적

현재 구현은 Phase 3a의 기반 기능까지 들어왔지만, 완성 제품의 핵심 목표인 "AI 개발 작업을 계획, 실행, 검토, 테스트, 승인, 머지까지 관리하는 데스크톱 control plane"으로 보기에는 아직 core loop가 얇다.

이 문서는 지금 구현을 버리지 않고, 사용자가 태스크 하나를 실제로 끝까지 운영할 수 있게 만드는 추가 작업 계획이다.

## 핵심 목표

우선 달성해야 할 목표는 많은 외부 연동이 아니라 아래 한 가지다.

```text
Task 생성
-> Plan 생성
-> PlanApproval 승인
-> task worktree 준비
-> Codex/Claude 단일 실행
-> diff/result 수집
-> 계획 검토
-> 코드 리뷰
-> 테스트 검증
-> MergeWaiting
-> 사용자 승인 후 main/develop 병합 준비
```

이 흐름이 Jira 없이도 동작해야 하고, Jira key나 URL이 있으면 외부 참조로 같이 추적되어야 한다.

## 현재 상태 요약

구현되어 있는 기반:

- 프로젝트 열기와 repo-local SQLite DB
- Epic/Task/External Ref/Audit Log
- read-only Git snapshot
- Stub role run과 PlanApproval
- Task worktree 생성
- Context Pack 생성
- HelmHostRunner 기본 실행
- run artifact viewer
- 기본 터미널 명령 실행기

부족한 점:

- role preset 기본값이 없어 실제 Codex/Claude 실행까지 바로 이어지지 않는다.
- UI가 상태 기반 안내가 아니라 버튼 모음에 가깝다.
- reviewer/tester chain은 상태 이름만 있고 검증 계약이 약하다.
- `RunApproval`, `ManualStatusChange`, merge approval 흐름이 실사용 흐름으로 연결되지 않았다.
- 실제 Git diff와 structured result를 비교해 판정하는 gate가 없다.
- merge/commit/PR 준비 단계가 없다.
- 문서상 Phase 3a 완료 표시와 README의 현재 상태가 일부 어긋난다.
- 테스트가 migration/path/schema 수준이라 핵심 사용자 플로우를 보호하지 못한다.

## 성공 기준

이 계획의 완료 기준은 아래 acceptance scenario가 통과하는 것이다.

```text
1. 사용자가 Git repo를 연다.
2. Jira 없이 새 Task를 만든다.
3. Planner를 실행해 PlanApproval Pending을 만든다.
4. 사용자가 계획을 승인한다.
5. Helm이 TaskStatus를 Ready로 전이한다.
6. 사용자가 Coder를 실행한다.
7. Helm이 worktree diff, changed files, summary, structured result를 남긴다.
8. Plan Verifier가 계획 준수 여부를 판정한다.
9. Code Reviewer가 리뷰 결과를 남긴다.
10. Tester가 설정된 check command를 실행하고 결과를 남긴다.
11. 모든 gate가 통과하면 TaskStatus가 MergeWaiting이 된다.
12. 사용자는 MergeWaiting 화면에서 diff, run history, approval, audit trail을 한 번에 확인한다.
```

이 시나리오는 실제 Codex/Claude가 없어도 fixture runner로 검증 가능해야 하고, 로컬에 Codex/Claude가 있으면 실제 runner로도 검증 가능해야 한다.

## 구현 단계

### Step 1. 문서와 현재 상태 정렬

목표:

- README와 Phase 문서가 현재 구현 범위와 남은 범위를 정확히 설명하게 한다.
- `generic shell execute 금지`와 기본 터미널 실행기 추가 사이의 정책 충돌을 정리한다.

작업:

- README의 현재 상태를 Phase 3a 기준으로 갱신한다.
- 기본 터미널 실행기는 "개발자 명시 실행 도구"로 분류하고, agent runner와 권한 모델을 분리해 문서화한다.
- `docs/phase-3a-implementation-plan.md`의 "구현 완료" 항목 중 검증이 부족한 항목은 "기본 구현 완료, 검증 보강 필요"로 조정한다.
- 다음 구현 기준 문서를 이 문서로 연결한다.

완료 기준:

- 문서만 보고도 현재 구현, 미구현, 다음 작업 우선순위가 구분된다.

### Step 2. 기본 role preset과 runner onboarding

목표:

- 사용자가 JSON을 직접 작성하지 않아도 host runner를 시작할 수 있게 한다.

작업:

- `rolePresets` 기본값에 `commandArgs` 예시를 추가한다.
- provider별 preset template을 제공한다.
  - Codex CLI
  - Claude CLI
  - shell fixture runner
- Settings UI를 raw JSON textarea 중심에서 preset 선택 + advanced JSON 편집 구조로 바꾼다.
- runner health check command를 추가한다.

추가 command 후보:

```text
list_runner_templates(project_id)
check_role_runner(project_id, role_id)
apply_runner_template(project_id, template_id)
```

완료 기준:

- 새 프로젝트에서 fixture runner template을 적용하고 Planner/Coder 실행을 끝까지 돌릴 수 있다.
- Codex/Claude가 설치된 환경에서는 health check가 성공/실패 이유를 명확히 보여준다.

### Step 3. 상태 기반 Task Detail 재구성

목표:

- 사용자가 다음에 무엇을 해야 하는지 상태별로 알 수 있게 한다.

작업:

- Task Detail을 상태 기반 primary action 중심으로 바꾼다.
- 현재 상태에서 가능한 role만 노출한다.
- 실행 불가 role은 숨기거나 "왜 막혔는지"를 표시한다.
- PlanApproval Pending이면 approval inbox뿐 아니라 task detail 상단에도 표시한다.
- run history를 role lane 형태로 묶는다.
- artifact viewer는 `summary`, `result`, `diff`, `logs`, `context` 탭으로 정리한다.

완료 기준:

- Planned task에서는 Planner 실행만 primary action으로 보인다.
- PlanApproval 승인 전 Coder 실행은 UI와 backend 양쪽에서 막힌다.
- MergeWaiting에서는 diff와 gate 결과가 먼저 보인다.

### Step 4. GateResult 모델 도입

목표:

- structured result와 실제 Git 상태를 이용해 role 결과를 판정한다.

추가 schema 후보:

```text
gate_results
```

최소 컬럼:

- `id`
- `project_id`
- `task_id`
- `run_id`
- `gate_type`
- `status`
- `summary`
- `payload_json`
- `created_at`

허용 gate type:

```text
PlanVerification
CodeReview
Test
DiffConsistency
MergeReadiness
```

허용 status:

```text
Pass
Fail
NeedsInspection
```

작업:

- `structured-result.json.gateResult`를 DB gate result로 승격한다.
- host runner가 계산한 `changed-files.json`, `diff.patch`와 agent가 보고한 `changedFiles`를 비교한다.
- 불일치하면 `NeedsInspection`으로 멈춘다.
- gate result를 Task Detail에 표시한다.

완료 기준:

- agent가 `changedFiles`를 비워두고 실제 diff가 있으면 Helm이 표시한다.
- schema는 pass지만 diff consistency가 깨지면 자동 진행하지 않는다.

### Step 5. Reviewer/Tester chain 완성

목표:

- Coder 이후가 단순 상태 전이가 아니라 실제 검증 단계가 되게 한다.

작업:

- `plan_verifier`, `code_reviewer`, `tester` role별 expected output contract를 분리한다.
- Context Pack에 role별 검토 기준을 넣는다.
- Tester는 role preset 외에 project check command를 우선 지원한다.
- 테스트 실행 결과를 `test-result.json` artifact로 남긴다.
- reviewer/tester 실패 시 task를 `Blocked`로 보내고 retry path를 안내한다.

추가 artifact 후보:

```text
review-findings.json
test-result.json
gate-result.json
```

완료 기준:

- Coder 성공 후 바로 MergeWaiting으로 가지 않고 PlanVerification -> CodeReview -> Testing을 거친다.
- Tester pass에서만 MergeWaiting으로 전이된다.

### Step 6. Merge readiness와 사용자 승인

목표:

- Helm이 실제 merge 전 마지막 판단 화면을 제공한다.

작업:

- `MergeApproval` approval type 추가 여부를 결정한다.
- MergeWaiting 상태에서 다음 정보를 한 화면에 모은다.
  - worktree branch/path
  - base branch/head
  - changed files
  - diff summary
  - latest run results
  - gate results
  - audit tail
- 아직 자동 merge는 하지 않고, merge command preview부터 구현한다.

추가 command 후보:

```text
get_merge_readiness(project_id, task_id)
preview_merge_commands(project_id, task_id)
```

완료 기준:

- 사용자가 MergeWaiting task를 열면 "왜 머지 가능한지"와 "무엇이 아직 막는지"를 확인할 수 있다.
- 실제 merge/push 없이도 다음 Git 명령이 명확히 제시된다.

### Step 7. 검증 보강

목표:

- core loop가 회귀하지 않도록 자동 테스트를 만든다.

작업:

- Rust DB/service 테스트를 추가한다.
  - task 생성
  - planner run
  - approval approve/reject
  - coder 실행 조건
  - host runner fixture
  - NeedsInspection fallback
  - retry/cancel 상태
- frontend typecheck 외에 주요 컴포넌트 단위 테스트 또는 Playwright smoke test를 추가한다.
- fixture runner script를 만든다.

fixture runner 요구:

```text
입력: HELM_* env
출력: summary.md, structured-result.json
옵션: pass/fail/needs_changes/schema_invalid/diff 생성
```

완료 기준:

- `npm run typecheck`
- `cargo test`
- fixture 기반 core loop smoke test

## 우선순위

바로 다음 작업 순서는 아래가 가장 낫다.

1. Step 2: fixture runner와 기본 preset
2. Step 3: 상태 기반 Task Detail
3. Step 7 일부: fixture core loop 테스트
4. Step 4: GateResult 모델
5. Step 5: Reviewer/Tester chain
6. Step 6: Merge readiness
7. Step 1: 문서 정렬은 각 단계 완료 시 같이 반영

이 순서가 좋은 이유는 현재 가장 큰 병목이 "기능이 없어서"가 아니라 "실제 태스크 하나를 자연스럽게 끝까지 돌릴 실행 경로가 없어서"이기 때문이다.

## 이번 계획에서 아직 제외하는 것

아래는 중요하지만 core loop가 닫힌 뒤 붙인다.

- Jira API sync
- Slack 알림
- Obsidian backfill 자동화
- Docker Hermes observer
- full interactive PTY
- 자동 merge/push/PR 생성
- multi-agent parallel execution
- 전역 최근 프로젝트 목록
- backup/recovery

## 구현 완료 판정

이 계획이 끝났다고 볼 수 있는 기준:

- Helm repo 자신을 대상으로 fixture runner core loop가 통과한다.
- 실제 Codex 또는 Claude runner template으로 최소 Planner -> PlanApproval -> Coder까지 동작한다.
- run artifact, gate result, audit log, worktree diff가 서로 어긋나지 않는다.
- 사용자가 Task Detail만 보고 다음 액션과 blocker를 알 수 있다.
- README와 Phase 문서가 현재 구현 상태와 다음 범위를 과장 없이 설명한다.
