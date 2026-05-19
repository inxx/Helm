# Phase 3a Implementation Plan

작성일: 2026-05-19

## 목표

Phase 3a의 목표는 Phase 2의 stub role run 계약을 유지한 채 실제 host 실행을 받을 수 있는 기반을 만드는 것이다.

완료 기준:

1. 태스크별 Git worktree를 만들고 DB/audit/UI에서 확인할 수 있다.
2. role 실행 전 Context Pack과 manifest를 artifact directory에 저장한다.
3. HelmHostRunner가 로컬 host에서 승인된 단일 command를 실행하고 stdout/stderr/result/summary/diff artifact를 남긴다.
4. 같은 task worktree에서 동시에 두 실행을 시작하지 않는다.
5. 실제 runner 결과도 Phase 2의 run history, artifact viewer, approval inbox 계약을 그대로 사용한다.

## Phase 3a task split

### 3a-1. Task worktree

상태: 구현 완료

범위:

- `task_worktrees` migration 추가
- `ensure_task_worktree(project_id, task_id)`
- `get_task_worktree(project_id, task_id)`
- 기본 worktree root: `<repo>/.helm/worktrees`
- branch 이름: `helm/<task-slug>-<task-id-prefix>`
- 생성/재사용 audit log 기록
- Task detail UI에서 worktree 준비와 branch/path 확인

주의:

- `.helm/` 경로는 Git 변경 파일 목록에서 제외한다.
- 기존 worktree가 이미 있으면 새로 만들지 않고 재사용한다.
- worktree path가 이미 존재하지만 DB row가 없으면 자동 덮어쓰기하지 않는다.

### 3a-2. Context Pack

상태: 구현 완료

추가된 command:

```text
prepare_role_context(project_id, task_id, role_id)
```

생성 artifact:

```text
.helm/artifacts/runs/<run-id>/context-pack.md
.helm/artifacts/runs/<run-id>/context-pack.json
.helm/artifacts/runs/<run-id>/structured-result.schema.json
```

Context Pack 최소 내용:

- project root
- task id/title/status/description
- external refs
- worktree branch/path
- recent commits summary
- changed files summary
- role id와 expected output contract

주의:

- context 준비는 `agent_runs.status='Queued'` row를 만든다.
- `summary.md`, placeholder `structured-result.json`, `stdout.log`, `stderr.log`도 함께 생성해 기존 artifact viewer 계약을 유지한다.
- `context-pack.md`, `context-pack.json`, `structured-result.schema.json`은 run artifact allowlist에 포함한다.

### 3a-3. HelmHostRunner

상태: 기본 구현 완료

추가된 command:

```text
run_host_role(project_id, run_id)
```

실행 전 조건:

- task worktree 존재
- 같은 task에 `Running` agent run 없음
- role별 상태 전이 조건 통과
- `agent_runs.status='Queued'`
- role preset에 `commandArgs` 또는 `commandTemplate`이 명시적으로 설정됨

실행 산출물:

```text
summary.md
structured-result.json
stdout.log
stderr.log
diff.patch
changed-files.json
context-pack.md
context-pack.json
```

판정 규칙:

- exit code, 실제 changed files, diff는 Helm이 직접 계산한다.
- `structured-result.json`이 없거나 schema 검증 실패면 `NeedsInspection`으로 멈춘다.
- 자동 상태 전이는 schema 검증을 통과한 `pass` 결과에서만 수행한다.

주의:

- 현재 구현은 shell을 통하지 않고 command/args를 직접 실행한다.
- `commandArgs` 문자열 배열을 우선 사용하고, `commandTemplate`은 공백 기준으로 분리한다.
- `timeoutSeconds`를 role preset에서 읽고 기본값은 1800초다.
- 설정 화면에서 `rolePresets` JSON을 저장해 host command를 지정할 수 있다.

### 3a-4. Cancel/retry/timeout

상태: 구현 완료

범위:

- running process registry
- cancel command
- timeout seconds 설정
- retry 시 기존 artifact 보존
- orphan run 표시

현재 cancel 구현:

- `run_host_role` 실행 시 Tauri `AppState.running_runs`에 run id별 cancellation flag를 등록한다.
- `cancel_host_role(project_id, run_id)`는 실행 중인 run의 flag를 세운다.
- Host runner loop는 flag를 감지하면 child process를 kill하고 `AgentRunStatus='Canceled'`로 종료한다.
- cancel 결과도 `summary.md`, `structured-result.json`, `stdout.log`, `stderr.log`, `changed-files.json`, `diff.patch`, audit log 계약을 유지한다.

현재 retry 구현:

- `retry_host_role(project_id, run_id)`는 `Failed`, `TimedOut`, `NeedsInspection`, `Canceled` 계열의 완료된 run에서 새 `Queued` run과 Context Pack을 만든다.
- 기존 artifact는 삭제하거나 덮어쓰지 않는다.

## Phase 3b로 넘길 계약

DockerHermesObserver는 HelmHostRunner가 만든 run event와 artifact만 관찰한다. provider credential, command 실행, task status transition, approval source of truth는 Helm backend가 계속 소유한다.

## 추가 구현: 기본 터미널 실행기

상태: 구현 완료

사용자 요청으로 Phase 4의 full PTY 터미널 전에 기본 터미널 실행기를 먼저 추가했다.

범위:

- `run_terminal_command(project_id, cwd_mode, task_id, command)`
- `cwd_mode='project'`: 프로젝트 root에서 실행
- `cwd_mode='worktree'`: 선택한 task worktree에서 실행
- `/bin/zsh -lc <command>`로 실행
- stdout/stderr/exit code/timeout 결과를 UI에 표시
- 출력은 64KiB로 제한한다.
- 기본 timeout은 600초다.

아직 남은 터미널 장기 범위:

- xterm.js 기반 interactive PTY
- 여러 터미널 세션
- split pane
- resize/focus
- 앱 재시작 후 orphan terminal recovery
