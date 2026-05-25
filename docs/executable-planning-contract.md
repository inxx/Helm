# Executable Planning Contract

작성일: 2026-05-25
상태: Draft

## 목적

Helm의 planning 단계는 단순한 phase 목록을 만드는 단계가 아니다. 사용자의 목표가 의미 있는 작업이라면 Helm은 승인 가능한 계획 문서를 만들면서 동시에 실행 가능한 작업 그래프를 만들어야 한다.

기본 원칙:

```text
큰 작업의 planning output = plan narrative + executable work graph
```

이 계약은 Planning Workspace, Plan Draft, `.helm/tasks.md`, backend queue/supervisor, 향후 multi-worker 실행이 같은 작업 단위를 공유하게 만드는 기준이다.

## 레퍼런스에서 가져온 기준

- Harnss: 여러 agent/session을 병렬로 두고 각 세션 상태, tool call, 변경사항을 사용자가 계속 볼 수 있게 한다.
- Hive: orchestrator가 worker에게 작업을 보내고 worker가 명시적으로 report한다. 작업 그래프는 repo-local markdown으로 남는다.
- Multica: issue와 task를 분리하고, task는 queue/dispatch/run/complete/fail/cancel 상태머신으로 관리한다.

Helm 적용 방향:

- plan은 사람이 읽는 설명문이어야 한다.
- 동시에 worker가 claim할 수 있는 task queue여야 한다.
- 병렬 작업은 파일 ownership, dependency, merge barrier가 명시될 때만 병렬로 둔다.
- 완료는 추정하지 않고 verification gate와 명시 report로만 판단한다.

## 작업 크기 분류

planner는 먼저 작업을 세 종류 중 하나로 분류한다.

| 분류 | 기준 | planning output |
| --- | --- | --- |
| `trivial` | 한 파일 또는 한 명령으로 끝나며 dependency가 거의 없음 | 짧은 plan + 단일 task card |
| `linear` | 순서가 중요하지만 병렬화 이점이 작음 | serial task graph |
| `graph-shaped` | 도메인/파일 영역이 나뉘고 병렬 실행 가능성이 있음 | full executable work graph |

`graph-shaped` 작업에 phase plan만 내는 것은 불충분하다. 반드시 아래 산출물을 포함한다.

## 필수 산출물

### 1. Task Graph

작업 그래프는 다음을 표현해야 한다.

- serial spine
- parallel lanes
- dependency edges
- merge barriers
- cleanup/final verification barriers
- explicit exclusions

예시:

```text
S0 repo audit
-> S1 coverage guard
-> S2 shared provider kit
-> S3 baseline report
-> [P1 products pages, P2 customers pages, P3 display pages]
-> [M1 products modals, M2 customers modals, M3 display modals]
-> S4 route/detail pass
-> S5 fake cleanup
-> S6 final verification
```

### 2. Task Cards

각 task card는 worker가 그대로 claim할 수 있어야 한다.

필수 필드:

```text
id
title
type
status
goal
dependsOn
canRunInParallel
ownedFiles
readOnlyFiles
sharedFiles
generatedFilesPolicy
doneWhen
verifyCommand
reportFormat
blockerPolicy
```

권장 type:

```text
serial-foundation
parallel-domain
parallel-review
serial-integration
serial-cleanup
serial-final-verification
explicit-exclusion
```

상태:

```text
ready
claimed
in_progress
blocked
review
done
failed
cancelled
```

### 3. Ownership Map

병렬 실행의 핵심은 파일 ownership이다.

ownership map은 최소한 아래를 구분한다.

- worker가 수정할 수 있는 owned files
- 읽기만 가능한 read-only files
- coordinator만 수정할 수 있는 shared files
- 직접 수정 금지인 generated files
- docs/report처럼 merge barrier에서만 갱신할 files

규칙:

- 같은 파일을 두 parallel task가 owned files로 가질 수 없다.
- shared config, root package manager files, generated route files, final report files는 coordinator-only로 둔다.
- coverage/report 문서는 각 lane이 직접 갱신하지 않고 merge barrier에서 갱신한다. 단, 단일 worker 실행이면 예외를 둘 수 있다.

### 4. Barriers

barrier는 병렬 lane을 안전하게 합치는 지점이다.

필수 barrier:

- foundation barrier: 공통 helper, guard, baseline이 준비됐는지 확인
- domain merge barrier: domain lane 결과를 coverage/report에 반영
- cleanup barrier: fake, 중복, dead story/code 정리
- final verification barrier: 전체 check/build/smoke

각 barrier는 아래를 가진다.

```text
id
waitsFor
ownedFiles
checks
mergePolicy
failurePolicy
```

### 5. Verification Gates

검증은 task, batch, final 세 레벨로 나눈다.

- per-task gate: task card의 verifyCommand와 doneWhen
- per-batch gate: domain lane 또는 milestone 단위 coverage/test/build
- final gate: 전체 check/build/browser smoke/manual QA

검증 명령을 실행할 수 없는 경우도 결과로 남긴다.

```text
not_run
reason
residual_risk
next_verification_step
```

### 6. Report Contract

worker report는 자유 감상문이 아니라 Helm이 상태 전환에 쓸 수 있는 요약이어야 한다.

필수 항목:

```text
taskId
status
changedFiles
coverageDelta
verification
blockers
exclusions
nextRecommendedTask
```

## 병렬화 규칙

task가 병렬 실행 가능하려면 모든 조건을 만족해야 한다.

- dependency가 명시되어 있다.
- owned files가 다른 running task와 겹치지 않는다.
- shared files는 barrier 뒤로 밀려 있다.
- generated files를 직접 수정하지 않는다.
- task 자체의 doneWhen과 verifyCommand가 있다.
- 실패했을 때 blockerPolicy가 있다.

조건을 만족하지 못하면 serial task로 둔다.

## Plan Draft 적용

Plan Draft는 사람이 읽는 `plan_markdown`과 구조화된 `draft_json`을 함께 저장한다. non-trivial draft의 `draft_json`에는 `executablePlan` 블록을 포함한다.

필수 구조:

```json
{
  "executablePlan": {
    "classification": "graph-shaped",
    "taskGraph": {
      "serialSpine": [],
      "parallelLanes": [],
      "barriers": []
    },
    "taskCards": [],
    "ownershipMap": {
      "ownedFiles": {},
      "sharedFiles": [],
      "generatedFiles": []
    },
    "verificationGates": [],
    "reportContract": {}
  }
}
```

`trivial` 작업은 단일 task card만 둬도 된다. 다만 `doneWhen`과 `verifyCommand`는 비워두지 않는다.

## 완료 정의

planning 단계가 완료됐다고 말하려면 아래가 충족되어야 한다.

- 사용자가 읽을 수 있는 plan narrative가 있다.
- 실행자가 claim할 수 있는 task cards가 있다.
- dependency와 병렬 가능성이 graph로 표현되어 있다.
- 파일 ownership과 shared-file barrier가 명시되어 있다.
- verification gate가 task/batch/final로 분리되어 있다.
- blocker와 report 형식이 정해져 있다.
- open question이 blocking인지 non-blocking인지 구분되어 있다.

이 조건을 만족하지 못하면 계획은 `ReadyForApproval`이 아니라 `NeedsUserInput` 또는 `Drafting`에 머문다.
