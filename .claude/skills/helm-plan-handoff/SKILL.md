---
name: helm-plan-handoff
description: Claude Code에서 작업 계획을 세우고, Helm이 그대로 materialize할 수 있는 plan draft JSON으로 내보낼 때 사용한다. "Helm 계획 만들어줘", "Helm으로 넘길 계획", "plan draft JSON", "executablePlan", "Helm 핸드오프" 같은 요청에 트리거. orchestrator/planner 단계를 건너뛰고 작업자 단계부터 Helm에 넘기는 A 경로.
---

# Helm Plan Handoff

Claude Code에서 계획을 세우고, **planner 역할을 건너뛰고** 작업자(coder) 단계부터 Helm에 넘긴다. 산출물은 Helm의 `savePlanDraftRevision`이 `validate_plan_draft_json`으로 검증하는 `draftJson` 하나다. 검증은 백엔드가 하므로 여기서 모양만 정확히 맞추면 된다.

## 절차

1. 사용자 목표를 작업 단위(tasks)로 쪼갠다.
2. 아래 계약에 맞는 `draftJson`을 ```json 펜스 안에 출력한다.
3. 핸드오프 안내를 붙인다(아래 "Helm에 넣기").

## draftJson 계약

최상위:
```jsonc
{
  "title":   "...",        // 필수, 비어있으면 안 됨
  "summary": "...",        // 필수
  "scope": [], "openQuestions": [], "risks": [],   // 선택, 배열
  "tasks": [ /* ≥1개 */ ], // 필수
  "executablePlan": { ... } // 필수, object
}
```

`executablePlan` (전부 필수):
- `taskGraph`: ≥1 node. 각 node `id` 필수·유일. `dependsOn`은 존재하는 id만 참조, 자기참조 금지.
- `taskCards`: ≥1 card. `id`는 taskGraph id와 **1:1 대응**(모든 graph node에 대응 card 필요, 그 반대도).
- `ownershipMap`: ≥1.
- `barriers`: 배열 필수(빈 배열 허용).
- `verificationGates`: ≥1.

deep-contract 규칙 — card 중 하나라도 `ownedFiles`/`sharedFiles`/`generatedFiles`/`reportContract`/`generatedFilePolicy` 중 하나를 쓰면, **모든 card**가 `reportContract`와 `generatedFilePolicy`를 가져야 한다. (아래 템플릿은 항상 둘 다 넣어 이 규칙을 자동 만족.)

파일 경로 규칙 — `ownedFiles`/`sharedFiles`/`generatedFiles`는 **repo-relative**. 선행 `/` 금지, `..` 금지.

병렬 충돌 규칙 — 서로 의존경로가 없는(병렬) card끼리 `ownedFiles`가 겹치면 안 된다. 한 card의 `sharedFiles`가 병렬 card의 `ownedFiles`와 겹쳐도 안 된다. → 동시에 같은 파일을 쓰는 task는 `dependsOn`으로 직렬화하거나 ownedFiles를 분리한다.

## 검증된 템플릿 (이대로 채우면 통과)

`buildExecutablePlan`(PlanningScreen.tsx)이 만드는, 백엔드 검증을 통과하는 형태다. task 개수만큼 반복한다.

```json
{
  "title": "<목표 한 줄 제목>",
  "summary": "<무엇을 왜 하는지 1-2문장>",
  "scope": ["<포함 범위>"],
  "openQuestions": [],
  "risks": ["<주요 리스크>"],
  "tasks": [
    {
      "title": "<task 제목>",
      "description": "<무엇을 구현/변경하는지>",
      "acceptanceCriteria": ["<완료 조건>"],
      "testPlan": ["pnpm typecheck", "<수동 확인 항목>"]
    }
  ],
  "executablePlan": {
    "taskGraph": [
      { "id": "task-1", "title": "<task 제목>", "dependsOn": [], "parallelizable": true, "batch": "batch-1" }
    ],
    "taskCards": [
      {
        "id": "task-1",
        "title": "<task 제목>",
        "ownerRole": "coder",
        "goal": "<무엇을 구현/변경하는지>",
        "inputs": ["Plan Document"],
        "outputs": ["<task> implementation artifact", "<task> verification evidence"],
        "ownedFiles": ["src/path/owned-by-this-task.ts"],
        "sharedFiles": [],
        "generatedFiles": [],
        "generatedFilePolicy": "Generated files are read-only unless an explicit generation command is listed in verification gates.",
        "reportContract": "taskId/status/changedFiles/verification/blockers",
        "acceptanceCriteria": ["<완료 조건>"],
        "verificationGates": ["gate-1"]
      }
    ],
    "ownershipMap": [
      { "ownerRole": "coder", "responsibilities": ["승인된 Task card 범위 안에서 구현한다."], "artifacts": ["Code changes"], "approver": "code_reviewer" }
    ],
    "barriers": [
      { "id": "barrier-plan-approval", "title": "Plan approval", "blocks": ["task-1"], "condition": "사용자가 Plan Document를 승인해야 Task로 materialize한다.", "ownerRole": "human" }
    ],
    "verificationGates": [
      { "id": "gate-1", "title": "<task> 검증", "type": "command", "command": "pnpm typecheck", "requiredEvidence": ["pnpm typecheck 통과"] }
    ]
  }
}
```

여러 task일 때: `taskGraph`/`taskCards`/`verificationGates`를 task 수만큼 늘리고, 직렬 의존이면 `dependsOn: ["task-N-1"]`, 병렬이면 `dependsOn: []` + `ownedFiles`를 겹치지 않게 분리한다. `barriers[].blocks`에 모든 task id를 넣는다.

## 자가 체크 (출력 전)

- [ ] title·summary 있음, tasks ≥1
- [ ] 모든 taskGraph id 유일, dependsOn이 존재하는 id만 참조, 자기참조 없음
- [ ] taskGraph ↔ taskCards id 1:1
- [ ] 모든 card에 reportContract + generatedFilePolicy
- [ ] 모든 ownedFiles/sharedFiles가 repo-relative (선행 `/` 없음, `..` 없음)
- [ ] 병렬 task끼리 ownedFiles 안 겹침
- [ ] verificationGates ≥1, barriers 배열 존재

## Helm에 넣기

Helm Planning 화면 → **"Claude Code 계획 JSON 가져오기"** 펼침 → 위 JSON 붙여넣기 → **가져오기**. planner 없이 Plan Document로 저장된다. 그다음 기존 **승인** 버튼을 누르면 다음 체인이 작업자 단계부터 굴러간다:
```
createPlanningSession({ goalText }) → savePlanDraftRevision({ draftJson }) → approvePlanDraft → materializePlanDraft → tasks → 작업자 dispatch
```
계약 위반이 있으면 `savePlanDraftRevision`이 한글 에러로 어떤 필드가 빠졌는지 알려준다 — 그 메시지대로 고쳐서 다시 넣으면 된다.
