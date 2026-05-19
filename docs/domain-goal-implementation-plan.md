# Helm Domain Goal Implementation Plan

작성일: 2026-05-19

## 목적

Helm의 큰 목표를 도메인별 기능으로 나누고, 현재 구현 위에 어떤 순서로 적용할지 정리한다.

큰 목표는 아래 하나로 수렴한다.

```text
로컬 repo에서 사용자의 목표를 AI와 실행 가능한 계획으로 만들고,
그 계획에서 나온 태스크 하나를 승인, 실행, 검토, 테스트, 머지 대기까지 추적 가능한 상태로 운영한다.
```

따라서 도메인별 기능은 많은 화면을 늘리는 방향이 아니라, `Planning -> Task core loop`를 끊기지 않게 만드는 순서로 적용한다.

## 도메인 0. Planning Workspace

목표:

- 사용자가 AI와 대화하면서 프로젝트 목표를 Epic/Task/Plan 초안으로 구체화할 수 있어야 한다.
- 정리된 Jira ticket이나 기존 Task가 없어도 Helm 안에서 작업 시작이 가능해야 한다.
- 승인된 계획 초안만 실제 Helm Task로 생성되어야 한다.

현재 상태:

- Task 생성과 실행 core loop는 있다.
- 사용자가 AI와 계획을 세우는 별도 화면은 없다.
- 계획 대화, draft, 승인 이력이 Task 생성 근거로 남지 않는다.

적용 기능:

- `Planning` 도메인 탭
- planning session 목록
- 목표 입력과 planning conversation
- repo context summary panel
- Plan Draft preview
- Epic/Task/Subtask/Acceptance Criteria/Risk/Test Plan 초안
- Plan Draft 승인
- 승인된 draft의 Epic/Task materialize
- planning 대화와 승인 audit 기록

완료 기준:

- 사용자는 빈 상태에서 Planning 탭으로 시작할 수 있다.
- 목표를 입력하면 planning session과 plan draft가 생성된다.
- 승인된 draft만 실제 Epic/Task로 저장된다.
- 생성된 Task는 기존 Task Detail core loop로 이어진다.
- 어떤 대화와 draft에서 Task가 생성됐는지 추적할 수 있다.

상세 계획:

- `docs/ai-planning-workspace-plan.md`

## 도메인 1. Task Orchestration

목표:

- 사용자가 Task Detail만 보고 다음 액션과 blocker를 알 수 있어야 한다.
- AI role 실행 버튼이 단순 나열되지 않고 현재 상태에 맞게 하나의 primary action으로 보여야 한다.

현재 상태:

- Task board와 Task Detail이 있다.
- 모든 role 버튼이 상태와 무관하게 노출된다.
- backend는 상태별 role 실행을 일부 제한한다.

적용 기능:

- 상태별 next action 계산
- `Planned`: Planner 실행
- `PlanApproval Pending`: 승인 대기 표시
- `Ready`: worktree 준비 또는 Coder 실행
- `PlanVerification`: 계획 검토자 실행
- `CodeReview`: 코드 리뷰어 실행
- `Testing`: 테스트 담당자 실행
- `MergeWaiting`: merge readiness 확인
- 실행 불가 사유 표시
- run history를 role lane으로 그룹화

완료 기준:

- UI에서 불가능한 role 실행 버튼이 primary action으로 보이지 않는다.
- 사용자는 Task Detail 상단만 보고 다음 행동을 결정할 수 있다.

## 도메인 2. Runner & Role Presets

목표:

- 사용자가 raw JSON을 직접 작성하지 않아도 host runner를 실행할 수 있어야 한다.
- 실제 Codex/Claude가 없어도 fixture runner로 core loop를 검증할 수 있어야 한다.

현재 상태:

- `rolePresets` JSON 저장은 가능하다.
- host runner는 command가 없으면 실행할 수 없다.

적용 기능:

- runner template 목록
- fixture runner template
- Codex CLI template
- Claude CLI template
- template 적용 command
- role runner health check
- Settings UI에서 template 적용과 확인

완료 기준:

- 새 프로젝트에서 fixture runner template을 적용하고 Planner/Coder 흐름을 실행할 수 있다.
- Codex/Claude command 존재 여부를 Settings에서 확인할 수 있다.

## 도메인 3. Artifact & Gate

목표:

- AI가 보고한 결과와 Helm이 직접 계산한 Git diff가 서로 맞는지 확인한다.
- schema가 맞아도 실제 diff와 불일치하면 자동 진행하지 않는다.

현재 상태:

- `summary.md`, `structured-result.json`, `stdout.log`, `stderr.log`, `changed-files.json`, `diff.patch`가 저장된다.
- structured result 검증은 최소 필드 체크 수준이다.

적용 기능:

- `gate_results` schema
- `DiffConsistency` gate
- `PlanVerification`, `CodeReview`, `Test`, `MergeReadiness` gate
- gate result artifact 저장
- Task Detail에서 gate 결과 표시

완료 기준:

- 실제 changed files와 structured result의 `changedFiles`가 불일치하면 `NeedsInspection`으로 멈춘다.
- MergeWaiting 진입 전 gate 결과를 확인할 수 있다.

## 도메인 4. Review & Test Chain

목표:

- Coder 성공 후 바로 완료가 아니라 계획 검토, 코드 리뷰, 테스트를 거쳐야 한다.

현재 상태:

- 상태 전이는 있다.
- reviewer/tester의 결과 계약은 얇다.

적용 기능:

- role별 expected output contract 분리
- `review-findings.json`
- `test-result.json`
- tester용 check command 우선 지원
- 실패 시 Blocked 전이와 retry 안내

완료 기준:

- `Coder -> PlanVerification -> CodeReview -> Testing -> MergeWaiting` 흐름이 fixture runner로 검증된다.
- Tester pass에서만 MergeWaiting으로 전이된다.

## 도메인 5. Git & Merge Readiness

목표:

- merge 전 사용자가 변경 내용과 gate 상태를 한 화면에서 판단할 수 있어야 한다.

현재 상태:

- read-only Git snapshot과 worktree 생성은 있다.
- commit/merge/push는 없다.

적용 기능:

- `get_merge_readiness(project_id, task_id)`
- worktree branch/path/head 표시
- changed files와 diff summary 표시
- merge command preview
- merge approval 도입 여부 결정

완료 기준:

- MergeWaiting Task에서 merge 가능 여부와 blocker를 확인할 수 있다.
- 자동 merge 없이도 사용자가 실행할 명령이 명확히 보인다.

## 도메인 6. Terminal

목표:

- 작업자가 프로젝트 root 또는 task worktree에서 필요한 검증 명령을 직접 실행할 수 있어야 한다.

현재 상태:

- 기본 `/bin/zsh -lc` 명령 실행기가 있다.
- full PTY는 없다.

적용 기능:

- 터미널 실행기를 "개발자 명시 실행 도구"로 문서화
- runner command와 권한 모델 분리
- 최근 실행 기록 DB 저장 여부 결정
- full PTY는 core loop 이후로 보류

완료 기준:

- 터미널이 agent runner와 혼동되지 않는다.
- task worktree에서 command 실행 결과를 확인할 수 있다.

## 도메인 7. External References

목표:

- Jira 없이도 동작하고, Jira/Markdown/URL이 있으면 추적 정보로 연결한다.

현재 상태:

- `task_external_refs`가 있다.
- Jira API 연동은 없다.

적용 기능:

- external ref 표시 개선
- MarkdownPlan 경로 open/preview 후보
- Jira API sync는 core loop 이후로 보류

완료 기준:

- Jira 없는 작업과 Jira 있는 작업이 같은 core loop를 탄다.
- 외부 참조가 Helm 상태 머신을 대체하지 않는다.

## 도메인 8. Audit & Documentation

목표:

- 상태 전이, 승인, runner 실행, gate 결과가 나중에 추적 가능해야 한다.

현재 상태:

- audit log table과 일부 event 기록이 있다.
- README와 Phase 문서가 최신 구현을 완전히 반영하지 않는다.

적용 기능:

- audit event taxonomy 정리
- runner template 적용, health check, gate result 기록 여부 결정
- README 현재 상태 업데이트
- Phase 3a 문서의 완료/검증 상태 재정렬

완료 기준:

- 문서가 구현 상태를 과장하지 않는다.
- core loop의 중요한 결정이 audit 또는 artifact로 남는다.

## 실행 순서

1. Planning Workspace skeleton
2. Planning Session / Plan Draft DB skeleton
3. Manual Plan Draft MVP
4. Runner & Role Presets
5. Task Orchestration
6. Review & Test Chain fixture path
7. Artifact & Gate
8. Git & Merge Readiness
4. Artifact & Gate
5. Git & Merge Readiness
6. Terminal 정책 정리
7. External References 표시 보강
8. Audit & Documentation 정렬

## 1차 적용 범위

이번 바로 다음 구현은 도메인 2부터 닫는다.

구체 범위:

- fixture runner 추가
- runner template command 추가
- Settings UI template 적용
- runner health check
- 빌드/테스트 검증

그 다음 도메인 1에서 Task Detail을 상태 기반 primary action으로 재구성한다.

## 병렬 디자인 작업 중 적용 규칙

2026-05-19 현재 다른 에이전트가 디자인 수정을 병렬 진행 중이다. 충돌을 줄이기 위해 디자인 작업이 끝날 때까지 아래 파일은 추가 수정하지 않는다.

- `apps/desktop/src/App.tsx`
- `apps/desktop/src/components/*`
- `apps/desktop/src/screens/*`
- `apps/desktop/src/styles.css`
- `apps/desktop/src-tauri/icons/*`
- `apps/desktop/src-tauri/tauri.conf.json`

이 기간에 진행할 수 있는 작업:

- Rust backend command
- DB migration과 service 테스트
- fixture runner
- 문서 계획 보강
- core loop acceptance test

단, backend command의 frontend wiring은 디자인 병합 이후 한 번에 맞춘다.
