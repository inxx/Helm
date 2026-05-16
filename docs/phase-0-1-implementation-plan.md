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
- Obsidian 문서 scan/backfill
- 기존 `.helm/sessions` 자동 migration

Phase 1은 앱 껍데기, 프로젝트 열기, DB 생성, 설정 skeleton, 태스크 보드 skeleton까지만 닫는다.

## 3. Phase 1 구현 분해

### 3.1 Desktop scaffold

목표:

- `apps/desktop/`에 Tauri v2 + React + Vite + TypeScript 앱을 만든다.
- 앱 전체 UI는 한국어 라이트 테마 고정으로 시작한다.
- 첫 화면은 landing이 아니라 실제 작업 화면인 `태스크` 메뉴다.

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
      TerminalScreen.tsx
      SettingsScreen.tsx
    components/
      AppShell.tsx
      StatusBar.tsx
      TaskBoard.tsx
      TaskDetail.tsx
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

Phase 1 Tauri command 후보:

```text
project.open(path)
project.getSnapshot(projectId)
project.getRecentProjects()
settings.getEffective(projectId)
settings.updateProject(projectId, patch)
task.list(projectId)
task.create(projectId, input)
task.updateStatus(taskId, status)
audit.list(projectId)
```

규칙:

- frontend에는 generic shell execute를 노출하지 않는다.
- git 상태 조회는 backend에서만 수행한다.
- Phase 1에서는 쓰기 작업을 `repo/.helm/helm.sqlite`와 `repo/.helm/artifacts/` 생성으로 제한한다.
- project root 파일 수정, agent 실행, merge, Jira/Slack API 호출은 Phase 1에서 금지한다.

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

Phase 1 기본 상태:

- Epic 기본값: `Drafting`
- Task 기본값: `Planned`
- Task board 컬럼: `Planned`, `Ready`, `Coding`, `PlanVerification`, `CodeReview`, `Testing`, `MergeWaiting`, `Done`, `Blocked`

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
-> branch/head/dirty count 조회
-> 태스크 화면 표시
```

오류 처리:

- git repo가 아니면 프로젝트 열기를 중단하고 한국어 오류를 보여준다.
- `.helm/` 생성 또는 SQLite open 실패는 수정 가능한 오류로 표시한다.
- 이미 열었던 프로젝트면 최근 프로젝트 목록에서 다시 열 수 있어야 한다.

### 3.5 Task board skeleton

태스크 화면 구성:

- 좌측 메뉴: `태스크`, `터미널`
- 상단 상태바: 프로젝트명, branch, 전체 진행률, 승인 대기 수, 실행 중 AI 수, token 소진률, 터미널 수
- 중앙: 태스크 보드
- 우측: 선택 태스크 상세

Phase 1에서 표시할 값:

- 프로젝트명
- branch/head/dirty count
- 에픽 목록
- 태스크 카드
- TaskStatus 한국어 라벨
- 빈 상태
- 설정 skeleton 진입점

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

Jira/Slack/API token 입력 UI와 Keychain 저장은 Phase 5/6에서 구현한다.

### 3.7 Phase 1 완료 기준

Phase 1은 아래가 모두 되면 완료다.

- `apps/desktop` Tauri 앱이 실행된다.
- 사용자가 git repo를 프로젝트로 열 수 있다.
- `repo/.helm/helm.sqlite`가 생성되고 migration이 적용된다.
- 프로젝트 설정 skeleton이 저장/로드된다.
- 한국어 라이트 태스크 보드 skeleton이 표시된다.
- 빈 상태와 git repo 오류 상태가 깨지지 않는다.
- 기존 Node CLI를 실행하지 않아도 desktop app이 독립적으로 동작한다.
- agent 실행, terminal PTY, Jira/Slack, worktree/merge는 아직 동작하지 않는 것이 정상이다.

## 다음 계획

다음 단계는 Phase 1의 SQLite schema와 Tauri command DTO를 더 구체화하는 것이다.

우선순위:

1. DB migration SQL 확정
2. Rust model/command DTO 확정
3. React 화면 state shape 확정
4. Phase 1 acceptance test 목록 확정
