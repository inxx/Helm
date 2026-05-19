# Helm Phase 2 Implementation Plan

작성일: 2026-05-19

## 목적

Phase 2는 Helm이 단순 task board가 아니라 오케스트레이터라는 것을 증명하는 첫 vertical slice다.

이번 범위는 실제 Claude/Codex 실행이 아니다. 목표는 `stub role run -> structured result -> approval -> audit log -> 상태 전이`가 DB와 UI에 일관되게 반영되는 것이다.

Phase 2 성공 기준:

- 실제 agent process 없이도 role run 기록이 생성된다.
- approval이 생성되고 사용자가 승인/반려할 수 있다.
- 상태 전이가 Helm backend 규칙으로만 일어난다.
- 모든 중요한 이벤트가 audit log에 남는다.
- UI에서 run history, approval inbox, `NeedsInspection`을 확인할 수 있다.

Phase 2에서 하지 않을 것:

- Claude/Codex 실제 실행
- DockerHermesObserver 실행
- task worktree 생성
- terminal PTY
- Jira/Slack/Obsidian backfill
- merge 또는 Git 쓰기 작업

## 모델과 schema

Phase 2 migration은 Phase 1 schema 위에 최소한 아래 모델을 추가한다.

```text
agent_runs
approvals
```

`agent_runs` 최소 컬럼:

- `id`
- `project_id`
- `task_id`
- `role_id`
- `status`
- `artifact_dir`
- `summary_path`
- `result_path`
- `stdout_log_path`
- `stderr_log_path`
- `exit_code`
- `result_status`
- `started_at`
- `finished_at`
- `created_at`
- `updated_at`

`AgentRunStatus`는 장기 설계의 enum을 그대로 쓴다.

```text
Queued
Running
Succeeded
Failed
Canceled
TimedOut
NeedsInspection
```

`approvals` 최소 컬럼:

- `id`
- `project_id`
- `entity_type`
- `entity_id`
- `approval_type`
- `status`
- `requested_reason`
- `decision_reason`
- `requested_at`
- `decided_at`
- `created_at`
- `updated_at`

`ApprovalStatus`는 장기 설계의 enum을 그대로 쓴다.

```text
Pending
Approved
Rejected
Expired
```

Phase 2 approval type:

- `PlanApproval`
- `RunApproval`
- `ManualStatusChange`

`audit_logs`는 Phase 1 table을 유지하고 event type만 확장한다.

Phase 2 audit event type:

- `agent_run.created`
- `agent_run.started`
- `agent_run.finished`
- `agent_run.needs_inspection`
- `approval.created`
- `approval.approved`
- `approval.rejected`
- `task.status_changed`

## Command와 상태 전이

Phase 2 Tauri command:

```text
run_stub_role(project_id, task_id, role_id)
list_agent_runs(project_id, task_id)
get_agent_run(project_id, run_id)
read_run_artifact(project_id, run_id, artifact_name)
list_approvals(project_id, status)
approve_approval(project_id, approval_id, reason)
reject_approval(project_id, approval_id, reason)
```

`run_stub_role`은 실제 process를 실행하지 않는다. Helm backend가 `.helm/artifacts/runs/<agent-run-id>/` 아래에 stub artifact를 생성하고, `agent_runs`와 `audit_logs`를 기록한다.

stub artifact:

```text
summary.md
structured-result.json
stdout.log
stderr.log
```

Phase 2에서 읽을 수 있는 artifact 이름은 아래로 제한한다.

```text
summary.md
structured-result.json
stdout.log
stderr.log
```

`read_run_artifact`는 `agent_runs.artifact_dir` 아래의 허용된 파일명만 읽는다. 상대 경로, 절대 경로, `..` path traversal, symlink target은 허용하지 않는다. Phase 2 artifact viewer는 repo 전체 Markdown viewer가 아니라 run artifact viewer다.

stub `structured-result.json` 최소 예:

```json
{
  "schemaVersion": 1,
  "status": "pass",
  "summary": "Stub role run completed.",
  "changedFiles": [],
  "risks": [],
  "nextActions": [],
  "gateResult": null
}
```

Phase 2 상태 전이 규칙:

- `run_stub_role`은 `AgentRunStatus=Succeeded` 또는 `NeedsInspection`을 만든다.
- structured result schema validation에 실패하면 run은 `NeedsInspection`으로 멈춘다.
- plan approval이 필요한 상태에서는 approval이 `Approved`가 되기 전 다음 role run을 실행하지 않는다.
- approval 승인/반려는 audit log를 남긴다.
- TaskStatus 변경은 backend command만 수행하고, 변경 전/후 상태와 이유를 audit log에 남긴다.

Phase 2에서는 전체 자동 chain을 만들지 않는다. 사용자가 버튼으로 stub role run과 approval 결정을 수행하고, Helm이 허용된 상태 전이만 적용한다.

## UI 기준

Phase 2 UI는 Phase 1 화면을 확장한다.

태스크 상세:

- run history 목록
- 최신 run status
- summary/result path
- `summary.md` 인라인 보기
- `structured-result.json` 보기
- stdout/stderr log 보기
- `NeedsInspection` 표시
- approval 상태

Approval inbox:

- pending approval 목록
- entity type과 reason
- 승인/반려 액션
- 결정 사유 입력

상태 표시:

- `Queued`, `Running`, `Succeeded`, `Failed`, `Canceled`, `TimedOut`, `NeedsInspection` 한국어 라벨
- `Pending`, `Approved`, `Rejected`, `Expired` 한국어 라벨

Phase 2에서도 아직 실제 agent, Docker Hermes, worktree, merge, Jira/Slack UI는 노출하지 않는다.

## 완료 기준과 검증

Phase 2 완료 기준:

1. task에서 stub role run을 생성할 수 있다.
2. run artifact와 `agent_runs` row가 생성된다.
3. schema validation 실패 run은 `NeedsInspection`으로 표시된다.
4. approval이 생성되고 승인/반려할 수 있다.
5. approval 결정은 audit log에 남는다.
6. task status 변경은 backend 규칙을 거치고 audit log에 남는다.
7. UI에서 run history와 approval inbox가 깨지지 않는다.
8. UI에서 `summary.md`, `structured-result.json`, stdout/stderr artifact를 확인할 수 있다.
9. 실제 Claude/Codex, Docker Hermes, worktree 없이도 오케스트레이션 흐름이 검증된다.

검증 명령 기준:

- `cd apps/desktop && npm run typecheck`
- `cd apps/desktop && npm run build`
- `cd apps/desktop/src-tauri && cargo test`
- `cd apps/desktop/src-tauri && cargo check`

테스트 fixture 기준:

- migration idempotency
- `agent_runs` foreign key
- `approvals` status validation
- structured result success/failure
- artifact allowlist와 path traversal 차단
- `NeedsInspection` 표시
- approval 승인/반려 audit event

## Phase 3로 넘길 계약

Phase 2가 끝나면 Phase 3a는 stub adapter를 `HelmHostRunner`로 교체한다.

Phase 3a에서 유지해야 할 계약:

- artifact directory 구조
- `structured-result.json` schema
- run artifact viewer 계약
- `AgentRunStatus`
- approval flow
- audit event type
- UI run history와 approval inbox

Phase 3b의 `DockerHermesObserver`는 provider credential이나 CLI 실행을 소유하지 않는다. Hermes는 Phase 3a에서 생성되는 run event와 artifact를 관찰하는 보조 계층으로만 붙인다.
