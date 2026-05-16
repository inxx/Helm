# Helm Phase 0-1 Implementation Plan

작성일: 2026-05-16

## 목적

이 문서는 `docs/orchestrator-design.md`를 실제 구현으로 옮기기 전, 기존 CLI MVP를 어떻게 다룰지와 새 Tauri 데스크톱 앱의 Phase 1 범위를 확정한다.

이번 범위는 다음 3가지다.

1. 기존 CLI MVP와 임시 UI 변경분을 보존/폐기/참고로 분류한다.
2. 새 Tauri 앱 전환 전략을 확정한다.
3. Phase 1 구현을 작은 작업 단위로 쪼갠다.

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

### 폐기 또는 원복할 것

아래 파일의 현재 uncommitted 변경은 새 데스크톱 UI 방향과 맞지 않는 임시 세션 대시보드 개편이다.

- `src/ui/server.ts`
- `src/ui/static/app.js`
- `src/ui/static/index.html`

Phase 0 cleanup에서는 이 변경을 새 Tauri UI로 가져가지 않는다. 구현 시작 전에 원복하거나, 필요하면 별도 legacy branch/patch로 보관한 뒤 main 작업 트리에서는 제거한다.

기존 static HTTP UI 전체는 새 제품의 기본 UI가 아니다. 새 UI는 Tauri + React에서 태스크 중심 화면으로 다시 만든다.

### Phase 0 완료 기준

- `docs/orchestrator-design.md`와 이 문서가 새 제품 기준 문서로 남아 있다.
- 기존 CLI MVP는 legacy reference로 분류되어 있다.
- uncommitted static UI 변경분 처리 방침이 확정되어 있다.
- 새 Tauri 앱을 기존 Node CLI 위에 덧씌우지 않고 별도 app으로 만든다는 전략이 확정되어 있다.

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

Phase 1 Tauri command:

```text
project.open(path)
project.getSnapshot(projectId)
settings.getEffective(projectId)
settings.updateProject(projectId, patch)
task.list(projectId)
task.create(projectId, input)
task.updateStatus(taskId, status)
audit.list(projectId)
git.getRepositoryState(projectId)
git.getLocalBranches(projectId)
git.getRecentCommits(projectId, limit)
git.getChangedFiles(projectId)
```

Phase 4 이후 Git command 후보:

```text
git.getBranchGraph(projectId, limit)
git.getCommitDetail(projectId, commitHash)
git.getFileDiff(projectId, path)
```

규칙:

- frontend에는 generic shell execute를 노출하지 않는다.
- git 상태 조회는 backend에서만 수행한다.
- Phase 1에서는 쓰기 작업을 `repo/.helm/helm.sqlite`와 `repo/.helm/artifacts/` 생성으로 제한한다.
- project root 파일 수정, agent 실행, merge, Jira/Slack API 호출은 Phase 1에서 금지한다.
- Git command는 read-only 조회만 허용한다. checkout, commit, merge, push, fetch는 Phase 1에서 금지한다.

Phase 1 Git DTO:

- `GitRepositoryState`: `currentBranch`, `head`, `isDetached`, `dirtyCount`, `stagedCount`, `unstagedCount`, `untrackedCount`, `userName`, `userEmail`
- `GitCommitSummary`: `hash`, `shortHash`, `authorName`, `authorEmail`, `committedAt`, `subject`, `refs`, `isMine`
- `GitBranchSummary`: `branchName`, `headHash`, `upstream`, `ahead`, `behind`, `isCurrent`
- `GitFileStatus`: `path`, `status`, `staged`, `renamedFrom`

### 3.3 SQLite Phase 1 schema

Phase 1 최소 schema는 이후 확장 가능해야 한다.

```text
schema_migrations
projects
project_settings
epics
tasks
audit_logs
```

최소 컬럼:

- `projects`: `id`, `rootPath`, `name`, `baseBranch`, `createdAt`, `updatedAt`
- `project_settings`: `projectId`, `key`, `valueJson`, `updatedAt`
- `epics`: `id`, `projectId`, `title`, `status`, `planPath`, `createdAt`, `updatedAt`
- `tasks`: `id`, `projectId`, `epicId`, `title`, `description`, `status`, `sortOrder`, `createdAt`, `updatedAt`
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
  base_branch TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE project_settings (
  project_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
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
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  epic_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (epic_id) REFERENCES epics(id) ON DELETE SET NULL
);

CREATE INDEX idx_epics_project_id ON epics(project_id);
CREATE INDEX idx_tasks_project_status_sort ON tasks(project_id, status, sort_order);

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
```

ID는 Rust backend에서 UUID v7 문자열로 생성한다. 시간은 RFC3339 UTC 문자열로 저장한다. SQLite connection은 `PRAGMA foreign_keys = ON`을 켠 뒤 사용한다.

최근 프로젝트 목록은 Phase 1에서 전역 app data에 별도 파일을 만들지 않고, 사용자가 열었던 각 repo의 `projects` row와 app memory state로만 처리한다. 앱 재시작 후 최근 목록 영속화는 Phase 2 이후 전역 설정 저장소에서 추가한다.

Phase 1 기본 상태:

- Epic 기본값: `Drafting`
- Task 기본값: `Planned`
- Task board 컬럼: `Planned`, `Ready`, `Coding`, `PlanVerification`, `CodeReview`, `Testing`, `MergeWaiting`, `Merged`, `Done`, `Blocked`

`AgentRun`, `Approval`, `ExternalSync`, `Jira`, `Slack`, `Worktree` schema는 Phase 2 이후에 추가한다.

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
- 상단 상태바: 프로젝트명, branch, 전체 진행률, 승인 대기 수, 실행 중 AI 수, token 소진률, 터미널 수
- 중앙: 태스크 보드
- 우측: 선택 태스크 상세

Phase 1에서 표시할 값:

- 프로젝트명
- branch/head/dirty count
- 에픽 목록
- 태스크 카드
- TaskStatus 한국어 라벨
- Git 요약: task branch, worktree path, 변경 파일 수, `깃에서 보기`
- 빈 상태
- 설정 skeleton 진입점

### 3.5.1 Git viewer skeleton

깃 화면은 Phase 1에서 read-only local viewer로만 구현한다.

표시 값:

- 현재 branch와 HEAD
- dirty/staged/unstaged/untracked 파일 수
- local branch 목록과 현재 branch 표시
- 최근 commit 목록
- `git config user.name`, `git config user.email` 기준 `내 커밋` badge
- 변경 파일 목록

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
- agent 실행, terminal PTY, Jira/Slack, worktree/merge는 아직 동작하지 않는 것이 정상이다.

## 다음 보완점 계획

다음 단계는 Phase 1의 범위를 다시 작게 고정하고, SQLite schema와 Tauri command DTO를 구현 가능한 수준으로 구체화하는 것이다.

### 1. Phase 1 범위 재고정

Phase 1은 실제 agent 실행, terminal PTY, worktree 생성, Jira/Slack/Obsidian 연동을 하지 않는다. 따라서 UI에 아래 값이 필요하면 실제 기능처럼 보이지 않도록 placeholder 또는 비활성 상태로만 표시한다.

- 승인 대기 수: `0` 또는 `준비 중`
- 실행 중 AI 수: `0` 또는 `준비 중`
- token 소진률: `준비 중`
- 터미널 수: `0` 또는 `준비 중`
- task branch/worktree path: Phase 1에서는 생성하지 않으므로 비활성 placeholder로 표시

태스크 상세의 `깃에서 보기`는 프로젝트 전체 Git 화면으로 이동하는 skeleton action까지만 허용한다. 태스크별 worktree graph, task commits 연결, merge 관련 UI는 Phase 2 이후로 미룬다.

### 2. TaskStatus 정합성 정리

결정: `Merged`를 canonical enum에 유지하고 Phase 1 보드 컬럼에도 `Merged`/`머지됨`을 포함한다.

`docs/orchestrator-design.md`의 TaskStatus, 이 문서의 board column, React status label mapping은 같은 enum 집합을 사용해야 한다.

### 3. SQLite schema와 DTO 구체화

Phase 1 구현 전에 아래를 코드로 옮긴다.

1. DB migration SQL과 파일명: `apps/desktop/src-tauri/migrations/0001_phase1.sql`
2. id 생성 방식: Rust backend UUID v7 문자열
3. foreign key와 unique constraint: 위 SQL 기준
4. timestamp 저장 형식: RFC3339 UTC 문자열
5. `recent projects` 저장 위치: Phase 1에서는 영속화하지 않고 app memory state로만 처리
6. Rust model과 Tauri command response DTO
7. React 화면 state shape

최소 schema는 `schema_migrations`, `projects`, `project_settings`, `epics`, `tasks`, `audit_logs`를 유지한다. `AgentRun`, `Approval`, `ExternalSync`, `Jira`, `Slack`, `Worktree`는 Phase 2 이후 migration으로 추가한다.

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

### 6. Phase 1 acceptance test 확정

Phase 1 완료 전 최소한 아래 시나리오를 확인한다.

1. `apps/desktop` Tauri 앱이 실행된다.
2. git repo를 프로젝트로 열면 `repo/.helm/helm.sqlite`가 생성된다.
3. 같은 프로젝트를 다시 열어도 migration이 중복 실패하지 않는다.
4. git repo가 아닌 경로를 열면 한국어 오류가 표시된다.
5. settings skeleton 값이 저장/로드된다.
6. epic/task 빈 상태와 task card 표시가 깨지지 않는다.
7. task create/update status가 DB와 UI에 반영된다.
8. Git 화면이 current branch, HEAD, dirty count, local branches, recent commits, changed files를 표시한다.
9. 기존 Node CLI를 실행하지 않아도 desktop app이 독립적으로 동작한다.
10. agent 실행, terminal PTY, Jira/Slack, worktree/merge가 아직 동작하지 않는 것이 정상으로 보인다.

### 7. 구현 전 정리 순서

우선순위:

1. 기존 static UI uncommitted 변경분 처리 방침 확정
2. Phase 1 TaskStatus enum과 board column 확정
3. DB migration SQL 확정
4. Rust model/command DTO 확정
5. React 화면 state shape 확정
6. Phase 1 acceptance test 목록 확정
7. Phase 2 이후 품질 게이트 결과 schema와 artifact metadata audit 설계

기존 static UI 변경분 처리 결정: `src/ui/server.ts`, `src/ui/static/app.js`, `src/ui/static/index.html`의 현재 uncommitted 변경은 Phase 1 Tauri UI로 가져가지 않는다. 구현 시작 전에는 별도 legacy patch로 저장하거나 원복한다. 이 결정 전까지 해당 파일에 새 기능을 덧붙이지 않는다.
