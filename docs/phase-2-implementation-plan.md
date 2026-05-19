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

Phase 2 artifact path 저장 규칙:

- DB에는 repo root 기준 상대 경로만 저장한다.
- `artifact_dir` 예: `.helm/artifacts/runs/<agent-run-id>`
- `summary_path` 예: `.helm/artifacts/runs/<agent-run-id>/summary.md`
- `result_path` 예: `.helm/artifacts/runs/<agent-run-id>/structured-result.json`
- `stdout_log_path` 예: `.helm/artifacts/runs/<agent-run-id>/stdout.log`
- `stderr_log_path` 예: `.helm/artifacts/runs/<agent-run-id>/stderr.log`
- frontend는 path를 직접 파일 시스템에서 열지 않고, 항상 `read_run_artifact`를 통해 읽는다.
- backend는 열린 project registry의 root path와 repo-relative path를 조합해 파일을 읽는다.

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

Phase 2 migration 파일은 `apps/desktop/src-tauri/migrations/0002_phase2_runs_approvals.sql`로 둔다.

```sql
CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  status TEXT NOT NULL,
  artifact_dir TEXT NOT NULL,
  summary_path TEXT NOT NULL,
  result_path TEXT NOT NULL,
  stdout_log_path TEXT NOT NULL,
  stderr_log_path TEXT NOT NULL,
  exit_code INTEGER,
  result_status TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (role_id IN ('planner', 'coder', 'plan_verifier', 'code_reviewer', 'tester')),
  CHECK (status IN ('Queued', 'Running', 'Succeeded', 'Failed', 'Canceled', 'TimedOut', 'NeedsInspection')),
  CHECK (result_status IS NULL OR result_status IN ('pass', 'fail', 'needs_changes')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX idx_agent_runs_task_created ON agent_runs(task_id, created_at);
CREATE INDEX idx_agent_runs_project_status ON agent_runs(project_id, status);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  approval_type TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_reason TEXT NOT NULL,
  decision_reason TEXT,
  requested_at TEXT NOT NULL,
  decided_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (entity_type IN ('Task', 'AgentRun')),
  CHECK (approval_type IN ('PlanApproval', 'RunApproval', 'ManualStatusChange')),
  CHECK (status IN ('Pending', 'Approved', 'Rejected', 'Expired')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX idx_approvals_project_status ON approvals(project_id, status);
CREATE INDEX idx_approvals_entity ON approvals(entity_type, entity_id);
```

Phase 2 migration 규칙:

- `0002`도 Phase 1과 동일하게 transaction 안에서 실행한다.
- 성공 시 같은 transaction에서 `schema_migrations`에 version `2`, name `phase2_runs_approvals`를 기록한다.
- `agent_runs.artifact_dir`과 path 컬럼은 상대 경로인지 검증한다. 절대 경로, 빈 문자열, `..` segment는 저장하지 않는다.
- `approvals.entity_id`는 `entity_type`에 따라 task id 또는 agent run id를 저장한다. SQLite FK는 다형 관계를 직접 강제하지 못하므로 backend command에서 존재 여부를 검증한다.

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

Phase 2 input DTO:

```text
RunStubRoleInput {
  projectId: string
  taskId: string
  roleId: "planner" | "coder" | "plan_verifier" | "code_reviewer" | "tester"
}

ListAgentRunsInput {
  projectId: string
  taskId: string
}

GetAgentRunInput {
  projectId: string
  runId: string
}

ReadRunArtifactInput {
  projectId: string
  runId: string
  artifactName: "summary.md" | "structured-result.json" | "stdout.log" | "stderr.log"
}

ListApprovalsInput {
  projectId: string
  status?: "Pending" | "Approved" | "Rejected" | "Expired"
}

ApprovalDecisionInput {
  projectId: string
  approvalId: string
  reason: string
}
```

Phase 2 response DTO:

```text
AgentRunSummary {
  id: string
  projectId: string
  taskId: string
  roleId: string
  status: AgentRunStatus
  artifactDir: string
  summaryPath: string
  resultPath: string
  stdoutLogPath: string
  stderrLogPath: string
  exitCode: number | null
  resultStatus: "pass" | "fail" | "needs_changes" | null
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
  updatedAt: string
}

ApprovalSummary {
  id: string
  projectId: string
  entityType: "Task" | "AgentRun"
  entityId: string
  approvalType: "PlanApproval" | "RunApproval" | "ManualStatusChange"
  status: ApprovalStatus
  requestedReason: string
  decisionReason: string | null
  requestedAt: string
  decidedAt: string | null
  createdAt: string
  updatedAt: string
}
```

`run_stub_role`은 실제 process를 실행하지 않는다. Helm backend가 `.helm/artifacts/runs/<agent-run-id>/` 아래에 stub artifact를 생성하고, `agent_runs`와 `audit_logs`를 기록한다.

Phase 2 role catalog:

| role_id | 한국어 라벨 | stub result |
| --- | --- | --- |
| `planner` | 설계자 | 계획 요약과 `PlanApproval` 요청 생성 |
| `coder` | 구현자 | 구현 완료 stub 결과 생성 |
| `plan_verifier` | 계획 검토자 | 계획 준수 검토 stub 결과 생성 |
| `code_reviewer` | 코드 리뷰어 | 코드 리뷰 stub 결과 생성 |
| `tester` | 테스트 담당자 | 테스트 stub 결과 생성 |

`planner` run이 schema validation을 통과하고 `result_status='pass'`이면 backend가 같은 transaction에서 `PlanApproval`을 자동 생성한다. 별도 `create_approval` command는 Phase 2에 만들지 않는다.

`PlanApproval` 승인 전에는 `coder` run을 실행할 수 없다. 승인 여부는 `approvals` table의 `PlanApproval` row 중 `status='Approved'`인 항목으로 판단한다.

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

역할별 허용 상태와 전이:

| command/event | 허용 이전 상태 | 성공 시 task 상태 | 실패 또는 schema 오류 |
| --- | --- | --- | --- |
| `run_stub_role(planner)` | `Planned`, `Blocked` | 변경 없음, `PlanApproval Pending` 생성 | task 상태 유지, run `NeedsInspection` |
| `approve_approval(PlanApproval)` | `Planned`, `Blocked` | `Ready` | 해당 없음 |
| `reject_approval(PlanApproval)` | `Planned`, `Blocked` | `Blocked` | 해당 없음 |
| `run_stub_role(coder)` | `Ready` | `PlanVerification` | `Blocked` 또는 run `NeedsInspection` |
| `run_stub_role(plan_verifier)` | `PlanVerification` | `CodeReview` | `Blocked` 또는 run `NeedsInspection` |
| `run_stub_role(code_reviewer)` | `CodeReview` | `Testing` | `Blocked` 또는 run `NeedsInspection` |
| `run_stub_role(tester)` | `Testing` | `MergeWaiting` | `Blocked` 또는 run `NeedsInspection` |

세부 규칙:

- `NeedsInspection`은 AgentRun 상태다. schema validation 실패 시 TaskStatus는 이전 상태를 유지한다.
- schema는 통과했지만 `result_status='fail'`이면 TaskStatus를 `Blocked`로 전환한다.
- schema는 통과했지만 `result_status='needs_changes'`이면 TaskStatus를 `Blocked`로 전환하고 `status_reason`에 stub summary를 저장한다.
- `planner` run은 task 상태를 직접 `Ready`로 바꾸지 않는다. `PlanApproval` 승인만 `Ready` 전이를 수행한다.
- 이미 `Pending`인 `PlanApproval`이 있는 task에서 `planner`를 다시 실행하면 새 approval을 만들지 않고 `ValidationFailed`를 반환한다.
- 이미 `Approved`인 `PlanApproval`이 있는 task에서 `planner`를 다시 실행하면 새 approval을 만들지 않고 `ValidationFailed`를 반환한다.
- `ManualStatusChange`는 Phase 2에서 `update_task_status`의 수동 변경 감사 목적으로만 사용하며, 별도 approval gate로 강제하지 않는다.

금지 규칙:

- `PlanApproval` 승인 전 `coder` 실행 금지
- `NeedsInspection` run 이후 자동 상태 전이 금지
- `MergeWaiting` 이후 merge, push, fetch, PR 생성 금지
- Jira status만으로 Helm TaskStatus 자동 변경 금지
- frontend에서 artifact path를 직접 열거나 shell command 실행 금지

### Command error cases

Phase 2 command도 Phase 1의 `CommandError` 형식을 그대로 사용한다. 오류 `message`는 사용자에게 그대로 표시해도 어색하지 않은 한국어 문장으로 둔다.

Phase 2에서 새로 쓰는 의미상 오류:

| 상황 | code | message |
| --- | --- | --- |
| 열린 project registry에 없는 project id | `ProjectNotOpen` | "프로젝트가 열려 있지 않습니다. 다시 프로젝트를 열어주세요." |
| task id가 현재 project에 없음 | `ValidationFailed` | "대상 태스크를 찾을 수 없습니다." |
| run id가 현재 project에 없음 | `ValidationFailed` | "대상 실행 기록을 찾을 수 없습니다." |
| approval id가 현재 project에 없음 | `ValidationFailed` | "대상 승인 요청을 찾을 수 없습니다." |
| 알 수 없는 role id | `ValidationFailed` | "지원하지 않는 역할입니다." |
| 현재 TaskStatus에서 해당 role 실행 불가 | `ValidationFailed` | "현재 태스크 상태에서는 이 역할을 실행할 수 없습니다." |
| `PlanApproval` 승인 전 `coder` 실행 | `ValidationFailed` | "계획 승인 전에는 구현자 역할을 실행할 수 없습니다." |
| `PlanApproval Pending`이 이미 있는 task에서 `planner` 재실행 | `ValidationFailed` | "이미 대기 중인 계획 승인이 있습니다." |
| `PlanApproval Approved`가 이미 있는 task에서 `planner` 재실행 | `ValidationFailed` | "이미 승인된 계획이 있습니다." |
| 이미 결정된 approval 승인/반려 재시도 | `ValidationFailed` | "이미 처리된 승인 요청입니다." |
| approval decision reason이 빈 문자열 | `ValidationFailed` | "승인 또는 반려 사유를 입력해주세요." |
| artifact 이름이 allowlist 밖 | `ValidationFailed` | "허용되지 않은 실행 산출물입니다." |
| artifact path가 절대 경로 또는 `..` 포함 | `ValidationFailed` | "허용되지 않은 실행 산출물 경로입니다." |
| artifact 파일 누락 | `IoFailed` | "실행 산출물 파일을 찾을 수 없습니다." |
| artifact symlink 감지 | `ValidationFailed` | "심볼릭 링크 산출물은 열 수 없습니다." |
| structured result JSON parse 실패 | `ValidationFailed` | "실행 결과 JSON을 읽을 수 없습니다." |
| structured result schema validation 실패 | 성공 응답, run `NeedsInspection` | "검사가 필요한 실행 결과입니다." |
| stub artifact 쓰기 실패 | `IoFailed` | "실행 산출물을 저장하지 못했습니다." |
| DB transaction 실패 | `DatabaseOpenFailed` 또는 `IoFailed` | "Helm 데이터 저장에 실패했습니다." |

Command별 세부 동작:

- `run_stub_role`은 validation 오류가 있으면 artifact directory와 `agent_runs` row를 만들지 않는다.
- `run_stub_role` 중 artifact 쓰기 또는 DB transaction이 실패하면 partial row와 partial artifact를 성공 상태로 남기지 않는다.
- structured result schema validation 실패는 command 실패가 아니다. `AgentRunSummary.status='NeedsInspection'` 성공 응답을 반환하고, `agent_run.needs_inspection` audit log를 남긴다.
- `approve_approval`과 `reject_approval`은 `Pending` approval에만 허용한다.
- `approve_approval(PlanApproval)`은 approval status update, task status transition, audit log 생성을 하나의 transaction으로 처리한다.
- `reject_approval(PlanApproval)`은 approval status update, task `Blocked` transition, audit log 생성을 하나의 transaction으로 처리한다.
- `read_run_artifact`는 DB에 저장된 repo-relative path와 allowlisted artifact name을 조합하지 않는다. 항상 `artifact_dir + artifactName`을 backend에서 안전하게 resolve하고, resolve 결과가 `artifact_dir` 밖이면 `ValidationFailed`를 반환한다.

Phase 2는 별도 세분화된 error code enum을 추가하지 않는다. 구현 중 더 세분화가 필요해지면 `CommandError.details`에 debug string을 넣고, UI 분기는 기존 `code`만 사용한다.

### structured-result schema

Phase 2 구현 시 `apps/desktop/src-tauri/schemas/structured-result.schema.json`에 아래 계약을 둔다.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://inxx.local/helm/structured-result.schema.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["schemaVersion", "status", "summary", "changedFiles", "risks", "nextActions", "gateResult"],
  "properties": {
    "schemaVersion": {
      "type": "integer",
      "const": 1
    },
    "status": {
      "type": "string",
      "enum": ["pass", "fail", "needs_changes"]
    },
    "summary": {
      "type": "string",
      "minLength": 1
    },
    "changedFiles": {
      "type": "array",
      "items": { "type": "string" }
    },
    "risks": {
      "type": "array",
      "items": { "type": "string" }
    },
    "nextActions": {
      "type": "array",
      "items": { "type": "string" }
    },
    "gateResult": {
      "anyOf": [
        { "type": "null" },
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["gate", "status", "blocking", "blockers", "affectedFiles", "suggestedNext"],
          "properties": {
            "gate": {
              "type": "string",
              "enum": ["plan_verification", "code_review", "test", "security", "rules"]
            },
            "status": {
              "type": "string",
              "enum": ["pass", "warn", "fail"]
            },
            "blocking": {
              "type": "boolean"
            },
            "blockers": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": ["id", "severity", "summary"],
                "properties": {
                  "id": { "type": "string", "minLength": 1 },
                  "severity": { "type": "string", "enum": ["error", "warning"] },
                  "file": { "type": "string" },
                  "summary": { "type": "string", "minLength": 1 }
                }
              }
            },
            "affectedFiles": {
              "type": "array",
              "items": { "type": "string" }
            },
            "suggestedNext": {
              "type": "object",
              "additionalProperties": false,
              "required": ["action", "reason"],
              "properties": {
                "action": {
                  "type": "string",
                  "enum": ["fix", "retry", "request_changes", "approve", "manual_review"]
                },
                "reason": { "type": "string", "minLength": 1 }
              }
            }
          }
        }
      ]
    }
  }
}
```

Phase 2 stub result는 위 schema를 통과해야 한다. schema validation 실패 fixture를 만들기 위해 test helper는 의도적으로 `summary`를 누락한 artifact를 생성할 수 있어야 한다.

### audit payload 예시

`agent_run.created`:

```json
{
  "runId": "018f...",
  "taskId": "018e...",
  "roleId": "planner",
  "artifactDir": ".helm/artifacts/runs/018f..."
}
```

`agent_run.finished`:

```json
{
  "runId": "018f...",
  "taskId": "018e...",
  "roleId": "planner",
  "status": "Succeeded",
  "resultStatus": "pass",
  "exitCode": 0
}
```

`agent_run.needs_inspection`:

```json
{
  "runId": "018f...",
  "taskId": "018e...",
  "roleId": "planner",
  "reason": "structured-result.json schema validation failed"
}
```

`approval.created`:

```json
{
  "approvalId": "018a...",
  "approvalType": "PlanApproval",
  "entityType": "Task",
  "entityId": "018e...",
  "requestedReason": "planner stub run completed"
}
```

`approval.approved`:

```json
{
  "approvalId": "018a...",
  "approvalType": "PlanApproval",
  "entityType": "Task",
  "entityId": "018e...",
  "decisionReason": "계획 확인 완료"
}
```

`task.status_changed`:

```json
{
  "taskId": "018e...",
  "from": "Planned",
  "to": "Ready",
  "reason": "PlanApproval approved",
  "source": "approval"
}
```

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
4. `planner` run 성공 시 `PlanApproval Pending`이 자동 생성된다.
5. `PlanApproval` 승인 전 `coder` run은 `ValidationFailed`로 막힌다.
6. approval이 생성되고 승인/반려할 수 있다.
7. approval 결정은 audit log에 남는다.
8. task status 변경은 backend 규칙을 거치고 audit log에 남는다.
9. 역할별 상태 전이표가 command layer에서 강제된다.
10. command error cases의 사용자 표시 메시지와 `CommandError.code`가 구현된다.
11. UI에서 run history와 approval inbox가 깨지지 않는다.
12. UI에서 `summary.md`, `structured-result.json`, stdout/stderr artifact를 확인할 수 있다.
13. 실제 Claude/Codex, Docker Hermes, worktree 없이도 오케스트레이션 흐름이 검증된다.

검증 명령 기준:

- `cd apps/desktop && npm run typecheck`
- `cd apps/desktop && npm run build`
- `cd apps/desktop/src-tauri && cargo test`
- `cd apps/desktop/src-tauri && cargo check`

테스트 fixture 기준:

- migration idempotency
- `agent_runs` foreign key
- `approvals` status validation
- `agent_runs` path 컬럼의 절대 경로와 `..` segment 차단
- structured result success/failure
- artifact allowlist와 path traversal 차단
- `NeedsInspection` 표시
- `planner` success 후 `PlanApproval Pending` 자동 생성
- `PlanApproval` 승인 전 `coder` 실행 차단
- role별 허용 상태와 금지 상태 검증
- 이미 처리된 approval 재승인/재반려 차단
- approval decision reason 빈 문자열 차단
- artifact 파일 누락과 symlink 차단
- unknown role id 차단
- approval 승인/반려 audit event
- task status transition audit payload

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
