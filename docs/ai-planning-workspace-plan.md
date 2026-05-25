# Helm AI Planning Workspace Plan

작성일: 2026-05-19

## 목적

Helm에는 정리된 Task를 실행하는 화면만 있으면 부족하다.

사용자는 항상 Jira ticket, 완성된 요구사항, 구현 단위로 쪼개진 Task를 가지고 시작하지 않는다. 그래서 Helm의 첫 진입점에는 Conductor처럼 AI와 대화하면서 프로젝트 목표를 구체화하고, 실행 가능한 Epic/Task/Plan으로 바꾸는 Planning Workspace가 필요하다.

이 화면의 목적은 아래 흐름을 Helm 안에서 닫는 것이다.

```text
막연한 목표 입력
-> repo context 확인
-> planner와 계획 대화
-> Epic/Task/Subtask로 작업 분해
-> Acceptance Criteria / Risk / Test Plan 정리
-> 사용자 승인
-> Helm DB에 계획과 Task 저장
-> 기존 Task core loop로 이동
```

## 제품 원칙

- AI는 바로 실행하지 않고 계획 초안을 만든다.
- 사용자가 승인한 초안만 Helm DB에 저장한다.
- 계획 대화, 수정 이력, 승인 이력은 audit 가능한 기록으로 남긴다.
- Jira가 없어도 동작해야 한다.
- Jira key, Jira URL, Markdown spec, external URL은 external reference로만 연결한다.
- Helm DB의 Planning Session, Plan Draft, Task가 기준 소스다.
- Planning Workspace는 chat UI가 아니라 project planning canvas다.

## 2026-05-25 구현 메모

- Planning session/revision/materialization은 repo-local SQLite source of truth로 저장된다.
- draft revision은 `.helm/planning/{session_id}/draft-v{n}.md` artifact와 `content_hash`를 남긴다.
- draft approval은 `planning_approvals` 전용 테이블에 저장되며, Task 생성은 `approve_plan_draft` 후 `materialize_plan_draft`에서만 가능하다.
- 새 planner contract가 `taskCards.ownedFiles/sharedFiles/generatedFiles/generatedFilePolicy/reportContract`를 포함하면 backend가 parallel ownership overlap과 report/generated policy 누락을 차단한다.
- 남은 UX 정리는 `PlanningSessionStub` 제거, materialization repair command, browser/frontend smoke 자동화다.

## 화면 구조

```text
┌──────────────────────────────────────────────────────────────┐
│ Domain Tabs: Planning | Tasks | Git | Terminal | Settings     │
├────────────────┬───────────────────────────┬─────────────────┤
│ Project/Plans  │ Planning Conversation      │ Context Panel   │
│                │                           │                 │
│ - Current repo │ User <-> AI               │ - Repo summary  │
│ - Draft plans  │                           │ - Git status    │
│ - Epics        │ Planning canvas            │ - Related files │
│ - Tasks        │                           │ - Existing task │
│                │                           │ - External refs │
│                │                           │ - Risks         │
├────────────────┴───────────────────────────┴─────────────────┤
│ Plan Preview: Epic / Tasks / Acceptance Criteria / Role Plan  │
└──────────────────────────────────────────────────────────────┘
```

## 핵심 사용자 흐름

### 1. 목표 입력

사용자가 자연어로 만들고 싶은 기능, 고치고 싶은 문제, 조사하고 싶은 목표를 입력한다.

예:

```text
Conductor처럼 AI와 프로젝트 계획을 세우는 화면을 Helm에 넣고 싶다.
```

Helm은 이 입력을 곧바로 Task로 만들지 않는다. 먼저 Planning Session을 생성한다.

### 2. Repo context 준비

Helm은 현재 repo에서 계획 수립에 필요한 최소 context를 준비한다.

- project root
- Git branch/status
- 기존 Epic/Task
- 관련 docs
- 관련 파일 후보
- 최근 run/audit 요약
- 사용자가 붙인 external reference

초기 MVP에서는 전체 코드 분석을 하지 않고, 얕은 repo summary와 사용자가 직접 붙인 context만 사용한다.

### 3. planner와 계획 대화

Planning 탭의 대화 상대는 범용 chat AI가 아니라 Helm의 `planner` role이다. `planner`는 사용자의 목표와 repo context를 바탕으로 질문하거나 계획 초안을 제안한다.

planner가 해야 하는 일:

- 목표를 더 작은 delivery 단위로 나눈다.
- Epic/Task/Subtask 구조로 작업을 분해한다.
- 각 Task의 acceptance criteria, risk, test plan을 제안한다.
- Task 간 dependency와 실행 순서를 제안한다.
- 큰 작업은 phase 목록이 아니라 실행 가능한 task graph, task card, ownership map, barrier, verification gate로 분해한다.
- 병렬 실행 가능한 작업과 직렬 실행해야 하는 작업을 구분한다.
- 모호한 요구사항을 open question으로 남긴다.
- 어떤 role 흐름으로 실행할지 제안한다.

planner가 하면 안 되는 일:

- 사용자 승인 없이 Task를 생성하지 않는다.
- 사용자 승인 없이 runner를 실행하지 않는다.
- 사용자 승인 없이 Git 작업을 하지 않는다.

### 4. Plan Draft 생성

planner 응답은 자유 텍스트로만 남기지 않고 구조화된 Plan Draft로 저장한다.

Plan Draft에는 최소한 아래 항목이 있어야 한다.

- title
- summary
- epics
- tasks
- subtasks
- acceptance criteria
- risks
- open questions
- suggested role plan
- executable plan
  - task graph
  - task cards
  - ownership map
  - merge barriers
  - verification gates
- external references

non-trivial Plan Draft의 executable plan은 [Executable Planning Contract](executable-planning-contract.md)를 따른다. 작은 작업도 최소 단일 task card와 verification gate는 가져야 한다.

### 5. 사용자 검토와 승인

사용자는 Plan Preview에서 초안을 확인한다.

가능한 액션:

- draft 수정 요청
- draft 일부 삭제
- task title/description 직접 수정
- external reference 추가
- 승인
- 보류 또는 폐기

승인된 draft만 실제 Epic/Task로 materialize된다.

### 6. Core loop로 이동

승인 후 Helm은 생성된 Task Detail로 이동한다.

이후 흐름은 기존 core loop를 탄다.

```text
Planner
-> PlanApproval
-> Coder
-> PlanVerification
-> CodeReview
-> Testing
-> MergeWaiting
```

## 데이터 모델 후보

2026-05-25 기준 첫 DB-backed vertical slice는 `0008_planning_workspace.sql`로 들어갔다. 실제 구현 table은 `planning_sessions`, `planning_messages`, `plan_draft_revisions`, `planning_materializations`, `planning_materialization_items`이며, 아래 후보 모델은 이후 `planning_approvals`, artifact export/hash, 부분 승인 모델을 보강할 때의 설계 맥락으로 유지한다.

### planning_sessions

```text
id
project_id
title
status: Drafting | ReadyForApproval | Approved | Archived
goal_text
repo_context_snapshot_json
created_at
updated_at
```

### planning_messages

```text
id
session_id
role: user | assistant | system
content
created_at
```

### plan_drafts

```text
id
session_id
version
draft_json
status: Draft | Approved | Rejected
created_at
```

### plan_draft_items

초기에는 별도 table 없이 `plan_drafts.draft_json`만 사용한다. preview, 부분 승인, diff가 필요해지는 시점에 분리한다.

후보 컬럼:

```text
id
draft_id
item_type: Epic | Task | Subtask | AcceptanceCriteria | Risk | TestPlan
payload_json
created_at
```

## Plan Draft JSON 후보

```json
{
  "schemaVersion": 1,
  "title": "AI Planning Workspace 구현",
  "summary": "사용자가 AI와 프로젝트 계획을 세우고 승인된 초안을 Helm Task로 변환한다.",
  "executablePlan": {
    "classification": "graph-shaped",
    "taskGraph": {
      "serialSpine": ["PLANNING-FOUNDATION", "PLANNING-MATERIALIZE"],
      "parallelLanes": [
        {
          "id": "LANE-UI",
          "tasks": ["PLANNING-UI-SHELL"]
        },
        {
          "id": "LANE-DB",
          "tasks": ["PLANNING-DB-SKELETON"]
        }
      ],
      "barriers": ["BARRIER-PLANNING-INTEGRATION", "BARRIER-FINAL-VERIFY"]
    },
    "taskCards": [
      {
        "id": "PLANNING-UI-SHELL",
        "type": "parallel-domain",
        "status": "ready",
        "goal": "Planning 탭과 세션 목록, planner 대화 canvas를 추가한다.",
        "dependsOn": ["PLANNING-FOUNDATION"],
        "canRunInParallel": true,
        "ownedFiles": ["apps/desktop/src/screens/PlanningScreen.tsx"],
        "readOnlyFiles": ["docs/ai-planning-workspace-plan.md"],
        "sharedFiles": [],
        "doneWhen": ["Planning 탭에서 새 planning session을 시작할 수 있다."],
        "verifyCommand": "pnpm --dir apps/desktop typecheck",
        "reportFormat": "taskId/status/changedFiles/verification/blockers"
      }
    ],
    "ownershipMap": {
      "ownedFiles": {
        "PLANNING-UI-SHELL": ["apps/desktop/src/screens/PlanningScreen.tsx"],
        "PLANNING-DB-SKELETON": ["apps/desktop/src-tauri/src/db.rs"]
      },
      "sharedFiles": ["README.md", "docs/ai-planning-workspace-plan.md"],
      "generatedFiles": []
    },
    "verificationGates": [
      {
        "id": "GATE-PLANNING-TYPECHECK",
        "level": "per-batch",
        "command": "pnpm --dir apps/desktop typecheck"
      }
    ]
  },
  "epics": [
    {
      "title": "Planning Workspace",
      "description": "AI와 프로젝트 계획을 세우는 첫 화면을 추가한다.",
      "tasks": [
        {
          "title": "Planning 탭과 세션 목록 추가",
          "description": "App shell에 Planning 도메인을 추가하고 planning session 목록을 표시한다.",
          "subtasks": [
            "Planning 탭 라우팅 추가",
            "planning session 목록 UI 추가",
            "planner 대화 canvas 추가"
          ],
          "acceptanceCriteria": [
            "프로젝트를 열면 Planning 탭으로 이동할 수 있다.",
            "사용자는 planner와 새 planning session을 만들 수 있다.",
            "planner가 생성한 Task breakdown을 승인 전 확인할 수 있다."
          ],
          "risks": [
            "채팅 UI와 Task 실행 UI의 책임이 섞일 수 있다."
          ],
          "rolePlan": [
            "planner",
            "coder",
            "plan_verifier",
            "code_reviewer",
            "tester"
          ]
        }
      ]
    }
  ],
  "externalRefs": [],
  "openQuestions": [],
  "recommendedNextStep": "사용자 승인 후 Task를 생성한다."
}
```

## 구현 단계

### Step 1. 문서와 정보 구조 반영

목표:

- Planning Workspace를 Helm의 0순위 도메인으로 문서화한다.
- App shell에서 Planning 탭을 첫 번째 도메인으로 둘 수 있게 한다.

작업:

- `docs/domain-goal-implementation-plan.md`에 Planning Workspace 도메인을 추가한다.
- 기존 `Task Orchestration`은 Planning 이후 실행 도메인으로 위치를 조정한다.
- README 또는 Phase 문서에서 Helm의 첫 사용자 흐름을 `Planning -> Task`로 설명한다.

완료 기준:

- 문서만 봐도 Helm의 시작점이 Task board가 아니라 Planning Workspace라는 점이 드러난다.

### Step 2. Planning 탭 UI skeleton

목표:

- 사용자가 프로젝트를 열고 Planning 탭에서 새 계획을 시작할 수 있게 한다.

작업:

- 상단 도메인 탭에 `Planning` 추가
- `PlanningScreen` 추가
- 빈 상태에서 목표 입력 CTA 제공
- 좌측 프로젝트/계획 목록과 중앙 planning canvas skeleton 구성
- 우측 context panel skeleton 구성

완료 기준:

- 프로젝트를 열면 Planning 탭에서 목표 입력 화면을 볼 수 있다.

### Step 3. DB skeleton

목표:

- planning session과 draft를 repo-local DB에 저장한다.

작업:

- `planning_sessions` migration 추가
- `planning_messages` migration 추가
- `plan_drafts` migration 추가
- create/list/get command 추가

완료 기준:

- 사용자가 목표를 입력하면 planning session이 생성되고 새로고침 후에도 남아 있다.

### Step 4. Manual Plan Draft MVP

목표:

- 실제 AI 호출 전에도 계획 초안 작성과 Task 생성 흐름을 검증한다.

작업:

- 목표 입력값으로 기본 draft 생성
- 사용자가 draft JSON 또는 form을 수정할 수 있게 한다.
- 승인 시 Epic/Task를 생성한다.

완료 기준:

- AI 없이도 `목표 입력 -> draft 확인 -> 승인 -> Task 생성`이 동작한다.

### Step 5. Fixture planning runner

목표:

- 실제 AI CLI 없이 end-to-end planning 흐름을 자동 검증한다.

작업:

- fixture runner에 `planning` mode 추가
- goal/context를 받아 Plan Draft JSON 생성
- schema validation 추가
- DB 테스트 추가

완료 기준:

- fixture runner로 planning session에서 valid Plan Draft를 생성할 수 있다.

### Step 6. 실제 planner 연결

목표:

- Codex/Claude runner를 이용해 repo context 기반 계획 초안과 Task breakdown을 생성한다.

작업:

- planning context pack 생성
- planner command template 추가
- planner 응답을 Plan Draft schema로 검증
- 실패 시 draft를 저장하지 않고 오류와 raw artifact를 남긴다.

완료 기준:

- Codex/Claude가 설치된 환경에서 planner가 사용자의 목표를 Plan Draft와 Epic/Task/Subtask breakdown으로 변환할 수 있다.

### Step 7. Plan Draft Approval과 materialize

목표:

- 승인된 draft만 Epic/Task로 변환한다.

작업:

- draft approval event 추가
- 승인 시 Epic/Task/Subtask 생성
- 생성된 Task에 planning session/draft reference 저장
- audit log 기록

완료 기준:

- 어떤 대화와 draft에서 Task가 생성됐는지 추적할 수 있다.

## 성공 기준

- 사용자가 빈 상태에서 Planning 탭으로 시작할 수 있다.
- 목표를 입력하면 planning session이 생성된다.
- repo context와 existing task를 참고할 수 있다.
- planner 또는 fixture runner가 Plan Draft와 Task breakdown을 생성한다.
- non-trivial 목표는 task graph, task card, ownership map, barrier, verification gate를 포함한 executable plan으로 생성된다.
- 사용자가 draft를 승인해야만 Epic/Task가 생성된다.
- 생성된 Task는 기존 Task Detail core loop로 이어진다.
- planning 대화, draft, 승인 이력이 DB와 audit에 남는다.

## 보류할 것

- 완전한 코드베이스 semantic indexing
- 다중 AI 간 실시간 토론
- Jira 자동 동기화
- 자동 Task 실행
- 자동 branch/commit/merge

이 항목들은 Planning Workspace의 MVP 이후에 다룬다.

## 상세 기능 계약

Task 생성 전 planner와 계획 문서를 만들고 수정한 뒤, 사용자가 승인한 draft만 Epic/Task로 변환하는 세부 기능 계약은 [ai-plan-conversation-approval-feature.md](ai-plan-conversation-approval-feature.md)를 기준으로 한다.
