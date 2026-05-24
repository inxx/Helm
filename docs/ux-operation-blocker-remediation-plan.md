# Helm UX / Operation Blocker Remediation Plan

작성일: 2026-05-25

## 목적

이 문서는 Helm의 현재 UX/운영 blocker를 "사용자가 무엇을 눌렀고, Helm이 무엇을 바꿨는지" 기준으로 정리한다. 핵심 목표는 관찰, 승인, 실행 준비, 실제 host 실행을 분리해 사용자가 의도하지 않은 worktree/run/AI 실행이 생기지 않게 하는 것이다.

## 레퍼런스 비교

확인한 레퍼런스:

- AI Factory: https://github.com/lee-to/ai-factory
- AI Factory quality gates: https://github.com/lee-to/ai-factory/blob/2.x/docs/quality-gates.md
- AI Factory plan files: https://github.com/lee-to/ai-factory/blob/2.x/docs/plan-files.md
- AIF Handoff: https://github.com/lee-to/aif-handoff

차용할 점:

- AI Factory처럼 계획과 gate 결과는 사람이 읽는 설명과 기계가 읽는 structured contract를 분리한다.
- AI Factory plan files처럼 artifact ownership을 명확히 두고, downstream 영향과 승인 근거를 추적한다.
- AIF Handoff처럼 자동 pipeline이 있더라도 수렴하지 않거나 실패하면 조용히 pass하지 않고 human handoff를 명시한다.

차용하지 않을 점:

- Helm의 기본값을 hands-off 자동 실행으로 바꾸지 않는다.
- 계획 승인 없이 구현 role을 시작하지 않는다.
- UI selection이나 detail mount가 backend mutation을 만드는 구조를 두지 않는다.

## P0 운영 계약

```text
Task 카드 클릭 = 읽기/선택만
Plan Document 승인 = Task materialize만
PlanApproval 승인 = TaskStatus Ready 전이만
실행 준비 = context-pack + queued run 생성
host 실행 = 실제 AI/CLI 실행, 파일 변경 가능
자동 handoff = 정책 UI가 생기기 전까지 기본 off
```

## 2026-05-25 적용한 차단 해소

- `approve_approval`은 approval decision과 TaskStatus 전이만 저장한다. 더 이상 승인 직후 다음 run을 자동 생성하지 않는다.
- `queue_next_role_after_success`는 `auto_handoff_enabled=false` 기본 정책에서 아무 다음 run도 만들지 않는다.
- queue worker와 supervisor reconciler는 P0 기본 정책에서 off다.
- `PlanningScreen.approvePlanDraft`는 Task 생성까지만 수행한다. `api.startNextRoleRun`을 호출하지 않는다.
- `TaskDetail`과 `ApprovalInbox` 문구에서 "자동 실행" 약속을 제거했다.
- DB 회귀 테스트로 PlanApproval 승인만으로 agent run이 늘지 않는 계약을 고정했다.

## 남은 blocker와 보완 순서

| 우선순위 | blocker | 보완 |
| --- | --- | --- |
| P0 | Planning session이 local state라 새로고침에 사라진다. | `planning_sessions`, `planning_messages`, `plan_drafts`, `planning_materializations` migration을 추가한다. |
| P0 | 자동화 정책이 코드 상수다. | `automationPolicy` project setting과 Settings UI를 추가하되 기본값은 manual로 둔다. |
| P0 | Task board가 최신 run/repair/approval 신호를 카드에 요약하지 못한다. | lightweight `TaskBoardSignalSummary` DTO를 추가한다. |
| P1 | gate 실패 후 targeted repair loop가 닫혀 있지 않다. | `repair_request -> coder repair run -> gate rerun` command를 분리한다. |
| P1 | MergeWaiting 이후 accept/merge decision이 약하다. | merge readiness DTO, command preview, approval basis를 추가한다. |

## 검증 체크리스트

- Task 카드를 클릭해도 worktree, context-pack, agent run이 생성되지 않는다.
- Plan Document 승인 후 Task는 생기지만 planner/coder run은 생기지 않는다.
- PlanApproval 승인 후 Task는 `Ready`가 되지만 coder run은 생기지 않는다.
- `실행 준비` 버튼을 눌렀을 때만 queued run이 생긴다.
- `host 실행` 버튼을 눌렀을 때만 실제 runner가 시작된다.
- `NeedsInspection`, `Failed`, `TimedOut`, `Canceled`는 자동 진행하지 않고 retry 또는 repair 판단을 요구한다.

## 2026-05-25 검증 기록

- `pnpm --dir apps/desktop typecheck`: 통과
- `pnpm --dir apps/desktop build`: 통과
- `cargo test` in `apps/desktop/src-tauri`: 통과, 26 tests
- `npm run check`: 실패. 현재 shell Node가 `v20.12.2`라 root legacy CLI의 `.ts` 직접 실행을 지원하지 않는다. root check는 Node 25 이상 shell에서 별도 실행한다.
- Browser smoke: Vite shell은 표시되지만 일반 browser에는 Tauri `invoke` bridge가 없어 launch state 호출 error banner가 뜬다. 실제 desktop runtime 검증은 Tauri 앱에서 확인해야 한다.
