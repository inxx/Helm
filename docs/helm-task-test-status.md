# Helm Task Test Status

작성일: 2026-05-19
브랜치: `feature/helm-cli-mvp`

## 목적

Helm 프로젝트 자체를 Helm의 태스크 운영 테스트 대상으로 사용한다.

지금 목표는 새 기능을 더 넓히는 것이 아니라, 현재 구현된 데스크톱 control plane으로 아래 질문에 답할 수 있는지 확인하는 것이다.

- 지금 작업이 어디까지 진행됐는가?
- 다음에 실행해야 할 액션은 무엇인가?
- 어떤 검증이 통과했고, 어떤 검증이 아직 약한가?
- 태스크 하나가 계획, 실행, 검토, 테스트, 머지 대기까지 추적 가능한가?

## 현재 완료 상태

### Legacy CLI MVP

상태: 완료

완료된 범위:

- `inxx-helm` CLI 기본 명령
- agent dry-run/session 기록
- session show/diff/log
- safe commit dry-run/check
- PR dry-run/create 흐름
- repo-local `.helm/config.json`
- legacy local UI

검증:

- 2026-05-19 `npm run check` 통과
- Node test 33개 통과

### Desktop Phase 1

상태: 완료

완료된 범위:

- `apps/desktop` Tauri 앱 scaffold
- Git repo 열기
- repo-local SQLite DB 생성/열기
- project settings 저장/로드
- Epic/Task/External Ref/Audit Log 기본 모델
- read-only Git snapshot
- 한국어 라이트 태스크/Git/Settings skeleton

### Desktop Phase 2

상태: 완료

완료된 범위:

- stub role run
- PlanApproval 생성/승인/거절
- run history
- approval inbox
- audit event 일부 기록

### Desktop Phase 3a 기반

상태: 기본 구현 완료, 검증 보강 필요

완료된 범위:

- task worktree 생성
- Context Pack 생성
- HelmHostRunner 단일 실행
- run artifact viewer
- timeout/retry/cancel
- 분할 pane 기반 기본 터미널 명령 실행기
- runner template command
- fixture/Codex/Claude runner preset
- runner health check command
- Settings UI의 template 적용/runner 확인
- Task Detail의 상태 기반 next action 기본 안내
- Terminal 화면의 pane별 project/worktree 명령 실행

검증:

- 2026-05-19 `cd apps/desktop && npm run build` 통과
- 2026-05-19 `npm run check` 통과

## 지금 테스트 가능한 흐름

### 1. 프로젝트 열기

목표:

- Helm 데스크톱 앱에서 이 저장소를 연다.
- `.helm/helm.sqlite`가 생성되고 snapshot이 표시되는지 확인한다.

확인 항목:

- 현재 브랜치 표시
- dirty file count 표시
- Task board 표시
- Settings 표시

### 2. Fixture runner 적용

목표:

- 실제 Codex/Claude 호출 없이 core loop를 검증한다.

확인 항목:

- Settings에서 `Fixture runner` template 적용
- `runner 확인` 결과가 모든 role에서 사용 가능으로 표시
- role preset JSON에 `fixture-runner.mjs` command가 들어간다.

### 3. 테스트용 Task 생성

권장 테스트 태스크:

```text
제목: Helm core loop fixture 검증
설명: Fixture runner로 planner, coder, verifier, reviewer, tester 흐름을 실행하고 artifact와 상태 전이를 확인한다.
외부 참조: PlainText / Helm dogfood task
```

확인 항목:

- Task가 `Planned`로 생성된다.
- Task Detail 상단에 Planner 실행이 primary action으로 보인다.

### 4. Planner와 PlanApproval

목표:

- 계획 생성 후 사용자 승인 대기 상태를 확인한다.

확인 항목:

- Planner stub 또는 fixture 실행 후 PlanApproval Pending 생성
- 승인 전에는 Coder 실행 흐름이 막힌다.
- 승인 후 Task가 `Ready`로 전이된다.

### 5. Coder 실행

목표:

- task worktree와 context pack을 만든 뒤 fixture coder를 실행한다.

확인 항목:

- task worktree branch/path 표시
- `context-pack.md` artifact 표시
- `summary.md`, `structured-result.json`, `stdout.log`, `stderr.log` 표시
- coder fixture가 만든 changed file과 `changed-files.json`, `diff.patch` 표시

### 6. 검토/테스트 체인

목표:

- Coder 이후 PlanVerification, CodeReview, Testing으로 이어지는지 확인한다.

확인 항목:

- 현재 상태에 맞는 다음 role만 primary action으로 제안된다.
- verifier/reviewer/tester artifact가 남는다.
- Tester pass 후 `MergeWaiting`까지 도달 가능한지 확인한다.

## 아직 남은 일

### P0. Runner onboarding 제품화

해야 할 일:

- 새 프로젝트에서 runner template 미적용 상태를 명확히 표시한다.
- Fixture runner를 기본 검증 경로로 안내한다.
- Codex/Claude runner는 실제 host 실행 경로로 분리해 표시한다.
- Task Detail에서 runner 미설정 시 Settings로 이동할 수 있게 한다.

완료 기준:

- 사용자가 JSON을 직접 보지 않고 fixture runner를 적용할 수 있다.
- runner가 없을 때 host 실행이 실패한 뒤에야 알게 되는 흐름이 사라진다.

### P0. Task Detail 제품 경로 정리

해야 할 일:

- 현재 상태에서 가능한 primary action만 기본 노출한다.
- `Context Pack` 전체 role 버튼과 `Stub role 실행` 전체 role 버튼은 개발/fixture 도구 영역으로 이동한다.
- Context Pack 생성과 host 실행을 하나의 실행 흐름으로 묶는다.
- Pending approval, Queued run, Failed/NeedsInspection run의 복구 액션을 상태별로 분리한다.

완료 기준:

- 사용자가 Task Detail만 보고 다음에 누를 버튼을 판단할 수 있다.
- Stub runner와 실제 host runner가 제품 화면에서 혼동되지 않는다.

### P0. Core loop acceptance test

해야 할 일:

- fixture runner로 전체 흐름을 재현하는 자동화 테스트를 추가한다.
- 최소 시나리오는 `Planned -> Ready -> PlanVerification -> CodeReview -> Testing -> MergeWaiting`이다.
- artifact, diff, approval, audit log까지 함께 검증한다.

완료 기준:

- 실제 Codex/Claude 없이도 core loop가 깨지면 테스트가 실패한다.

### P0. GateResult 모델

해야 할 일:

- `gate_results` schema 추가
- `DiffConsistency` gate 추가
- structured result의 `changedFiles`와 실제 Git diff 비교
- 불일치 시 `NeedsInspection`으로 멈춤
- exit code, schema validation, result status, diff consistency를 별도 판정으로 남김

완료 기준:

- agent 보고와 실제 diff가 다르면 자동 진행하지 않는다.
- 자동 상태 전이는 gate pass 근거를 UI에서 설명할 수 있다.

### P0. Reviewer/Tester 계약 강화

해야 할 일:

- role별 expected output contract 분리
- `review-findings.json`
- `test-result.json`
- tester용 project check command 우선 지원
- 실패 시 `Blocked` 전이와 retry 안내
- Plan Verifier는 승인된 계획과 실제 diff 비교
- Code Reviewer는 severity와 merge blocker 여부 구조화
- Tester는 check command 결과를 gate result로 저장

완료 기준:

- Coder 성공만으로 MergeWaiting에 가지 않는다.
- Tester pass에서만 MergeWaiting으로 전이된다.
- review/test 실패 시 어떤 role을 다시 실행해야 하는지 표시된다.

### P1. Merge readiness

해야 할 일:

- `get_merge_readiness(project_id, task_id)` command 후보 구현
- worktree branch/path/head
- changed files와 diff summary
- merge command preview
- merge approval 도입 여부 결정
- gate result와 run status 기반 blocker 목록 표시
- task worktree diff를 Git 화면과 연결

완료 기준:

- MergeWaiting 화면에서 사용자가 머지 가능 여부와 blocker를 판단할 수 있다.

### P1. Planning Workspace

해야 할 일:

- `Planning` 탭 추가
- planning session/draft DB skeleton
- 목표 입력
- Plan Draft preview
- 승인된 draft를 Epic/Task로 materialize

완료 기준:

- Jira ticket 없이도 Helm 안에서 목표를 Task로 만들 수 있다.

### P1. 문서 정렬

해야 할 일:

- README 현재 상태를 Phase 3a 기준으로 갱신
- `generic shell execute 금지`와 터미널 실행기 정책을 분리해 설명
- Phase 3a 문서에서 완료와 검증 보강 필요 항목을 분리

완료 기준:

- 문서만 보고도 구현 완료, 기본 구현, 미구현이 구분된다.

## 바로 다음 실행 순서

1. README와 Phase 문서에서 현재 구현/제품화 필요/미구현 범위를 정렬한다.
2. Runner template 미적용 상태를 Task Detail과 Settings에서 명확히 안내한다.
3. Task Detail을 primary action 중심으로 정리하고 stub/debug 버튼을 접는다.
4. 데스크톱 앱에서 Helm repo를 열고 Fixture runner template을 적용한다.
5. `Helm core loop fixture 검증` 태스크를 만든다.
6. Planner 실행과 PlanApproval 승인까지 확인한다.
7. Coder fixture 실행으로 worktree diff와 artifact 수집을 확인한다.
8. verifier/reviewer/tester 흐름이 실제로 MergeWaiting까지 이어지는지 수동 테스트한다.
9. 수동 테스트에서 끊기는 지점을 P0 자동화 테스트로 고정한다.
10. GateResult와 DiffConsistency를 추가해 자동 전이 조건을 강화한다.

## 현재 위험

- Task Detail에 next action 안내는 생겼지만, 모든 role 버튼이 아직 별도 섹션에 같이 노출된다.
- Stub role과 Host role의 제품상 의미가 UI에서 명확히 분리되지 않는다.
- runner template을 적용하지 않은 새 프로젝트의 첫 실행 경험이 약하다.
- backend 상태 전이와 UI 안내가 완전히 같은 규칙을 공유하는지 추가 검증이 필요하다.
- GateResult가 없어서 schema pass와 실제 diff 불일치를 아직 강하게 막지 못한다.
- 실패/NeedsInspection 이후의 복구 경로가 task detail에 충분히 설명되지 않는다.
- MergeWaiting 이후의 commit/merge/push는 아직 구현 범위 밖이다.
- Planning Workspace는 문서 계획만 있고 앱 화면/DB 모델은 아직 없다.
