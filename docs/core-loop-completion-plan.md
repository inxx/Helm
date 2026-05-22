# Helm Core Loop Completion Plan

작성일: 2026-05-19
업데이트: 2026-05-22, Hive/MagesticAI 블로커 참고 원칙, P0-04 evidence/gate timeline/repair, role별 Context Pack contract, coder diff consistency gate, retry UX, fixture core loop 테스트, task worktree 변경 파일 UI, gateResult 검증 강화 반영

## 목적

현재 구현은 Phase 3a의 기반 기능까지 들어왔지만, 완성 제품의 핵심 목표인 "AI 개발 작업을 계획, 실행, 검토, 테스트, 승인, 머지까지 관리하는 데스크톱 control plane"으로 보기에는 아직 core loop가 얇다.

이 문서는 지금 구현을 버리지 않고, 사용자가 태스크 하나를 실제로 끝까지 운영할 수 있게 만드는 추가 작업 계획이다.

## 구현 진행 현황

2026-05-22 기준:

- 완료: P0-02 Runner onboarding 1차 구현. Settings의 Runner Templates 화면에서 역할별 runner 준비 상태, 활성 AI CLI 연결 수, template 적용 필요 여부를 확인할 수 있다.
- 완료: P0-03 Task Detail 제품 경로 1차 구현. 다음 액션은 runner 설정, worktree 준비, Context Pack 생성, host 실행, merge 준비 확인 순서로 노출된다.
- 완료: P0-04 Evidence/Gate timeline 1차 구현. Host run 완료 시 command evidence, gate result, repair request를 구조화해 저장하고 Task Detail에서 결정 타임라인으로 확인할 수 있다.
- 완료: Blocking gate 보강. `gateResult.blocking=true` 또는 fail/needs_inspection gate는 role 성공 전이를 막고 `NeedsInspection` 상태와 repair request를 남긴다.
- 완료: Role별 Context Pack contract 1차 구현. planner/coder/plan_verifier/code_reviewer/tester의 목표, pass 조건, blocking 조건, 금지사항, gate를 context-pack 본문과 manifest에 포함한다.
- 완료: Coder diff consistency gate 1차 구현. coder가 `status=pass`를 보고해도 structured result의 `changedFiles`와 실제 Git diff가 다르면 `rules` gate fail과 repair request를 남기고 상태 전이를 막는다.
- 완료: Retry UX 1차 구현. 최신 active role run이 `Failed`, `TimedOut`, `NeedsInspection`, `Canceled`이면 Task Detail의 다음 액션에서 타임라인 확인과 retry 준비로 이어진다.
- 완료: Fixture core loop 회귀 테스트. fixture host runner만으로 planner, approval, coder, plan verifier, code reviewer, tester를 거쳐 `MergeWaiting`까지 도달하는 경로를 검증한다.
- 완료: Task worktree 변경 파일 UI. Task Detail의 Git 탭에서 프로젝트 루트가 아니라 해당 task worktree의 변경 파일을 파일 단위로 확인할 수 있다.
- 완료: structured-result 검증 강화. `gateResult` object가 schema의 핵심 필수 필드와 enum을 만족하지 않으면 `NeedsInspection`으로 처리된다.
- 유지: 개발용 context/stub role 버튼은 제품 primary path에서 제외하고 실행 탭의 접힌 개발 도구 안에만 둔다.
- 검증: `cargo test`, `npm run typecheck`, `npm run build`, 루트 `npm run check` 통과.

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
- xterm 기반 분할 PTY 터미널과 Node runtime 선택

기능적으로 미비한 점:

- Task 생성 전 단계가 약하다. 사용자가 자연어 목표나 Jira 링크를 넣고 plan draft를 만든 뒤 Epic/Task로 확정하는 Planning Workspace가 아직 제품 경로로 닫히지 않았다.
- 새 프로젝트의 기본 설정만으로 실제 runner 실행까지 이어지지 않는다. fixture/Codex/Claude template은 있지만 기본 role preset은 실행 command가 비어 있어 사용자가 먼저 template을 이해하고 적용해야 한다.
- Task Detail이 상태 기반 primary action을 일부 제공하지만, 모든 Context Pack/Stub role 버튼이 함께 노출되어 사용자가 현재 가능한 작업과 디버그용 작업을 구분해야 한다.
- Stub role과 Host role이 병렬로 노출된다. 데모/검증용 stub과 실제 host runner의 제품 의미가 UI에서 분리되지 않아 완성 제품처럼 느껴지지 않는다.
- Context Pack은 role별 contract를 포함한다. 아직 승인된 계획/이전 run/test 로그를 자동 요약해 role별로 선별하는 단계는 남아 있다.
- reviewer/tester chain은 상태 이름은 있지만 검증 계약이 약하다. 리뷰 finding, 테스트 결과, gate 판정이 별도 DB 모델로 남지 않는다.
- coder pass 경로는 실제 Git diff와 structured result의 `changedFiles`를 비교한다. 아직 reviewer/tester의 실제 command result와 gate 판정을 더 강하게 연결해야 한다.
- 실패/차단 흐름은 retry 준비까지 연결된다. 아직 Blocked 전이, repair request 상세 화면, handoff record는 남아 있다.
- MergeWaiting 이후가 비어 있다. merge readiness, base/head 비교, diff 요약, blocker, merge command preview, merge approval이 없다.
- Git 화면은 project-level read-only viewer에 머문다. task worktree branch/path/diff와 Git 화면이 연결되지 않는다.
- Terminal은 xterm 기반 분할 PTY까지 가능하다. 아직 workflow preset, task workflow와 연결된 test/check 실행, 결과 저장, audit 연결, launch diagnostics는 약하다.
- Audit log는 쌓이지만 사용자 의사결정 화면으로 정리되지 않는다. approval, run, gate, status transition을 한 태스크 타임라인으로 읽기 어렵다.
- 테스트가 migration/path/schema 수준이라 핵심 사용자 플로우를 보호하지 못한다. fixture runner 기반 end-to-end core loop 테스트가 없다.
- README와 Phase 문서가 현재 구현 범위와 남은 기능을 같은 기준으로 설명하지 못한다.

## 외부 레퍼런스 검토 반영

검토 기준:

- Helm의 source of truth는 로컬 프로젝트와 `.helm/helm.sqlite`다.
- 사용자 승인, Git diff, gate 판정, 다음 role 결정은 Helm backend가 소유한다.
- 외부 프로젝트는 코드 복사보다 제품 패턴, 보안 경계, 데이터 계약을 차용한다.
- Envoy 공개 repo는 proprietary 배포/문서 repo다. 코드 차용 대상이 아니라 shared context/authority 모델만 참고한다.
- Hermes Desktop은 MIT지만 SwiftUI/macOS 네이티브 앱이므로 Tauri/React/Rust 구조에 맞는 패턴만 선별한다.

### Envoy에서 차용할 것

| 차용 항목 | Helm 적용 | 우선순위 |
| --- | --- | --- |
| Shared context space 모델 | Task 하나를 단순 카드가 아니라 messages, decisions, evidence, approvals, handoff를 가진 작업 공간으로 취급한다. | P0 |
| Command Evidence | role run, test, git command, check command 결과를 명령/작업 디렉터리/exit code/요약/산출물 hash로 남긴다. | P0 |
| Decision/Approval Record | PlanApproval, MergeApproval, 위험 명령 승인에 approver, basis, conditions, remaining risk를 저장한다. | P0 |
| Provenance와 audit | 어떤 role이 어떤 artifact와 diff를 근거로 다음 상태로 갔는지 gate result와 audit timeline에서 추적한다. | P0 |
| Authority refresh 원칙 | message text가 권한이 아니며, 로컬 사용자 지시/승인 상태/task state/role scope를 mutation 전 다시 확인한다. | P0 |
| Repo Conductor skill의 역할 분리 | Builder, Reviewer, Verifier, Human Approver를 Helm role lane과 review/gate 화면에 반영한다. | P0 |
| Objection/Repair record | review/test 실패를 덮어쓰지 않고 objection, required repair, status로 보존한다. | P0 |
| Handoff record | task가 Blocked, MergeWaiting, Done일 때 "현재 상태/남은 risk/다음 명령"을 재개 가능한 형태로 남긴다. | P1 |
| Shared Brain record | 프로젝트 운영 지식, 사용자 선호, 반복 결정은 source와 confidence를 가진 memory record로 남긴다. | P2 |
| Bounded MCP adapter | 향후 `helm-mcp`는 stdio JSON-RPC, allowlist tool, pinned project/profile, timeout, stderr diagnostics, 환경 변수 allowlist만 허용한다. | P2 |
| Local-only 기본값 | cross-machine/relay/초대 기반 협업은 기본값이 아니며, 명시 요청 전까지 로컬 프로젝트 내부 상태만 사용한다. | P2 |
| Release checksum 검증 | 향후 CLI/desktop 배포 시 signed checksum manifest와 fail-closed installer 원칙을 참고한다. | P2 |

차용하지 않을 것:

- Envoy relay, Connected, billing, invite/capability crypto
- Envoy CLI/MCP binary나 proprietary repo 코드
- Helm을 Envoy space client로 강제하는 구조

### Hermes Desktop에서 차용할 것

| 차용 항목 | Helm 적용 | 우선순위 |
| --- | --- | --- |
| Direct source-of-truth 원칙 | 원격 기능을 붙이더라도 gateway/local mirror를 만들지 않고 대상 repo 또는 host 상태를 직접 읽는다. | P1 |
| Connection profile | SSH alias/host/user/port/profile/custom path를 Helm runner profile로 모델링한다. | P2 |
| Workspace fingerprint | project root, host, user, profile 조합으로 terminal/workflow/pinned state를 scope한다. | P1 |
| Service SSH와 terminal SSH 분리 | 원격 host runner는 no-TTY service command, 사용자가 조작하는 terminal은 별도 PTY로 분리한다. | P2 |
| SSH 실패 메시지 분류 | auth, host key, DNS, connection refused, timeout, python/path 문제를 사용자가 조치 가능한 문구로 나눈다. | P2 |
| Remote script payload wrapper | 원격 service command가 필요해지면 base64 JSON payload + shared helper + JSON stdout 계약을 사용한다. | P2 |
| 안전한 파일 편집 | UTF-8 검증, 크기 제한, symlink 검사, content hash conflict, atomic write, fsync를 plan/config 편집에 적용한다. | P0 |
| Workflow preset | 반복 prompt/check/role 실행 조합을 프로젝트 scope로 저장하고 terminal 또는 host runner로 실행한다. | P1 |
| Workflow launch diagnostics | preset 실행 시 prompt hash, normalized prompt, delivery mode, terminal start/exit 이벤트를 최신 로그에 남긴다. | P1 |
| Session pin/search | run/session history에서 중요한 실행을 pin하고 prompt, artifact, status로 검색한다. | P1 |
| Usage breakdown | role/provider/model별 token/실행 시간/상태 trend를 Settings 또는 Usage 화면에 표시한다. | P2 |
| Update check | GitHub Releases metadata 조회는 opt-in/저빈도, 자동 설치 없이 알림만 제공한다. | P2 |
| Release manifest | desktop zip, app metadata, architecture, checksum을 manifest로 만들고 verify script를 제공한다. | P2 |
| Storage permission | local preference, connection profile, diagnostics는 private permission 또는 OS secret store 정책을 문서화한다. | P1 |
| 테스트 전략 | transport/model/service/fixture/launch diagnostics 단위 테스트를 Rust/TS 테스트로 대응한다. | P0 |

차용하지 않을 것:

- SwiftUI/SwiftTerm UI 코드와 macOS-only native 구조
- Hermes 전용 Kanban/Cron/Skills 화면을 그대로 복제하는 것
- 원격 host를 Helm의 기본 운영 모델로 바꾸는 것
- Hermes Desktop의 updater나 release trust 설명을 Helm에 맞지 않게 과장하는 것

### 구현 중 블로커 대응 원칙

구현 중 특정 영역에서 막히면, 먼저 Helm의 source of truth와 현재 상태 머신을 확인한 뒤 유사 프로젝트가 같은 문제를 어떻게 해결했는지 파일 단위로 확인한다. 확인 결과는 코드 복사가 아니라 Helm 구조에 맞춘 해결책으로 재설계한다.

참고 기준:

- Hive는 PTY lifecycle, CLI agent bootstrap, session resume, local runtime guard, workspace/task protocol, dispatch/report ledger, terminal streaming 문제에서 우선 참고한다.
- MagesticAI는 spec/task lifecycle, worktree isolation, planner/coder/QA 흐름, test discovery, security scan, QA signoff, merge readiness, multi-provider 설정 문제에서 우선 참고한다.
- 라이선스가 다른 저장소의 코드는 복사하지 않는다. 필요한 경우 문제 정의, 데이터 계약, failure mode, UX 흐름, 테스트 전략만 차용한다.
- 참고 후에는 "어떤 문제로 막혔는지", "어느 프로젝트의 어떤 방식을 확인했는지", "Helm에는 왜 다르게 적용했는지"를 구현 PR 또는 작업 노트에 남긴다.

## 기능 갭 인벤토리

| 영역 | 현재 상태 | 미비점 | 우선순위 |
| --- | --- | --- | --- |
| 시작/계획 | Task 수동 생성, external ref 저장 | Planning Workspace와 draft approval 없음 | P1 |
| Runner onboarding | template command와 health check 있음 | 새 프로젝트 기본값만으로 실행 불가 | P0 |
| Task Detail | next action 기본 안내 있음 | 제품 액션과 디버그 버튼이 섞임 | P0 |
| Role 실행 | stub run, host run 모두 가능 | stub/host 의미 분리와 실행 모드 선택 부족 | P0 |
| Context Pack | role별 목표/pass/blocking/금지/gate contract 생성 | 승인 계획, 이전 run, 테스트 로그 선별 포함 필요 | P0 |
| Gate 판정 | schema/exit code/pass, explicit gate result, coder diff consistency 기반 | reviewer/tester 실제 command gate 강화 필요 | P0 |
| 실패 처리 | retry/cancel 일부 있음 | 실패 이유별 next action과 Blocked 전이 약함 | P0 |
| Merge readiness | 상태값만 있음 | readiness command/UI/approval/preview 없음 | P1 |
| Git 연계 | project git viewer와 task worktree 변경 파일 표시 있음 | diff preview, merge readiness command, merge approval 필요 | P1 |
| Terminal | xterm 기반 분할 PTY | workflow preset, tester/check artifact, audit 연결, launch diagnostics 없음 | P1 |
| Audit/Timeline | run, approval, command evidence, gate, repair request 타임라인 표시 | decision basis/handoff record 확장 필요 | P1 |
| 자동 검증 | fixture core loop와 gate failure 회귀 테스트 있음 | UI/e2e smoke와 merge readiness 테스트 필요 | P0 |
| Evidence/Decision | run artifact, approval, command evidence, gate/repair 일부 구조화 | decision basis, handoff record 확장 필요 | P0 |
| 안전한 문서/설정 편집 | artifact viewer 중심 | plan/config/context 편집 시 stale conflict/atomic write 계약 없음 | P0 |
| Workflow preset | runner template만 있음 | 반복 작업 프리셋과 실행 diagnostics 없음 | P1 |
| Session/Run 탐색 | task detail run list | pin/search/filter가 없음 | P1 |
| Usage | tokenBudget 설정 후보만 있음 | role/provider/model별 사용량 집계 화면 없음 | P2 |
| MCP/외부 agent 연동 | 없음 | allowlist 기반 `helm-mcp` tool surface 없음 | P2 |
| 원격 host profile | 로컬 host 중심 | SSH profile, failure diagnostics, service/terminal 분리 계약 없음 | P2 |
| 배포 검증 | 개발 빌드 중심 | release manifest/checksum/update check 정책 없음 | P2 |

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
13. 사용자는 command evidence, decision basis, handoff record를 보고 왜 이 상태가 되었는지 재구성할 수 있다.
```

이 시나리오는 실제 Codex/Claude가 없어도 fixture runner로 검증 가능해야 하고, 로컬에 Codex/Claude가 있으면 실제 runner로도 검증 가능해야 한다.

## 업데이트된 구현 단계

### Step 0. 기능 범위 잠금과 문서 정렬

목표:

- README와 Phase 문서가 현재 구현 범위와 남은 기능 범위를 정확히 설명하게 한다.
- `generic shell execute 금지`와 기본 터미널 실행기 추가 사이의 정책 충돌을 정리한다.
- stub runner, fixture runner, host runner의 제품상 의미를 분리한다.

작업:

- README의 현재 상태를 Phase 3a 기준으로 갱신한다.
- 기본 터미널 실행기는 "개발자 명시 실행 도구"로 분류하고, agent runner와 권한 모델을 분리해 문서화한다.
- `docs/phase-3a-implementation-plan.md`의 "구현 완료" 항목 중 검증이 부족한 항목은 "기본 구현 완료, 제품화 필요"로 조정한다.
- 다음 구현 기준 문서를 이 문서로 연결한다.
- Envoy/Hermes Desktop에서 차용하는 항목과 차용하지 않는 항목을 이 문서와 `orchestrator-design.md`에 고정한다.

완료 기준:

- 문서만 보고도 현재 구현, 미구현, 다음 작업 우선순위가 구분된다.

### Step 1. Runner onboarding 완성

목표:

- 사용자가 JSON을 직접 작성하지 않아도 host runner를 시작할 수 있게 한다.
- 새 프로젝트를 연 뒤 fixture runner로 core loop를 바로 검증할 수 있게 한다.

작업:

- `rolePresets` 기본값을 빈 provider 목록으로 두되, 첫 실행 전 Settings에서 template 적용을 명시적으로 안내한다.
- fixture runner template을 가장 앞에 두고 "로컬 검증용"으로 라벨링한다.
- Codex/Claude template은 "실제 host 실행"으로 분류하고 인증/설치 실패 메시지를 분리한다.
- Task Detail에서 role 실행이 막힐 때 "runner template 미적용"을 정확히 표시한다.
- `check_role_runner` 결과를 Task Detail의 실행 전 조건에도 노출한다.

추가 command 후보:

```text
list_runner_templates(project_id)
check_role_runner(project_id, role_id)
apply_runner_template(project_id, template_id)
```

완료 기준:

- 새 프로젝트에서 fixture runner template을 적용하고 Planner/Coder 실행을 끝까지 돌릴 수 있다.
- Codex/Claude가 설치된 환경에서는 health check가 성공/실패 이유를 명확히 보여준다.
- runner가 없으면 host 실행 버튼이 막히고, Settings로 이동할 수 있다.

### Step 2. Task Detail을 제품 경로 중심으로 재구성

목표:

- 사용자가 다음에 무엇을 해야 하는지 상태별로 알 수 있게 한다.
- 제품 실행 경로와 디버그/개발자 도구를 분리한다.

작업:

- Task Detail을 상태 기반 primary action 중심으로 바꾼다.
- 현재 상태에서 가능한 role만 노출한다.
- 실행 불가 role은 숨기거나 "왜 막혔는지"를 표시한다.
- PlanApproval Pending이면 approval inbox뿐 아니라 task detail 상단에도 표시한다.
- run history를 role lane 형태로 묶는다.
- artifact viewer는 `summary`, `result`, `diff`, `logs`, `context` 탭으로 정리한다.
- Stub role 실행은 기본 화면에서 숨기고 "개발/fixture 도구" 영역으로 이동한다.
- Context Pack 생성과 host 실행을 하나의 primary flow로 묶는다.
- `Queued` run이 있으면 새 context 생성 대신 기존 run 실행/취소/삭제 선택지를 보여준다.
- `Blocked`, `NeedsInspection`, `Failed`, `TimedOut`, `Canceled` 상태별 복구 액션을 분리한다.

완료 기준:

- Planned task에서는 Planner 실행만 primary action으로 보인다.
- PlanApproval 승인 전 Coder 실행은 UI와 backend 양쪽에서 막힌다.
- MergeWaiting에서는 diff와 gate 결과가 먼저 보인다.
- 사용자는 전체 role 버튼 목록을 보지 않고도 다음 작업을 진행할 수 있다.

### Step 3. GateResult, EvidenceRecord, DecisionRecord 도입

목표:

- structured result와 실제 Git 상태를 이용해 role 결과를 판정한다.
- role 실행과 사용자 승인의 근거를 재개 가능한 evidence/decision record로 남긴다.

추가 schema 후보:

```text
gate_results
evidence_records
decision_records
handoff_records
```

`gate_results` 최소 컬럼:

- `id`
- `project_id`
- `task_id`
- `run_id`
- `gate_type`
- `status`
- `summary`
- `payload_json`
- `created_at`

`evidence_records` 최소 컬럼:

- `id`
- `project_id`
- `task_id`
- `run_id`
- `evidence_type`
- `command`
- `cwd`
- `exit_code`
- `summary`
- `artifact_path`
- `artifact_sha256`
- `created_at`

`decision_records` 최소 컬럼:

- `id`
- `project_id`
- `entity_type`
- `entity_id`
- `approval_id`
- `decision`
- `basis`
- `conditions`
- `remaining_risk`
- `created_at`

`handoff_records` 최소 컬럼:

- `id`
- `project_id`
- `task_id`
- `status`
- `current_summary`
- `next_action`
- `open_risks_json`
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
- `exit_code`, schema validation, result status, diff consistency를 별도 gate로 남긴다.
- gate 실패 시 task 상태를 자동 전이하지 않고 run status와 task blocker를 분리해 표시한다.
- 모든 host runner/check/git command는 command evidence로 남긴다.
- approval 승인/거절 시 사용자가 입력한 사유를 decision basis로 승격한다.
- Blocked, MergeWaiting, Done 전이 시 handoff record를 생성한다.
- Task Detail timeline에서 gate/evidence/decision/handoff를 함께 읽을 수 있게 한다.

완료 기준:

- agent가 `changedFiles`를 비워두고 실제 diff가 있으면 Helm이 표시한다.
- schema는 pass지만 diff consistency가 깨지면 자동 진행하지 않는다.
- 모든 자동 상태 전이는 gate pass 기록을 근거로 설명된다.
- 사용자는 run artifact 원문을 열지 않아도 command, exit code, evidence hash, 승인 근거를 확인할 수 있다.

### Step 4. Reviewer/Tester chain 완성

목표:

- Coder 이후가 단순 상태 전이가 아니라 실제 검증 단계가 되게 한다.

작업:

- `plan_verifier`, `code_reviewer`, `tester` role별 expected output contract를 분리한다.
- Context Pack에 role별 검토 기준을 넣는다.
- Tester는 role preset 외에 project check command를 우선 지원한다.
- 테스트 실행 결과를 `test-result.json` artifact로 남긴다.
- reviewer/tester 실패 시 task를 `Blocked`로 보내고 retry path를 안내한다.
- Code Reviewer는 finding severity와 merge blocker 여부를 구조화해 남긴다.
- Plan Verifier는 승인된 plan artifact 또는 planner summary와 실제 diff를 비교한다.
- Tester는 configured check command, stdout/stderr, exit code를 run artifact와 gate result로 연결한다.

추가 artifact 후보:

```text
review-findings.json
test-result.json
gate-result.json
command-evidence.json
```

완료 기준:

- Coder 성공 후 바로 MergeWaiting으로 가지 않고 PlanVerification -> CodeReview -> Testing을 거친다.
- Tester pass에서만 MergeWaiting으로 전이된다.
- review/test fail은 왜 막혔는지와 어떤 role을 다시 실행해야 하는지 표시한다.

### Step 5. Merge readiness와 사용자 승인

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
- merge blocker 목록을 gate result와 run status에서 계산한다.
- task worktree diff를 Git 화면과 연결한다.

추가 command 후보:

```text
get_merge_readiness(project_id, task_id)
preview_merge_commands(project_id, task_id)
```

완료 기준:

- 사용자가 MergeWaiting task를 열면 "왜 머지 가능한지"와 "무엇이 아직 막는지"를 확인할 수 있다.
- 실제 merge/push 없이도 다음 Git 명령이 명확히 제시된다.

### Step 6. Core loop 자동 검증

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
- acceptance test는 fixture runner로 실제 artifact와 diff를 생성한다.

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

### Step 7. Planning Workspace 제품화

목표:

- Jira ticket이 없어도 Helm 안에서 목표를 계획 초안으로 만들고 Task로 materialize할 수 있게 한다.

작업:

- `Planning` 탭의 입력/초안/승인 흐름을 DB 모델과 연결한다.
- planning session, plan draft, draft approval skeleton을 추가한다.
- 승인된 draft를 Epic/Task/External Ref로 변환한다.
- 기존 Jira key/URL 시작 흐름과 새 목표 시작 흐름을 같은 Task pipeline으로 합친다.
- plan draft와 project 설정 편집에는 UTF-8 검증, content hash conflict check, atomic write 원칙을 적용한다.

완료 기준:

- 사용자가 자연어 목표만 입력해도 Task가 생성되고 Planner 실행으로 이어진다.
- Jira 링크가 있으면 external ref로 연결되지만 Jira 없이도 기능이 줄어들지 않는다.

### Step 8. Workflow preset과 session/run 탐색

목표:

- 반복 작업을 매번 수동으로 조립하지 않게 한다.
- 중요한 실행 기록을 나중에 빠르게 찾을 수 있게 한다.

작업:

- 프로젝트 scope workflow preset 모델을 추가한다.
- preset은 이름, prompt, 대상 role, 선택 runner template, 선택 check command, 실행 destination을 가진다.
- destination은 `host_runner`, `terminal`, `fixture`로 시작한다.
- preset 실행은 prompt hash, normalized prompt, command, run id, delivery mode를 diagnostics log에 남긴다.
- run/session list에 search, filter, pin을 추가한다.
- pinned run은 task detail과 dashboard에서 우선 표시한다.
- fixture core-loop preset을 built-in preset으로 제공한다.

완료 기준:

- 사용자는 "fixture core loop 검증" preset을 선택해 반복 검증 흐름을 시작할 수 있다.
- workflow 실행 실패 시 diagnostics log만 보고 어느 단계에서 실패했는지 확인할 수 있다.
- 오래된 run history에서도 prompt, role, status, artifact 이름으로 검색할 수 있다.

### Step 9. 안전한 파일 편집 계약

목표:

- plan, context, settings, 향후 skill/playbook 편집을 덮어쓰기 사고 없이 제공한다.

작업:

- `EditableDocumentSnapshot` 모델을 추가한다.
- read 시 UTF-8 검증, 크기 제한, symlink/dangling symlink 검사, SHA-256 content hash를 반환한다.
- write 시 expected hash가 다르면 저장을 막고 reload/merge 안내를 표시한다.
- write는 temp file, fsync, atomic replace를 사용한다.
- `.helm/` 내부 문서와 사용자가 선택한 tracked 문서를 구분한다.
- binary 또는 대용량 파일은 viewer/edit 대상에서 제외한다.

완료 기준:

- 열어둔 plan/config가 외부에서 바뀌면 Helm이 저장을 막는다.
- 저장 실패 시 사용자의 draft를 잃지 않는다.
- 편집 결과는 audit/evidence에 남는다.

### Step 10. 원격 host profile 후보

목표:

- 당장 로컬 중심을 유지하되, 나중에 remote Mac/VPS repo를 다룰 수 있는 경계를 미리 정한다.

작업:

- `RunnerProfile` 또는 `HostProfile` 후보 모델을 설계한다.
- 필드는 SSH alias, host, user, port, project root, profile label, environment path override로 시작한다.
- service command는 no-TTY, terminal shell은 PTY로 분리한다.
- service command는 BatchMode, connect timeout, server alive, 명시적 destination을 사용한다.
- SSH 실패를 auth, host key, DNS, refused, timeout, path missing으로 분류한다.
- 원격 실행은 기본값이 아니며, 프로젝트별 opt-in 설정으로 둔다.

완료 기준:

- 로컬 host runner 설계를 깨지 않고 remote runner를 붙일 수 있다.
- remote 실행 실패 메시지가 "명령 실패" 하나로 뭉개지지 않는다.

### Step 11. Bounded MCP와 외부 agent 연동 후보

목표:

- 외부 agent가 Helm 상태를 읽고 제한적으로 조작할 수 있는 안전한 protocol boundary를 둔다.

작업:

- `helm-mcp`는 별도 후보로 두고 core loop 이후 설계한다.
- stdout은 JSON-RPC 전용, diagnostics는 stderr로 보낸다.
- tool은 allowlist만 제공한다.
- project/profile은 서버 시작 시 고정하고 tool별 임의 path switching을 금지한다.
- child command timeout과 env allowlist를 둔다.
- mutation tool은 현재 task state와 approval/authority를 다시 읽은 뒤 실행한다.

초기 tool 후보:

```text
helm_status
helm_task_list
helm_task_snapshot
helm_task_create
helm_run_list
helm_run_artifact
helm_approval_list
helm_approval_decide
helm_gate_results
```

완료 기준:

- 외부 agent는 Helm DB를 직접 열지 않고 Helm이 허용한 tool만 사용할 수 있다.
- message body나 prompt text만으로 승인/실행 권한이 생기지 않는다.

### Step 12. 배포/업데이트 검증 후보

목표:

- desktop 배포를 시작할 때 trust boundary를 과장하지 않고 검증 가능한 release artifact를 제공한다.

작업:

- app bundle zip, SHA-256, release manifest를 생성한다.
- manifest에는 bundle id, version, build number, minimum OS, executable, architecture, zip size, checksum을 담는다.
- verify script는 checksum, unzip, bundle metadata, code signature 상태를 확인한다.
- update check는 GitHub Releases metadata 조회만 하고 자동 설치는 하지 않는다.
- update check는 opt-in 또는 24시간 이상 간격의 저빈도 동작으로 제한한다.
- 문서에는 ad-hoc signing, notarization, checksum이 각각 무엇을 보장하지 않는지 명시한다.

완료 기준:

- 사용자가 release zip을 받아 로컬에서 동일성 검증을 할 수 있다.
- 앱은 업데이트 확인 때문에 project path, prompt, artifact 내용을 외부로 보내지 않는다.

## 우선순위

바로 다음 작업 순서는 아래가 가장 낫다.

1. Step 0: 기능 범위 잠금과 문서 정렬
2. Step 1: Runner onboarding 완성
3. Step 2: Task Detail 제품 경로 재구성
4. Step 6 일부: fixture core loop acceptance test
5. Step 3: GateResult, EvidenceRecord, DecisionRecord
6. Step 4: Reviewer/Tester chain
7. Step 5: Merge readiness
8. Step 7: Planning Workspace
9. Step 8: Workflow preset과 session/run 탐색
10. Step 9: 안전한 파일 편집 계약
11. Step 10: 원격 host profile 후보
12. Step 11: Bounded MCP와 외부 agent 연동 후보
13. Step 12: 배포/업데이트 검증 후보

이 순서가 좋은 이유는 현재 가장 큰 병목이 "기능이 없어서"가 아니라 "실제 태스크 하나를 자연스럽게 끝까지 돌릴 실행 경로가 없어서"이기 때문이다.

## 이번 계획에서 아직 제외하는 것

아래는 중요하지만 core loop가 닫힌 뒤 붙인다.

- Jira API sync
- Slack 알림
- Obsidian backfill 자동화
- Docker Hermes observer
- 자동 merge/push/PR 생성
- multi-agent parallel execution
- backup/recovery
- Envoy relay/Connected/invite/capability 구현
- Envoy나 Hermes Desktop을 runtime dependency로 강제하는 구조
- Hermes Desktop식 Kanban/Cron/Skills 전체 복제
- 원격 host를 기본 source of truth로 전환하는 것

## 구현 완료 판정

이 계획이 끝났다고 볼 수 있는 기준:

- Helm repo 자신을 대상으로 fixture runner core loop가 통과한다.
- 실제 Codex 또는 Claude runner template으로 최소 Planner -> PlanApproval -> Coder까지 동작한다.
- run artifact, gate result, evidence record, audit log, worktree diff가 서로 어긋나지 않는다.
- 사용자가 Task Detail만 보고 다음 액션과 blocker를 알 수 있다.
- 사용자가 승인 근거, command evidence, handoff record를 보고 작업 이력을 재구성할 수 있다.
- README와 Phase 문서가 현재 구현 상태와 다음 범위를 과장 없이 설명한다.
