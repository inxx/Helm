# Helm Phase 0-1 Implementation Plan

작성일: 2026-05-16

## 목적

이 문서는 `docs/orchestrator-design.md`를 실제 구현으로 옮기기 전, 기존 CLI MVP를 어떻게 다룰지와 새 Tauri 데스크톱 앱의 Phase 1 범위를 확정한다.

이번 범위는 다음 3가지다.

1. 기존 CLI MVP와 임시 UI 변경분을 보존/폐기/참고로 분류한다.
2. 새 Tauri 앱 전환 전략을 확정한다.
3. Phase 1 구현을 작은 작업 단위로 쪼갠다.

## 문서 기준

`docs/orchestrator-design.md`는 제품 비전과 장기 아키텍처 기준이다. 이 문서는 Phase 0-1 구현 범위의 source of truth다.

따라서 Phase 1 구현 중 범위가 충돌하면 이 문서를 우선한다. 특히 agent 실행, terminal PTY, worktree, Jira/Slack, Obsidian backfill, quality gate, permission enforcement는 장기 설계에는 남기되 Phase 1 코드와 UI에서는 실제 기능처럼 보이지 않게 한다.

Phase 1의 성공 기준은 "미래 기능을 많이 보여주는 것"이 아니라, 프로젝트 열기, repo-local DB, 태스크/에픽 skeleton, 설정 skeleton, read-only Git snapshot이 깨지지 않고 독립 실행되는 것이다.

## Goal guardrails

Phase 0-1 구현은 장기 목표를 향한 발판이어야 한다. 따라서 작은 범위로 줄이되, 나중에 오케스트레이터가 되기 어려운 방향으로 편의 구현하지 않는다.

반드시 지킬 것:

- 기존 Node CLI를 새 desktop runtime dependency로 만들지 않는다.
- Phase 1 UI에 미래 기능을 실제 동작처럼 보이게 하지 않는다.
- task/status/settings/audit 모델은 Phase 2의 stub role run과 상태 전이를 받을 수 있게 둔다.
- Git 상태는 UI 추론이나 agent 보고가 아니라 backend가 직접 읽은 값을 기준으로 한다.
- `.helm/`은 repo-local metadata/artifact 저장소로 유지하되, user project source와 섞지 않는다.
- 새 Tauri frontend에는 generic shell execute를 열지 않는다.

Phase 1에서 하지 않을 것:

- agent 실행 흉내를 내는 fake run history
- Docker/Hermes observer 실행 또는 설정 UI 노출
- 실제 terminal이 없는 terminal UI 조작
- worktree/merge/Jira/Slack 값을 0이나 placeholder badge로 상단 상태바에 노출
- 기존 static HTTP UI를 새 desktop UX의 출발점으로 사용

## 성공 기준 보강

Phase 1은 빨리 닫아야 한다. 여기서 제품 가치를 증명하려고 하면 범위가 흐려진다. Phase 1은 "프로젝트를 열고, repo-local DB와 Git snapshot을 안전하게 다룰 수 있다"만 증명한다.

후속 성공 경로는 아래처럼 나눈다.

```text
Phase 2: stub role run + approval + audit log + 상태 전이
Phase 3a: task worktree + HelmHostRunner + Codex/Claude 단일 실행
Phase 3b: DockerHermesObserver + 실행 관찰/감사 보조
Phase 3c: verifier/reviewer/tester chain
```

Jira, Slack, terminal PTY, Git graph, backup/recovery는 이 core loop가 검증된 뒤 진행한다.

## 1. Phase 0 기존 상태 분류

### 보존할 개념

기존 Node CLI는 새 제품의 기반 코드가 아니라 참고 구현이다. 다만 아래 개념은 새 Rust/Tauri 구현으로 옮길 가치가 있다.

- `src/workspace/git.ts`
  - git root 탐지, branch/head/status 조회, 변경 파일 정규화, `.helm/` 제외 개념을 Rust backend로 포팅한다.
- `src/core/process.ts`
  - stdout/stderr 캡처와 스트리밍 실행 개념은 role runner와 terminal runner 설계 참고로 사용한다.
  - 단, 새 제품에서는 권한 모델과 controlled runner를 Rust backend에서 다시 구현한다.
- `src/session/store.ts`
  - session metadata와 artifact 파일을 분리해 저장하는 개념을 `AgentRun` + `.helm/artifacts` 모델로 확장한다.
  - JSON session store 자체는 유지하지 않고 SQLite로 대체한다.
- `src/harness/agents.ts`
  - agent binary resolution과 provider별 command 차이를 role adapter wrapper 설계 참고로 사용한다.
  - 새 구현에서는 agent 단위가 아니라 role preset 단위로 설정한다.
- 기존 테스트
  - git/status/process/session 동작의 의도 확인용 회귀 참고 자료로 둔다.
  - Tauri 구현의 테스트 대상은 Rust command, SQLite migration, React UI로 새로 작성한다.

### Legacy로 남길 것

- 현재 root Node package와 `inxx-helm` CLI는 Phase 1 구현 중에는 건드리지 않고 legacy reference로 둔다.
- `docs/next-steps.md`는 CLI MVP의 완료 기록으로 유지한다.
- 기존 `.helm/sessions/*.json` 데이터는 새 DB로 자동 migration하지 않는다. 필요하면 후속 import-only 도구로 다룬다.

### 새 제품 기반으로 쓰지 않을 것

아래 legacy static UI 파일은 새 데스크톱 UI 방향과 맞지 않는 세션 대시보드 reference다.

- `src/ui/server.ts`
- `src/ui/static/app.js`
- `src/ui/static/index.html`

Phase 0 cleanup에서는 이 UI를 새 Tauri UI로 가져가지 않는다. 해당 파일에는 새 제품 기능을 덧붙이지 않고 legacy reference로만 둔다.

기존 static HTTP UI 전체는 새 제품의 기본 UI가 아니다. `src/ui/static/app.css`를 포함한 기존 UI 자산은 legacy reference로만 보고, 새 UI는 Tauri + React에서 한국어 라이트 태스크 중심 화면으로 다시 만든다.

### Phase 0 완료 기준

- `docs/orchestrator-design.md`와 이 문서가 새 제품 기준 문서로 남아 있다.
- 기존 CLI MVP는 legacy reference로 분류되어 있다.
- legacy static UI 처리 방침이 확정되어 있다.
- 새 Tauri 앱을 기존 Node CLI 위에 덧씌우지 않고 별도 app으로 만든다는 전략이 확정되어 있다.
- 로컬 개발 환경의 최소 버전이 확인되어 있다.

### 구현 전 환경 체크

현재 root Node CLI는 Node.js 25 이상의 TypeScript type stripping을 전제로 한다. Node 20에서는 `node src/cli.ts`가 `.ts` 확장자를 직접 실행하지 못해 `npm run check`가 실패한다.

Phase 1 desktop 구현 전 확인 항목:

- Node.js 25 이상 또는 desktop app 전용 TypeScript/Vite toolchain
- Rust stable toolchain
- Tauri v2 prerequisites
- SQLite migration 테스트 가능 환경
- 기존 CLI 검증이 필요할 경우 Node 25로 실행한다는 명시

2026-05-17 당시 로컬 점검 결과:

- 당시 shell의 Node.js는 `v20.12.2`였다. 따라서 root legacy CLI의 `npm run check`는 `.ts` 직접 실행 단계에서 실패하는 것이 정상이었다.
- Rust는 `rustc 1.95.0`, `cargo 1.95.0`이 설치되어 있다.
- `cargo tauri` CLI는 아직 설치되어 있지 않다.
- Phase 1 구현 gate는 root `npm run check`가 아니라 `apps/desktop` 전용 build/test와 Rust backend test로 둔다. root legacy CLI 회귀 확인이 필요할 때만 Node.js 25 이상에서 별도로 실행한다.

2026-05-19 로컬 점검 결과:

- 현재 shell의 Node.js는 `v25.8.1`이다. root legacy CLI의 Node 25 요구사항은 현재 shell에서 충족된다.
- Rust는 `rustc 1.95.0`, `cargo 1.95.0`이 설치되어 있다.
- Docker CLI는 `29.1.3`, Docker Compose는 `v5.0.1`이 설치되어 있다.
- Docker daemon은 현재 실행 중이 아니다. DockerHermesObserver smoke test는 Docker Desktop 실행 후 별도로 확인한다.
- 로컬 하드웨어는 Apple M3 Pro, memory 약 38GB, 디스크 여유 약 273GiB로 Phase 3b의 Docker observer 실험에는 충분하다.
- 이 정보는 후속 runner 검토용이며 Phase 1 구현 gate에는 Docker 실행 가능 여부를 포함하지 않는다.

## 2. Tauri 전환 전략

### 기본 결정

새 데스크톱 앱은 기존 `src/`를 변환하지 않고 `apps/desktop/`에 새로 만든다.

```text
Helm/
  apps/
    desktop/
      package.json
      index.html
      src/
      src-tauri/
  docs/
  src/                 legacy Node CLI reference
  test/                legacy Node CLI tests
```

전환 원칙:

- 기존 Node CLI는 Phase 1에서 import하거나 runtime dependency로 쓰지 않는다.
- 새 backend는 Rust command layer가 담당한다.
- 새 frontend는 React/Vite/TypeScript로 만든다.
- 새 DB는 `repo/.helm/helm.sqlite`에 둔다.
- 새 artifact는 `repo/.helm/artifacts/`에 둔다.
- root Node package는 Phase 1 동안 legacy reference로 유지한다.
- desktop app이 Phase 1 완료 기준을 통과한 뒤 legacy CLI를 `legacy/node-cli/`로 이동하거나 제거할지 별도 cleanup 계획에서 결정한다.

### Phase 1에서 제외할 것

- 실제 agent 실행
- Docker/Hermes observer 실행
- terminal PTY와 split terminal 구현
- Jira/Slack 연결
- macOS Keychain 연동
- worktree 생성과 merge
- checkout, commit, merge, push, fetch 같은 Git 쓰기 동작
- Obsidian 문서 scan/backfill
- 기존 `.helm/sessions` 자동 migration
- quality gate 자동 판정
- artifact relation audit
- 프로젝트 학습/patch evolution

Phase 1은 앱 껍데기, 프로젝트 열기, DB 생성, 설정 skeleton, 태스크 보드 skeleton, read-only local Git viewer skeleton까지만 닫는다.

## 2.5 외부 레퍼런스 반영점

AI Factory와 AIF Handoff에서 기능 패턴만 참고한다.

- AI Factory: https://github.com/lee-to/ai-factory
  - Phase 1 참고: init/onboarding이 project context를 먼저 구성하는 방식, user-editable config와 managed state 분리
  - Phase 2 이후 참고: explore/grounded/plan/improve/implement/verify 흐름, artifact ownership, gate result schema, patch/evolve 학습 루프
- AIF Handoff: https://github.com/lee-to/aif-handoff
  - Phase 1 참고: 태스크 board 중심 정보 구조
  - Phase 2 이후 참고: stage 기반 pipeline, runtime profile resolution, stale-stage watchdog, manual handoff

Phase 1에서는 외부 레퍼런스의 자동 실행/완전 hands-off/daemon 구조를 가져오지 않는다.

## 3. Phase 1 구현 분해

### 3.1 Desktop scaffold

목표:

- `apps/desktop/`에 Tauri v2 + React + Vite + TypeScript 앱을 만든다.
- 앱 전체 UI는 한국어 라이트 테마 고정으로 시작한다.
- 첫 화면은 landing이 아니라 실제 작업 화면인 `태스크` 메뉴다.
- 최상위 메뉴는 `태스크`, `깃`, `터미널` 3개다.

초기 파일 구조:

```text
apps/desktop/
  package.json
  index.html
  src/
    main.tsx
    App.tsx
    styles.css
    lib/
      api.ts
      status.ts
    screens/
      TasksScreen.tsx
      GitScreen.tsx
      TerminalScreen.tsx
      SettingsScreen.tsx
    components/
      AppShell.tsx
      StatusBar.tsx
      TaskBoard.tsx
      TaskDetail.tsx
      RepositoryStatePanel.tsx
      BranchList.tsx
      CommitList.tsx
      ChangedFileList.tsx
  src-tauri/
    Cargo.toml
    tauri.conf.json
    src/
      main.rs
      commands/
        project.rs
        settings.rs
        task.rs
      db.rs
      git.rs
      models.rs
```

### 3.2 Rust backend command layer

Phase 1 command는 Rust 함수명은 snake_case로 두고, frontend `api.ts`에서 `project.open` 같은 namespace wrapper로 감싼다. Tauri invoke 이름에 dot 표기를 직접 쓰지 않는다.

Phase 1 Tauri command:

```text
open_project(path)
get_project_snapshot(project_id)
get_effective_settings(project_id)
update_project_settings(project_id, patch)
list_epics(project_id)
create_epic(project_id, input)
list_tasks(project_id)
create_task(project_id, input)
update_task_status(project_id, task_id, status, status_reason)
list_audit_logs(project_id, limit)
get_repository_state(project_id)
get_local_branches(project_id)
get_recent_commits(project_id, limit)
get_changed_files(project_id)
```

Phase 4 이후 Git command 후보:

```text
git.getBranchGraph(projectId, limit)
git.getCommitDetail(projectId, commitHash)
git.getFileDiff(projectId, path)
```

규칙:

- frontend에는 generic shell execute를 노출하지 않는다.
- directory picker가 필요하면 frontend는 Tauri dialog plugin으로 경로만 선택하고, repo 검증과 파일/DB 생성은 backend command가 담당한다.
- git 상태 조회는 backend에서만 수행한다.
- Phase 1에서는 쓰기 작업을 `repo/.helm/helm.sqlite`와 `repo/.helm/artifacts/` 생성으로 제한한다.
- project root 파일 수정, agent 실행, merge, Jira/Slack API 호출은 Phase 1에서 금지한다.
- Git command는 read-only 조회만 허용한다. checkout, commit, merge, push, fetch는 Phase 1에서 금지한다.
- backend는 열린 프로젝트를 app state의 `project_id -> root_path/db_path` registry에 보관한다. registry에 없는 `project_id` command는 `ProjectNotOpen` 오류로 실패한다.

Phase 1 공통 오류 형식:

```text
CommandError {
  code: "InvalidProjectPath" | "NotGitRepository" | "BareRepositoryUnsupported" | "ProjectNotOpen" | "DatabaseOpenFailed" | "MigrationFailed" | "SchemaTooNew" | "GitCommandFailed" | "ValidationFailed" | "IoFailed",
  message: 한국어 사용자 표시 문구,
  details: optional debug string
}
```

Rust command는 `Result<T, CommandError>`만 반환하고, frontend는 `code`로 UI 상태를 분기한다. `message`는 사용자에게 그대로 표시해도 어색하지 않은 한국어 문장으로 둔다.

Phase 1 핵심 DTO:

- `ProjectSummary`: `id`, `rootPath`, `name`, `baseBranch|null`, `createdAt`, `updatedAt`
- `ProjectSnapshot`: `project`, `settings`, `repository`, `epics`, `tasks`, `taskCounts`, `auditTail`
- `EffectiveSettings`: `rolePresets`, `worktreeRoot`, `obsidianVaultPath`, `tokenBudget`, `artifactRetentionDays`
- `EpicSummary`: `id`, `projectId`, `title`, `status`, `planPath`, `createdAt`, `updatedAt`
- `TaskExternalRefSummary`: `id`, `projectId`, `taskId`, `refType`, `refValue`, `refTitle`, `createdAt`
- `TaskSummary`: `id`, `projectId`, `epicId`, `title`, `description`, `status`, `statusReason`, `sortOrder`, `externalRefs`, `createdAt`, `updatedAt`, `lastTransitionAt`
- `AuditLogEntry`: `id`, `projectId`, `entityType`, `entityId`, `eventType`, `payload`, `createdAt`

Phase 1 Git DTO:

- `GitRepositoryState`: `currentBranch`, `head`, `isDetached`, `dirtyCount`, `stagedCount`, `unstagedCount`, `untrackedCount`, `userName`, `userEmail`
- `GitCommitSummary`: `hash`, `shortHash`, `authorName`, `authorEmail`, `committedAt`, `subject`, `refs`, `isMine`
- `GitBranchSummary`: `branchName`, `headHash`, `upstream`, `ahead`, `behind`, `isCurrent`
- `GitFileStatus`: `path`, `status`, `staged`, `renamedFrom`

Phase 1 input DTO:

```text
CreateEpicInput {
  title: string
  planPath?: string | null
}

TaskExternalRefInput {
  refType: "JiraEpic" | "JiraTask" | "MarkdownPlan" | "PlainText" | "Url"
  refValue: string
  refTitle?: string | null
}

CreateTaskInput {
  epicId?: string | null
  title: string
  description?: string
  externalRefs?: TaskExternalRefInput[]
}

UpdateTaskStatusInput {
  taskId: string
  status: "Planned" | "Ready" | "Coding" | "PlanVerification" | "CodeReview" | "Testing" | "MergeWaiting" | "Merged" | "Done" | "Blocked"
  statusReason?: string | null
}

UpdateProjectSettingsPatch {
  rolePresets?: unknown
  worktreeRoot?: string | null
  obsidianVaultPath?: string | null
  tokenBudget?: number | null
  artifactRetentionDays?: number | null
}
```

Phase 1 input validation:

- `title`은 trim 후 빈 문자열이면 `ValidationFailed`를 반환한다.
- `description`이 없으면 빈 문자열로 저장한다.
- `externalRefs`는 없거나 빈 배열이어도 정상이다.
- `externalRefs.refValue`는 trim 후 빈 문자열이면 저장하지 않고 `ValidationFailed`를 반환한다.
- Phase 1에서는 external ref 수정/삭제 command를 만들지 않는다. 잘못 입력한 참조는 task를 새로 만들거나 Phase 2 이후 별도 edit command에서 다룬다.
- `UpdateProjectSettingsPatch`는 알 수 없는 key를 허용하지 않는다.

### 3.3 SQLite Phase 1 schema

Phase 1 최소 schema는 이후 확장 가능해야 한다.

```text
schema_migrations
projects
project_settings
epics
tasks
task_external_refs
audit_logs
```

최소 컬럼:

- `projects`: `id`, `rootPath`, `name`, `baseBranch|null`, `createdAt`, `updatedAt`
- `project_settings`: `projectId`, `key`, `valueJson`, `updatedAt`
- `epics`: `id`, `projectId`, `title`, `status`, `planPath`, `createdAt`, `updatedAt`
- `tasks`: `id`, `projectId`, `epicId`, `title`, `description`, `status`, `statusReason`, `sortOrder`, `createdAt`, `updatedAt`, `lastTransitionAt`
- `task_external_refs`: `id`, `projectId`, `taskId`, `refType`, `refValue`, `refTitle`, `createdAt`
- `audit_logs`: `id`, `projectId`, `entityType`, `entityId`, `eventType`, `payloadJson`, `createdAt`

Phase 1 migration 파일은 `apps/desktop/src-tauri/migrations/0001_phase1.sql`로 둔다. 구현 시 SQL은 아래 결정을 따른다.

```sql
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  root_path TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  base_branch TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE project_settings (
  project_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (json_valid(value_json)),
  PRIMARY KEY (project_id, key),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE epics (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  plan_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (status IN ('Drafting', 'AwaitingPlanApproval', 'Approved', 'Splitting', 'Active', 'Done', 'Archived')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  epic_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  status_reason TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_transition_at TEXT NOT NULL,
  CHECK (status IN ('Planned', 'Ready', 'Coding', 'PlanVerification', 'CodeReview', 'Testing', 'MergeWaiting', 'Merged', 'Done', 'Blocked')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (epic_id) REFERENCES epics(id) ON DELETE SET NULL
);

CREATE INDEX idx_epics_project_id ON epics(project_id);
CREATE INDEX idx_tasks_project_status_sort ON tasks(project_id, status, sort_order);

CREATE TABLE task_external_refs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  ref_type TEXT NOT NULL,
  ref_value TEXT NOT NULL,
  ref_title TEXT,
  created_at TEXT NOT NULL,
  CHECK (ref_type IN ('JiraEpic', 'JiraTask', 'MarkdownPlan', 'PlainText', 'Url')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX idx_task_external_refs_task_id ON task_external_refs(task_id);

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (json_valid(payload_json)),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX idx_audit_logs_project_created ON audit_logs(project_id, created_at);
```

ID는 Rust backend에서 UUID v7 문자열로 생성한다. 시간은 RFC3339 UTC 문자열로 저장한다. SQLite connection은 `PRAGMA foreign_keys = ON`을 켠 뒤 사용한다. `base_branch`는 현재 branch나 사용자가 고른 기준 branch를 알 수 있을 때만 채운다. detached HEAD, empty repo, branch가 없는 repo에서는 `NULL`을 허용하고 UI에서 기준 branch 미설정 상태로 표시한다.

Migration runner 규칙:

- migration 파일은 `apps/desktop/src-tauri/migrations/0001_phase1.sql`부터 순번을 올린다.
- 앱이 지원하는 최신 schema version보다 DB의 `schema_migrations.version` 최댓값이 크면 `SchemaTooNew`로 프로젝트 열기를 중단한다.
- migration은 transaction 안에서 실행하고, 성공 시 같은 transaction에서 `schema_migrations`에 version/name/applied_at을 기록한다.
- fresh DB처럼 `schema_migrations`가 없으면 version `0`으로 본다.
- migration 실패 시 DB 파일을 삭제하거나 재생성하지 않는다.
- 모든 DB 쓰기 command는 성공/실패가 부분 반영되지 않도록 transaction을 사용한다.

`status_reason`은 `Blocked`나 사용자가 직접 상태를 바꾼 이유처럼 UI에 설명이 필요한 경우에만 채운다. 상태 변경은 모두 `audit_logs`에 `entity_type`, `entity_id`, `event_type`, `payload_json`으로 남긴다. Phase 1에서는 별도 transition table을 만들지 않고 audit log를 상태 변경 이력의 기준으로 사용한다.

최근 프로젝트 목록은 Phase 1에서 전역 app data에 별도 파일을 만들지 않고, 사용자가 열었던 각 repo의 `projects` row와 app memory state로만 처리한다. 앱 재시작 후 최근 목록 영속화는 Phase 2 이후 전역 설정 저장소에서 추가한다.

Phase 1 기본 상태:

- Epic 기본값: `Drafting`
- Task 기본값: `Planned`
- Task board 컬럼: `Planned`, `Ready`, `Coding`, `PlanVerification`, `CodeReview`, `Testing`, `MergeWaiting`, `Merged`, `Done`, `Blocked`
- 외부 Jira/Markdown/URL 참조는 `task_external_refs`에 metadata로 저장하되 Phase 1에서는 동기화하지 않는다.

`AgentRun`, `Approval`, `ExternalSync`, `Jira`, `Slack`, `Worktree` schema는 Phase 2 이후에 추가한다.

Phase 1 상태 변경 규칙:

- `create_epic`은 `Drafting`, `create_task`는 `Planned`를 기본값으로 쓴다.
- `create_task`는 optional `externalRefs`를 받을 수 있고, 허용된 `refType`만 저장한다.
- `update_task_status`는 위 canonical `TaskStatus` enum에 속한 값만 허용한다.
- Phase 1에서는 전체 상태 머신을 강제하지 않는다. 사용자가 skeleton에서 상태를 수동 변경할 수 있게 하되, 변경 전/후 상태와 `status_reason`을 audit log에 남긴다.
- Phase 2에서 role run과 approval model이 추가되면 자동 상태 전이 규칙을 migration 없이 얹을 수 있어야 한다.

### 3.4 Project open flow

흐름:

```text
프로젝트 열기
-> git repo 여부 확인
-> repo/.helm/ 디렉터리 생성
-> repo/.helm/helm.sqlite 생성 또는 open
-> migration 실행
-> project row upsert
-> Git repository snapshot 조회
-> 태스크 화면 표시
```

오류 처리:

- git repo가 아니면 프로젝트 열기를 중단하고 한국어 오류를 보여준다.
- `.helm/` 생성 또는 SQLite open 실패는 수정 가능한 오류로 표시한다.
- bare repo는 Phase 1에서 지원하지 않고 git repo 오류로 표시한다.
- detached HEAD는 프로젝트를 열 수 있지만 `currentBranch=null`, `isDetached=true`로 표시한다.
- SQLite schema version이 앱보다 높으면 프로젝트 열기를 중단하고 업그레이드 필요 오류를 보여준다.
- DB 파일이 열리지 않거나 migration이 실패하면 `.helm/helm.sqlite`를 자동 삭제하지 않고 복구 가능한 오류로 표시한다.

### 3.5 Task board skeleton

태스크 화면 구성:

- 좌측 메뉴: `태스크`, `깃`, `터미널`
- 상단 상태바: 프로젝트명, branch, head, dirty count, 태스크 수, 완료 수
- 중앙: 태스크 보드
- 우측: 선택 태스크 상세

Phase 1에서 표시할 값:

- 프로젝트명
- branch/head/dirty count
- 에픽 목록
- 태스크 카드
- TaskStatus 한국어 라벨
- Git 요약: 프로젝트 변경 파일 수, `깃에서 보기`
- 빈 상태
- 설정 skeleton 진입점

Phase 1 UI 노출 규칙:

| 기능 | Phase 1 처리 |
| --- | --- |
| 태스크 보드, 에픽 목록, 태스크 상세 | 실제 DB와 연결해 표시 |
| 프로젝트명, branch, head, dirty count | 실제 Git snapshot으로 표시 |
| read-only Git 화면 | 실제 local Git 조회로 표시 |
| 설정 skeleton | 저장/로드는 실제로 동작, 외부 연결은 placeholder |
| 터미널 메뉴 | 메뉴는 유지하되 "준비 중" skeleton만 표시 |
| 승인 대기 수, 실행 중 AI 수, token 소진률 | Phase 1 상태바에서 숨김 |
| task branch, worktree path, task commits | Phase 1 태스크 상세에서 숨김 |
| Jira, Slack, merge, review/test 상세 탭 | Phase 1에서 숨김 |

이 규칙은 placeholder 남발을 막기 위한 구현 기준이다. 기능이 준비되지 않았는데 실제 값처럼 보이는 `0`, `준비 중`, 비활성 pill을 화면 곳곳에 흩뿌리지 않는다.

### 3.5.1 Git viewer skeleton

깃 화면은 Phase 1에서 read-only local viewer로만 구현한다.

표시 값:

- 현재 branch와 HEAD
- dirty/staged/unstaged/untracked 파일 수
- local branch 목록과 현재 branch 표시
- 최근 commit 목록
- `git config user.name`, `git config user.email` 기준 `내 커밋` badge
- 변경 파일 목록

Git 구현 규칙:

- 기존 `src/workspace/git.ts`의 개념은 참고하되 Rust backend에서 새로 구현한다.
- 변경 파일 파싱은 `git status --porcelain=v1 -z` 또는 동등하게 안전한 machine-readable 형식을 사용한다.
- 공백, 한글, 특수문자가 포함된 파일명과 rename path를 깨뜨리지 않는다.
- `.helm/` 내부 파일은 dirty count와 변경 파일 목록에서 제외한다.
- detached HEAD, empty repo, upstream 없음, git user 미설정은 오류가 아니라 표시 가능한 상태로 둔다.

Phase 1 Git command 구현 기준:

- repo root 확인: `git -C <path> rev-parse --show-toplevel`
- bare repo 확인: `git -C <root> rev-parse --is-bare-repository`
- 현재 branch 확인: `git -C <root> symbolic-ref --quiet --short HEAD`; 실패하면 detached 또는 empty repo로 본다.
- HEAD 확인: `git -C <root> rev-parse --verify HEAD`; empty repo에서 실패하면 `head=null`로 둔다.
- 변경 파일: `git -C <root> status --porcelain=v1 -z`를 파싱한다.
- branch 목록: `git for-each-ref`의 machine-readable format을 사용하고, upstream 없음은 `null`로 둔다.
- 최근 commit: `git log -n <limit>`의 custom format을 사용하고, empty repo에서는 빈 배열을 반환한다.
- 사용자 정보: `git config --get user.name`, `git config --get user.email`; 미설정이면 `null`로 둔다.
- `.helm/` 제외는 Git command 인자에만 의존하지 말고 backend DTO 생성 직전에 `path === ".helm" || path.startsWith(".helm/")` 기준으로 한 번 더 필터링한다. rename은 이전/이후 path 둘 다 검사한다.

Phase 1에서 intentionally 없는 것:

- checkout
- commit
- merge
- push
- fetch
- conflict resolver
- task worktree graph

Phase 1 빈 상태:

- 프로젝트 없음
- 태스크 없음
- 에픽 없음
- git repo 아님
- DB open 실패

### 3.6 Settings skeleton

Phase 1 설정은 저장 구조만 만든다.

- 역할별 AI preset placeholder
- worktree root placeholder
- Obsidian vault path placeholder
- token budget placeholder
- artifact retention placeholder

저장 우선순위는 `project override > global default > built-in default`를 따른다.

Phase 1에서는 project override만 `project_settings`에 저장한다. global default 저장소는 만들지 않고 built-in default를 fallback으로 사용한다. 전역 설정 영속화는 Phase 2 이후 Tauri app data directory에 추가한다.

Jira/Slack/API token 입력 UI와 Keychain 저장은 Phase 5/6에서 구현한다.

Phase 1 project setting key:

- `rolePresets`
- `worktreeRoot`
- `obsidianVaultPath`
- `tokenBudget`
- `artifactRetentionDays`

위 값은 모두 non-secret metadata로만 취급한다. API token, Slack/Jira token, provider credential 입력 UI는 Phase 1에 만들지 않는다. `update_project_settings`는 알 수 없는 key를 저장하지 않고 `ValidationFailed`를 반환한다.

Hermes/Docker 관련 설정은 Phase 1에 만들지 않는다. Phase 3a에서 HelmHostRunner 설정이 확정된 뒤 `maxParallelRuns` 같은 실행 설정을 추가하고, Phase 3b에서 `observerEnabled`, `observerEndpoint`, `observerEventRetentionDays` 같은 DockerHermesObserver 설정을 별도 migration으로 추가한다. provider credential은 Hermes에 전달하지 않는다.

### 3.7 Phase 1 완료 기준

Phase 1은 아래가 모두 되면 완료다.

- `apps/desktop` Tauri 앱이 실행된다.
- 사용자가 git repo를 프로젝트로 열 수 있다.
- `repo/.helm/helm.sqlite`가 생성되고 migration이 적용된다.
- 프로젝트 설정 skeleton이 저장/로드된다.
- 한국어 라이트 태스크 보드 skeleton이 표시된다.
- read-only 깃 화면 skeleton이 local Git 상태를 표시한다.
- 빈 상태와 git repo 오류 상태가 깨지지 않는다.
- 기존 Node CLI를 실행하지 않아도 desktop app이 독립적으로 동작한다.
- agent 실행, Docker/Hermes observer, terminal PTY, Jira/Slack, worktree/merge는 아직 동작하지 않는 것이 정상이다.

## 구현 전 점검 목록

다음 단계는 Phase 1의 범위를 흔들리지 않게 고정한 뒤, SQLite schema와 Tauri command DTO를 코드로 옮기는 것이다.

### 1. Phase 1 범위 재고정

Phase 1은 실제 agent 실행, terminal PTY, worktree 생성, Jira/Slack/Obsidian 연동을 하지 않는다. 따라서 아래 값은 기본 화면에서 숨기고, 꼭 필요한 경우에만 설정 skeleton이나 terminal skeleton 안에서 준비 중 상태로 둔다.

- 승인 대기 수
- 실행 중 AI 수
- token 소진률
- 터미널 수
- task branch/worktree path
- runner type
- Docker/Hermes observer 상태
- max parallel runs

태스크 상세의 `깃에서 보기`는 프로젝트 전체 Git 화면으로 이동하는 skeleton action까지만 허용한다. 태스크별 worktree graph, task commits 연결, merge 관련 UI는 Phase 2 이후로 미룬다.

Phase 1 보드에는 장기 TaskStatus 전체 라벨을 둘 수 있지만 자동 실행 의미를 부여하지 않는다. 사용자가 상태를 바꾼 경우에도 Phase 1에서는 수동 상태 변경과 audit log만 남기고, AI run이나 gate가 실행된 것처럼 표시하지 않는다.

### 2. TaskStatus 정합성 정리

결정: `Merged`를 canonical enum에 유지하고 Phase 1 보드 컬럼에도 `Merged`/`머지됨`을 포함한다.

`docs/orchestrator-design.md`의 TaskStatus, 이 문서의 board column, React status label mapping은 같은 enum 집합을 사용해야 한다.

### 3. SQLite schema와 DTO 결정

Phase 1 구현에서는 아래 결정을 그대로 코드로 옮긴다.

1. DB migration SQL과 파일명: `apps/desktop/src-tauri/migrations/0001_phase1.sql`
2. id 생성 방식: Rust backend UUID v7 문자열
3. foreign key와 unique constraint: 위 SQL 기준
4. timestamp 저장 형식: RFC3339 UTC 문자열
5. `recent projects` 저장 위치: Phase 1에서는 영속화하지 않고 app memory state로만 처리
6. Rust model과 Tauri command response DTO: `ProjectSummary`, `ProjectSnapshot`, `EffectiveSettings`, `EpicSummary`, `TaskSummary`, `TaskExternalRefSummary`, `AuditLogEntry`, Git DTO 기준
7. React 화면 state shape: `ProjectSnapshot`을 화면 source of truth로 두고, create/update 이후 snapshot을 다시 조회한다.

최소 schema는 `schema_migrations`, `projects`, `project_settings`, `epics`, `tasks`, `task_external_refs`, `audit_logs`를 유지한다. `AgentRun`, `Approval`, `ExternalSync`, `Jira`, `Slack`, `Worktree`는 Phase 2 이후 migration으로 추가한다.

### 4. Git viewer 범위 축소

Phase 1 Git viewer는 read-only local viewer로 닫는다. 구현 범위는 아래로 제한한다.

- repository state: current branch, HEAD, dirty/staged/unstaged/untracked count
- local branch 목록과 현재 branch 표시
- 최근 commit 목록
- `git config user.name`, `git config user.email` 기준 `내 커밋` badge
- 변경 파일 목록

branch graph, commit detail view, file diff detail, task worktree graph는 Phase 4 UI 완성 범위로 미룬다. Phase 1 command에는 포함하지 않는다.

### 5. structured result 계약 정리

Phase 2 이후 agent 실행을 구현하기 전에 `structured-result.json` 계약을 하나로 합친다.

권장 방향:

- 모든 role은 공통 `structured-result.json`을 남긴다.
- 공통 필드는 `status`, `summary`, `changedFiles`, `risks`, `nextActions`를 유지한다.
- Plan Verifier, Code Reviewer, Tester, Security Reviewer 같은 gate role은 optional `gateResult` 객체를 추가한다.
- `gateResult` 안에 `gate`, `status`, `blocking`, `blockers`, `affectedFiles`, `suggestedNext`를 둔다.

이렇게 하면 Coder 결과와 gate 결과가 서로 다른 파일 계약으로 갈라지지 않는다.

실제 agent가 `summary.md`나 `structured-result.json`을 만들지 못하는 상황을 정상 오류로 다룬다. Phase 3 구현 시 Helm wrapper는 stdout/stderr, exit code, 실제 changed files를 기반으로 fallback run summary를 만들고, 해당 run은 `NeedsInspection`으로 멈춘다. 자동 진행은 schema validation을 통과한 structured result에서만 허용한다.

### 5.5 Runner/Observer 경계

Phase 2에서는 runner를 실제 process 실행으로 연결하지 않고 stub adapter로 닫는다. Phase 3부터 실행과 관찰을 아래 순서로 늘린다.

1. `HelmHostRunner`: task worktree에서 로컬 host의 인증된 Claude/Codex CLI를 1개만 실행한다.
2. `DockerHermesObserver`: Docker container에서 HelmHostRunner의 run event와 artifact를 관찰한다.
3. gate chain: Plan Verifier, Code Reviewer, Tester를 순차 실행한다.

기본 병렬 실행 수는 `1`이다. 같은 task worktree에는 둘 이상의 HelmHostRunner를 동시에 실행하지 않는다. `maxParallelRuns=2`는 cancel/retry, artifact 저장, diff 검증, orphan run 표시가 안정화된 뒤 프로젝트 설정으로 연다.

Hermes는 실행자가 아니라 관찰/감사 보조다. TaskStatus 전이, approval, 다음 role 결정, provider credential, Claude/Codex CLI 실행, audit source of truth는 Helm backend가 계속 소유한다.

### 6. Phase 1 acceptance test 확정

Phase 1 완료 전 최소한 아래 시나리오를 확인한다.

1. `apps/desktop` Tauri 앱이 실행된다.
2. git repo를 프로젝트로 열면 `repo/.helm/helm.sqlite`가 생성된다.
3. 같은 프로젝트를 다시 열어도 migration이 중복 실패하지 않는다.
4. git repo가 아닌 경로를 열면 한국어 오류가 표시된다.
5. settings skeleton 값이 저장/로드된다.
6. epic/task 빈 상태와 task card 표시가 깨지지 않는다.
7. task create/update status가 DB와 UI에 반영되고 audit log가 남는다.
8. Git 화면이 current branch, HEAD, dirty count, local branches, recent commits, changed files를 표시한다.
9. detached HEAD, empty repo, upstream 없음, git user 미설정 상태가 앱을 깨뜨리지 않는다.
10. 공백/한글/rename 파일명이 changed files에 정상 표시된다.
11. `.helm/` 내부 변경은 Git dirty count와 changed files에서 제외된다.
12. 기존 Node CLI를 실행하지 않아도 desktop app이 독립적으로 동작한다.
13. agent 실행, Docker/Hermes observer, terminal PTY, Jira/Slack, worktree/merge가 아직 동작하지 않는 것이 정상으로 보인다.
14. root CLI 검증이 필요하면 Node.js 25 이상에서 실행한다.

검증 명령 기준:

- `cd apps/desktop && npm run typecheck`
- `cd apps/desktop && npm run build`
- `cd apps/desktop/src-tauri && cargo test`
- `cd apps/desktop/src-tauri && cargo check`
- `cd apps/desktop && npm run tauri dev`로 수동 smoke test를 실행한다.
- root legacy CLI의 `npm run check`는 현재 shell이 Node.js 25 이상일 때만 Phase 1 부가 검증으로 실행한다.

테스트 fixture 기준:

- Rust DB 테스트는 임시 git repo와 임시 `.helm/helm.sqlite`를 만들어 migration idempotency, schema-too-new, foreign key, audit log를 확인한다.
- Rust Git 테스트는 clean repo, dirty repo, staged/unstaged/untracked, detached HEAD, empty repo, upstream 없음, git user 미설정, 공백/한글/rename 파일명을 fixture로 둔다.
- React 테스트는 프로젝트 없음, repo open 오류, task/epic empty state, task card, Git empty/dirty state가 깨지지 않는지 확인한다.

### 7. 구현 전 정리 순서

우선순위:

1. 기존 static UI를 legacy reference로 고정
2. Phase 1 TaskStatus enum과 board column 확정
3. Phase 1 UI 노출 규칙 확정
4. DB migration SQL 확정
5. Rust model/command DTO 확정
6. React 화면 state shape 확정
7. Phase 1 acceptance test 목록 확정
8. Phase 2 stub role run과 approval/audit vertical slice 설계
9. Phase 2 run artifact viewer 설계
10. Phase 3a HelmHostRunner 단일 실행 계약 설계
11. Phase 3b DockerHermesObserver 관찰/감사 계약 설계
12. Phase 3c 품질 게이트 결과 schema와 artifact metadata audit 설계

기존 static UI 처리 결정: `src/ui/server.ts`, `src/ui/static/app.js`, `src/ui/static/index.html`은 Phase 1 Tauri UI로 가져가지 않는다. 해당 파일에 새 제품 기능을 덧붙이지 않고, legacy reference로만 둔다.
