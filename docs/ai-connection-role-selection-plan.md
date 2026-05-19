# AI Connection and Role Selection Improvement Plan

작성일: 2026-05-19

## 목적

Helm 설정에서 AI 연결 정보를 별도로 관리하고, 각 작업 단계별로 어떤 AI를 사용할지 선택할 수 있게 한다. 구현/계획처럼 단일 담당자가 자연스러운 단계는 단일 선택을 기본으로 두고, 테스트와 검수처럼 여러 관점이 필요한 단계는 다중 선택을 지원한다.

이 계획은 현재 `rolePresets` 기반 runner 설정을 바로 버리지 않고, 사용자가 이해할 수 있는 설정 UI와 실행 모델로 확장하는 것을 목표로 한다.

## 현재 상태

현재 설정 화면은 `rolePresets` JSON을 직접 편집하는 방식이다.

- 위치: `apps/desktop/src/screens/SettingsScreen.tsx`
- 저장 모델: `project_settings.rolePresets`
- backend 타입: `EffectiveSettings.role_presets`
- runner 확인: `check_role_runner(project_id, role_id)`
- runner template: `fixture`, `codex`, `claude`

현재 `rolePresets`는 역할별 단일 command를 찾는 배열 구조다.

```json
[
  {
    "roleId": "coder",
    "label": "구현자",
    "provider": "codex",
    "commandArgs": ["codex", "exec", "..."],
    "timeoutSeconds": 1800
  }
]
```

이 구조에서는 같은 역할에 여러 AI를 배정하거나, 테스트/검수를 여러 runner로 동시에 돌린 뒤 결과를 합산하기 어렵다.

## 개선 목표

1. AI 연결 설정과 역할별 사용 설정을 분리한다.
2. 사용자는 JSON을 몰라도 AI 연결을 추가하고 테스트할 수 있어야 한다.
3. 각 작업 단계는 연결된 AI 중 하나 또는 여러 개를 선택할 수 있어야 한다.
4. 테스트와 검수 단계는 다중 선택을 지원한다.
5. 다중 실행 결과는 개별 run으로 남기고, gate는 집계 결과로 판단한다.
6. 기존 `rolePresets`는 마이그레이션 기간 동안 advanced 설정으로 유지한다.

## 설정 모델 제안

### AI Connections

AI 연결은 "어떤 도구를 어떻게 호출할지"만 가진다.

```json
{
  "aiConnections": [
    {
      "id": "codex-local",
      "label": "Codex CLI",
      "provider": "codex",
      "commandArgs": ["codex", "exec", "--cd", "{worktreePath}", "--", "{prompt}"],
      "healthCheckArgs": ["codex", "--version"],
      "timeoutSeconds": 1800,
      "enabled": true
    },
    {
      "id": "claude-local",
      "label": "Claude CLI",
      "provider": "claude",
      "commandArgs": ["claude", "-p", "{prompt}"],
      "healthCheckArgs": ["claude", "--version"],
      "timeoutSeconds": 1800,
      "enabled": true
    }
  ]
}
```

### Role Assignments

역할별 선택은 "어떤 단계에서 어떤 연결을 사용할지"만 가진다.

```json
{
  "roleAssignments": [
    {
      "roleId": "planner",
      "selectionMode": "single",
      "connectionIds": ["codex-local"]
    },
    {
      "roleId": "coder",
      "selectionMode": "single",
      "connectionIds": ["codex-local"]
    },
    {
      "roleId": "plan_verifier",
      "selectionMode": "multiple",
      "connectionIds": ["codex-local", "claude-local"],
      "aggregationPolicy": "all_pass"
    },
    {
      "roleId": "code_reviewer",
      "selectionMode": "multiple",
      "connectionIds": ["codex-local", "claude-local"],
      "aggregationPolicy": "all_pass"
    },
    {
      "roleId": "tester",
      "selectionMode": "multiple",
      "connectionIds": ["fixture-test", "codex-local"],
      "aggregationPolicy": "all_pass"
    }
  ]
}
```

권장 기본값:

| role_id | 선택 방식 | 이유 |
| --- | --- | --- |
| `planner` | 단일 선택 | 계획 초안은 책임 주체가 하나인 편이 좋다. |
| `coder` | 단일 선택 | 같은 worktree에 여러 구현자가 동시에 쓰면 충돌 가능성이 높다. |
| `plan_verifier` | 다중 선택 가능 | 계획 준수 검수는 서로 다른 관점이 유효하다. |
| `code_reviewer` | 다중 선택 가능 | 코드 리뷰는 복수 reviewer 결과를 합산하기 좋다. |
| `tester` | 다중 선택 가능 | unit, lint, e2e, AI 검증을 병렬/순차로 묶기 좋다. |

## 실행 모델

단일 선택 역할은 지금처럼 하나의 `agent_runs`를 만든다.

다중 선택 역할은 `role_execution_group` 개념을 추가한다.

```text
사용자가 code_reviewer 실행
-> role_execution_groups 생성
-> 선택된 connection 수만큼 agent_runs 생성
-> 각 runner 실행
-> run별 artifact 저장
-> group gate result 집계
-> all_pass면 다음 상태로 전이
-> 하나라도 fail/needs_inspection이면 상태 유지 또는 Blocked
```

최소 DB 추가 후보:

```text
role_execution_groups
- id
- project_id
- task_id
- role_id
- status
- aggregation_policy
- created_at
- updated_at

agent_runs
- execution_group_id nullable 추가
- connection_id nullable 추가
```

집계 정책:

| 정책 | 의미 | 기본 적용 |
| --- | --- | --- |
| `all_pass` | 모든 선택 실행이 pass여야 통과 | 테스트, 검수 기본값 |
| `any_pass` | 하나라도 pass면 통과 | 빠른 smoke check용 선택지 |
| `manual_decision` | 결과만 모으고 사용자가 승인 | 리뷰 의견 충돌이 잦은 팀용 |

초기 구현은 `all_pass`만 지원하고, 나머지는 스키마 예약값으로 둔다.

## Settings UI 계획

설정 화면을 세 영역으로 나눈다.

### 1. AI 연결

목표: 사용자가 Codex/Claude/Fixture 같은 연결을 만들고 상태를 확인한다.

UI 요소:

- 연결 목록
- provider 배지
- enabled toggle
- command preview
- health check 버튼
- 연결 추가 버튼
- 연결 수정 drawer 또는 inline editor

초기 provider:

- Fixture runner
- Codex CLI
- Claude CLI

### 2. 작업별 AI 선택

목표: 각 role이 사용할 AI 연결을 지정한다.

UI 요소:

- role별 행
- 단일 선택 role은 radio/select
- 다중 선택 role은 checkbox group
- 테스트/검수 role에는 "전체 통과 시 다음 단계 진행" 정책 표시
- 선택된 연결의 health 상태 표시

역할 그룹:

- 계획: `planner`
- 구현: `coder`
- 검수: `plan_verifier`, `code_reviewer`
- 테스트: `tester`

### 3. 고급 설정

목표: 기존 `rolePresets` JSON을 즉시 제거하지 않는다.

UI 요소:

- 접힌 JSON editor
- "기존 rolePresets에서 가져오기" migration action
- "현재 설정을 JSON으로 보기" debug action

## Backend API 계획

추가 command 후보:

```text
list_ai_connections(project_id)
upsert_ai_connection(project_id, connection)
delete_ai_connection(project_id, connection_id)
check_ai_connection(project_id, connection_id)

list_role_assignments(project_id)
update_role_assignment(project_id, role_id, assignment)
run_role_assignment(project_id, task_id, role_id)
```

기존 command와의 관계:

- `check_role_runner`는 deprecated 후보로 둔다.
- `run_host_role(project_id, run_id)`는 내부 실행기로 유지한다.
- `prepare_role_context`는 group 실행에서도 공유한다.
- `apply_runner_template`은 `aiConnections + roleAssignments`를 생성하도록 확장한다.

## 단계별 구현 계획

### Step 1. 문서와 타입 정리

- `EffectiveSettings`에 `aiConnections`, `roleAssignments` 후보 타입을 추가한다.
- frontend `types.ts`에 명시 타입을 만든다.
- 기존 `rolePresets`와 새 설정의 우선순위를 정의한다.

완료 기준:

- 새 설정 모델을 저장하지 않아도 기존 프로젝트가 정상 동작한다.

### Step 2. AI Connections 저장과 health check

- `project_settings.aiConnections` 저장을 추가한다.
- Codex/Claude/Fixture template을 connection template로 분리한다.
- 연결별 health check를 제공한다.
- Settings UI에 AI 연결 섹션을 만든다.

완료 기준:

- 사용자가 Fixture, Codex, Claude 연결을 추가하고 사용 가능 여부를 확인할 수 있다.

### Step 3. Role Assignments UI

- `project_settings.roleAssignments` 저장을 추가한다.
- role별 selection mode를 정의한다.
- `planner`, `coder`는 단일 선택으로 표시한다.
- `plan_verifier`, `code_reviewer`, `tester`는 다중 선택 checkbox로 표시한다.

완료 기준:

- 테스트와 검수 단계에서 둘 이상의 AI 연결을 선택하고 저장할 수 있다.

### Step 4. 단일 실행을 새 모델로 연결

- `roleAssignments`가 있으면 `rolePresets` 대신 새 모델로 command를 해석한다.
- 단일 선택 role부터 기존 `prepareRoleContext -> runHostRole` 흐름에 연결한다.
- 기존 fixture 테스트를 새 모델 기준으로 보강한다.

완료 기준:

- `planner`, `coder`가 새 설정 모델로 정상 실행된다.

### Step 5. 다중 실행 group 도입

- `role_execution_groups`를 추가한다.
- 다중 선택 role 실행 시 연결 수만큼 `agent_runs`를 만든다.
- run artifact를 connection별로 구분해 표시한다.
- group 집계 결과를 `gate_results` 또는 group payload로 남긴다.

완료 기준:

- `code_reviewer` 또는 `tester`를 두 연결로 실행하면 run history에 두 결과가 남는다.

### Step 6. Gate 집계와 상태 전이

- `all_pass` 집계를 구현한다.
- 하나라도 실패하면 다음 상태로 자동 전이하지 않는다.
- 실패/검수 필요 결과는 Task Detail에서 어떤 연결이 막았는지 표시한다.

완료 기준:

- 다중 테스트가 모두 pass일 때만 `MergeWaiting`으로 전이한다.
- 하나라도 fail이면 사용자가 재실행 또는 수동 판단을 선택해야 한다.

## 테스트 계획

단위 테스트:

- `aiConnections` 저장/조회
- `roleAssignments` 저장/조회
- 단일 선택 role validation
- 다중 선택 role validation
- disabled connection 선택 차단
- `all_pass` 집계

통합 테스트:

- fixture 연결 2개로 `tester` 다중 실행
- 하나 pass, 하나 fail일 때 상태 전이 차단
- 둘 다 pass일 때 다음 상태 전이
- 기존 `rolePresets` 프로젝트가 새 버전에서 깨지지 않는지 확인

UI 검증:

- 연결 없음 empty state
- health check 실패 메시지
- 단일 선택 role에서 하나만 선택 가능
- 검수/테스트 role에서 여러 연결 선택 가능
- 저장 후 새로고침해도 선택 유지

## 우선순위

1. Settings UI를 JSON 중심에서 "AI 연결"과 "작업별 AI 선택"으로 분리한다.
2. `aiConnections`, `roleAssignments`를 `project_settings`에 추가한다.
3. 단일 선택 role을 새 모델로 먼저 실행한다.
4. 테스트/검수 다중 선택은 group 실행과 `all_pass` 집계까지 묶어서 구현한다.
5. 기존 `rolePresets`는 한동안 fallback으로 유지하고, 마이그레이션 버튼을 제공한다.

## 리스크

- 여러 AI가 같은 role을 수행할 때 결과가 충돌할 수 있다.
- 다중 reviewer 결과를 단순 `all_pass`로만 판단하면 보수적으로 막히는 경우가 많다.
- 테스트와 AI 검수를 같은 `tester` role에 넣으면 shell test와 AI judgment가 섞일 수 있다.
- 기존 `agent_runs`만으로는 group 단위 표시가 어려워 UI와 DB를 같이 바꿔야 한다.

초기에는 테스트/검수 다중 선택을 `all_pass` 정책으로 제한하고, 수동 승인 정책은 후속 단계로 미루는 것이 안전하다.
