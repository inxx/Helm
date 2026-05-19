# Helm Phase 1-2 User Flow

작성일: 2026-05-19

## 목적

이 문서는 Phase 1-2 구현자가 사용자의 실제 시작 방식을 기준으로 화면, 데이터, 상태 전이, approval 흐름을 흔들리지 않게 구현하기 위한 제품 동작 계획이다.

Helm의 첫 사용 루프는 두 가지 진입점을 모두 지원해야 한다.

1. 이미 Jira Epic 또는 Jira task가 있는 작업
2. Jira 없이 Helm에서 바로 시작하는 작업

두 경우 모두 Helm의 기준 소스는 Helm DB와 계획 Markdown이다. Jira는 외부 실행 추적 시스템으로 연결될 수 있지만, Phase 1-2에서는 Jira API 연동을 구현하지 않는다.

## 기준 원칙

- Phase 1-2에서 Jira 연결은 metadata 수준으로만 다룬다.
- Jira issue가 있어도 Helm task와 approval, audit log는 Helm backend가 소유한다.
- Jira가 없어도 Helm 작업은 완전하게 시작되고 진행되어야 한다.
- 사용자는 작업 시작 시 "기존 Jira 작업에서 시작"과 "새 작업 만들기" 중 하나를 선택할 수 있어야 한다.
- Phase 2에서 실제 Claude/Codex 실행은 하지 않는다. stub role run만 생성한다.
- 실제 Git 변경, merge, push, Jira status sync는 Phase 3 이후 범위다.

## 시작 모드

### 모드 A. 기존 Jira Epic 또는 Jira task에서 시작

사용자가 이미 아래 중 하나를 가지고 있는 경우다.

- Jira Epic key
- Jira Task/Story key
- 이미 작성된 Markdown 계획 문서
- 팀에서 합의된 요구사항 문서

Phase 1-2에서는 Jira API를 호출하지 않는다. 사용자는 key, URL, 제목, 설명을 수동으로 입력하거나 붙여넣는다.

초기 입력:

- 작업 제목
- 설명 또는 요구사항 요약
- 외부 참조 타입: `JiraEpic`, `JiraTask`, `MarkdownPlan`, `PlainText`
- 외부 참조 값: Jira key, URL, 또는 계획 문서 경로
- 기존 Helm epic에 연결할지 새 Helm epic을 만들지 선택

생성 결과:

- Helm epic이 없으면 새 epic을 만든다.
- Helm task를 만든다.
- 외부 참조는 `task_external_refs`에 저장한다.
- Phase 3 이후 Jira 모델이 추가되면 `JiraIssueLink`로 승격할 수 있어야 한다.

권장 초기 상태:

```text
EpicStatus: Drafting
TaskStatus: Planned
```

이미 충분히 승인된 외부 계획이 있더라도 Phase 2에서는 Helm 내부 `PlanApproval`을 한 번 거친다. 이유는 Helm의 다음 role 실행 여부를 외부 Jira 상태가 아니라 Helm approval 상태로 판단하기 위해서다.

### 모드 B. Jira 없이 Helm에서 바로 시작

사용자가 Jira나 기존 문서 없이 Helm에서 새 작업을 시작하는 경우다.

초기 입력:

- 작업 제목
- 문제 또는 목표
- 기대 결과
- 관련 파일 또는 참고 문서
- 에픽 생성 여부

생성 결과:

- 새 Helm epic을 만든다.
- 새 Helm task를 만든다.
- 외부 참조는 비어 있다.
- Phase 2에서 Planner stub run과 PlanApproval을 통해 계획을 승인한다.

권장 초기 상태:

```text
EpicStatus: Drafting
TaskStatus: Planned
```

Jira가 없는 작업은 Jira 연결이 없다는 이유로 기능이 줄어들면 안 된다. Phase 1-2의 모든 핵심 흐름은 Jira 없이 동작해야 한다.

## 데이터 모델 보강

두 시작 모드를 모두 지원하려면 Phase 1 schema에 외부 참조 저장소가 필요하다.

```text
task_external_refs
```

최소 컬럼:

- `id`
- `project_id`
- `task_id`
- `ref_type`
- `ref_value`
- `ref_title`
- `created_at`

`ref_type` 허용값:

```text
JiraEpic
JiraTask
MarkdownPlan
PlainText
Url
```

규칙:

- `task_id`가 삭제되면 연결된 external ref도 삭제한다.
- Phase 1-2에서는 external ref를 읽기 전용 metadata로만 표시한다.
- Jira key 또는 URL이 있어도 Jira API를 호출하지 않는다.
- Phase 3 이후 Jira 연동 모델이 추가되면 `ref_type in ('JiraEpic', 'JiraTask')` 값을 `JiraIssueLink` 생성 후보로 사용한다.
- Jira 없는 작업은 `task_external_refs` row가 없어도 정상 상태다.
- Phase 1에서는 external ref 수정/삭제 UI를 만들지 않는다. 잘못 입력한 참조는 task를 새로 만들거나 Phase 2 이후 edit command에서 다룬다.

## Phase 1 사용자 흐름

### 첫 실행

```text
앱 실행
-> 프로젝트 열기
-> git repo 검증
-> repo/.helm/helm.sqlite 생성 또는 open
-> migration 실행
-> 태스크 화면 표시
```

빈 프로젝트 화면은 사용자가 바로 작업을 만들 수 있어야 한다.

표시 요소:

- 프로젝트명
- 현재 branch와 head
- dirty file count
- "작업 만들기" 액션
- "깃에서 보기" 액션

숨길 요소:

- 승인 대기 수
- 실행 중 AI 수
- token 사용량
- Jira 연결 상태
- Docker Hermes 상태
- task worktree 정보

### 작업 만들기

작업 생성 화면은 두 가지 선택지를 먼저 보여준다.

```text
기존 Jira 작업에서 시작
새 작업 만들기
```

`기존 Jira 작업에서 시작`은 수동 링크 입력이다. Phase 1에서 Jira 검색이나 동기화는 제공하지 않는다.

`새 작업 만들기`는 Helm-native 작업 생성이다.

생성 후 화면:

- 태스크 보드에 `계획됨` 카드가 추가된다.
- 우측 상세에 제목, 설명, 외부 참조, 상태, audit tail을 표시한다.
- Git 화면은 프로젝트 전체 read-only 상태만 보여준다.

### Phase 1 acceptance scenario

```text
사용자가 git repo를 연다.
Helm이 repo/.helm/helm.sqlite를 만든다.
사용자가 "새 작업 만들기"를 선택한다.
Helm이 epic과 task를 생성한다.
사용자가 task 상태를 수동으로 Ready로 바꾼다.
Helm이 task.status_changed audit log를 남긴다.
사용자가 깃 화면에서 current branch, head, changed files를 확인한다.
```

Phase 1에서는 이 시나리오가 Jira 없이 통과해야 한다.

## Phase 2 사용자 흐름

Phase 2의 목표는 Helm이 단순 task board가 아니라 오케스트레이터라는 것을 보이는 첫 vertical slice다.

핵심 흐름:

```text
Task 생성
-> Planner stub run
-> structured-result.json 저장
-> PlanApproval 생성
-> 사용자 승인
-> TaskStatus 전이
-> audit log 기록
```

### 기존 Jira task에서 시작한 경우

```text
기존 Jira 작업에서 시작
-> Jira key 또는 URL 입력
-> Helm task 생성
-> Planner stub run 실행
-> PlanApproval Pending 생성
-> 사용자가 승인
-> TaskStatus: Planned -> Ready
```

Jira task가 이미 `진행 중`이거나 팀에서 승인된 상태여도 Helm 내부에서는 `PlanApproval`을 생성한다. 사용자는 approval reason에서 "외부 Jira에서 이미 합의됨" 같은 근거를 남길 수 있다.

Phase 2에서는 Jira status를 바꾸지 않는다. approval 결정과 task 상태 전이는 Helm DB에만 기록한다.

### Jira 없이 시작한 경우

```text
새 작업 만들기
-> Helm epic/task 생성
-> Planner stub run 실행
-> summary.md와 structured-result.json 확인
-> PlanApproval Pending 생성
-> 사용자가 승인 또는 반려
-> 승인 시 TaskStatus: Planned -> Ready
-> 반려 시 TaskStatus: Planned 유지 또는 Blocked 전환
```

Jira가 없어도 approval inbox, run history, artifact viewer, audit log는 동일하게 동작한다.

## 기본 role preset

Phase 2 stub run을 위해 최소 role catalog를 고정한다.

| role_id | 한국어 라벨 | Phase 2 동작 |
| --- | --- | --- |
| `planner` | 설계자 | 계획 요약 stub artifact 생성 |
| `coder` | 구현자 | 구현 결과 stub artifact 생성 |
| `plan_verifier` | 계획 검토자 | 계획 준수 검토 stub artifact 생성 |
| `code_reviewer` | 코드 리뷰어 | 코드 리뷰 stub artifact 생성 |
| `tester` | 테스트 담당자 | 테스트 결과 stub artifact 생성 |

Phase 2에서는 role provider, model, command template을 실행하지 않는다. 설정 skeleton에는 표시할 수 있지만 실제 process 실행처럼 보이면 안 된다.

## Phase 2 상태 전이 예시

Phase 2는 전체 자동 chain을 만들지 않는다. 사용자가 버튼을 눌러 다음 stub run 또는 approval 결정을 수행한다.

허용 전이:

| 이벤트 | 이전 상태 | 이후 상태 |
| --- | --- | --- |
| task 생성 | 없음 | `Planned` |
| planner run 성공 | `Planned` | `Planned` |
| plan approval 생성 | `Planned` | `Planned` |
| plan approval 승인 | `Planned` | `Ready` |
| plan approval 반려 | `Planned` | `Blocked` 또는 `Planned` |
| coder run 시작 | `Ready` | `Coding` |
| coder run 성공 | `Coding` | `PlanVerification` |
| plan verifier run 성공 | `PlanVerification` | `CodeReview` |
| code reviewer run 성공 | `CodeReview` | `Testing` |
| tester run 성공 | `Testing` | `MergeWaiting` |
| schema validation 실패 | 현재 상태 | 현재 상태 유지, run은 `NeedsInspection` |

금지 전이:

| 금지 사례 | 이유 |
| --- | --- |
| `PlanApproval` 승인 전 coder run 실행 | 계획 승인 gate 우회 |
| `NeedsInspection` run을 성공처럼 다음 상태로 진행 | artifact 계약 불명확 |
| Jira status만 보고 Helm task를 자동 전이 | Helm approval/audit 우회 |
| frontend에서 임의 shell command 실행 | 권한 경계 위반 |
| Phase 2에서 merge/push/fetch 수행 | Git 쓰기 범위 초과 |

## Approval inbox 동작

Approval inbox는 Phase 2에서 반드시 실제 DB와 연결한다.

표시 항목:

- approval type
- entity type
- entity title
- requested reason
- requested at
- approve/reject action
- decision reason input

사용자가 승인하면:

- `approvals.status = Approved`
- `approval.approved` audit log 생성
- 연결된 task status 전이 적용

사용자가 반려하면:

- `approvals.status = Rejected`
- `approval.rejected` audit log 생성
- 연결된 task는 상태 유지 또는 `Blocked` 전환

반려 후 어떤 상태로 둘지는 approval type별 정책으로 둔다. Phase 2 기본값은 `PlanApproval` 반려 시 `Blocked`다.

## Stub artifact 예시

`summary.md`:

```md
# Stub Planner Result

이 실행은 실제 agent process 없이 생성된 Phase 2 검증용 결과입니다.

- 역할: planner
- 결과: pass
- 다음 단계: 계획 승인 대기
```

`structured-result.json`:

```json
{
  "schemaVersion": 1,
  "status": "pass",
  "summary": "계획 stub run이 완료되었습니다.",
  "changedFiles": [],
  "risks": [],
  "nextActions": ["PlanApproval 승인 후 Ready 상태로 전이합니다."],
  "gateResult": null
}
```

`stdout.log`:

```text
stub role run completed
```

`stderr.log`:

```text
```

## 오류와 빈 상태

Phase 1-2에서 오류는 사용자가 다음 행동을 알 수 있게 보여준다.

| 상황 | 사용자 표시 |
| --- | --- |
| git repo 아님 | "Git 저장소를 선택해주세요." |
| bare repo | "Bare repository는 아직 지원하지 않습니다." |
| `.helm` 생성 실패 | "프로젝트에 Helm 데이터를 만들 수 없습니다. 폴더 권한을 확인해주세요." |
| DB schema too new | "더 최신 버전의 Helm에서 만든 데이터입니다. 앱을 업데이트해주세요." |
| migration 실패 | "Helm 데이터베이스 업데이트에 실패했습니다. 파일은 삭제하지 않았습니다." |
| artifact path traversal | "허용되지 않은 실행 산출물 경로입니다." |
| Jira key만 있고 연결 없음 | "Jira 연결 없이 외부 참조로만 저장됩니다." |

빈 상태는 기능을 과장하지 않는다.

- 태스크 없음: 작업 만들기 액션만 보여준다.
- approval 없음: 승인 대기 항목이 없다고 표시한다.
- run 없음: 아직 실행 기록이 없다고 표시한다.
- Jira 연결 없음: Phase 1-2에서는 설정 유도나 연결 버튼을 노출하지 않는다.

## 구현 체크리스트

- 두 시작 모드를 작업 생성 UI에 반영한다.
- Jira key/URL은 Phase 1-2에서 외부 참조 metadata로만 저장한다.
- Jira 없이도 Phase 1 acceptance scenario가 통과한다.
- `planner`, `coder`, `plan_verifier`, `code_reviewer`, `tester` role id를 고정한다.
- Phase 2에서 `PlanApproval` 승인 전 coder run을 막는다.
- `NeedsInspection` run은 다음 상태로 자동 진행하지 않는다.
- approval 결정과 task status 변경은 모두 audit log를 남긴다.
- artifact viewer는 allowlist 파일만 읽는다.
