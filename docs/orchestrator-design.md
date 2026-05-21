# Helm Orchestrator Design

작성일: 2026-05-16

## 목적

Helm의 오케스트레이터는 AI가 아니다. Helm은 로컬 프로젝트에서 여러 AI 작업자를 역할별로 실행하고, 상태 전환과 승인 게이트를 관리하는 결정론적 프로그램이다.

핵심 목표는 다음 구조를 유지하는 것이다.

```text
AI 작업자 -> 직접 다른 AI 호출 금지
AI 작업자 -> Helm에 결과 보고
Helm -> 다음 role 실행 여부 결정
Helm -> 필요한 AI 작업자 실행
```

따라서 `Claude -> Codex`처럼 AI가 AI를 직접 부르는 구조가 아니라, 항상 `Claude -> Helm -> Codex` 구조를 사용한다.

## 제품 재설계 범위

Helm은 기존 CLI agent hub MVP에서 로컬 AI 개발 조직 운영 데스크톱 앱으로 재설계한다. 기존 CLI는 참고 구현으로 남기되, 새 제품의 기본 사용 경험은 데스크톱 앱이 맡는다.

### North Star

Helm의 목표는 "AI에게 일을 시키는 입력창"이 아니라, 로컬 프로젝트 안에서 AI 작업을 계획, 실행, 검토, 승인, 기록하는 운영 체계를 제공하는 것이다.

사용자는 Helm에서 다음 질문에 바로 답할 수 있어야 한다.

- 지금 어떤 에픽/태스크가 진행 중인가?
- 어떤 AI role이 무엇을 했고, 어떤 산출물을 남겼는가?
- 어떤 변경 파일과 diff가 실제로 생겼는가?
- 어떤 계획/리뷰/테스트/승인이 merge를 막고 있는가?
- 이 변경이 왜 들어갔고, 나중에 어디서 다시 확인할 수 있는가?

### 장기 제품 목표

- 프로젝트별 에픽, 태스크, 서브태스크 관리
- 역할별 AI 작업자 설정과 실행
- 계획 승인, 코딩, 계획 준수 검토, 코드 리뷰, 테스트, merge 승인 흐름 관리
- 태스크별 git worktree 격리
- Markdown/Obsidian 계획 문서 연동
- Jira 티켓 생성/상태 동기화
- Slack 업무 신호 수집과 승인 후 답장
- 독립 Git 화면: 브랜치 트리, 커밋 그래프, 현재 변경 상태, 내 커밋 추적
- 독립 터미널 화면과 분할 터미널
- 감사 로그, 권한 제한, 로컬 백업

### 첫 검증 목표

Phase 1은 제품 껍데기와 데이터 기반을 검증한다. Phase 2는 Helm이 단순 task board가 아니라 오케스트레이터라는 것을 증명하는 첫 vertical slice다.

```text
Phase 1: 프로젝트 열기 -> repo-local DB -> 태스크/Git skeleton
Phase 2: 태스크 생성 -> stub role run -> structured result -> audit log -> 상태 전이
Phase 3a: worktree -> Helm host runner -> Codex/Claude 단일 실행
Phase 3b: Docker Hermes observer -> 실행 관찰/감사 보조
Phase 3c: verifier/reviewer/tester chain -> merge 대기
```

Phase 2가 끝나기 전까지는 "AI 개발 조직 운영"을 제품 가치로 검증했다고 보지 않는다.

### 성공을 위한 축소 경로

Helm은 Jira, Slack, 터미널, Git graph를 모두 붙여야 가치가 생기는 제품이 아니다. 첫 성공은 "로컬 repo의 태스크 하나가 계획, 실행, 검토, 승인, 기록까지 추적된다"는 core loop에서 나온다.

따라서 구현 우선순위는 다음 원칙을 따른다.

- Phase 1은 제품 가치 검증이 아니라 기반 검증이다. 오래 끌지 않는다.
- Phase 2에서 상태 전이, 승인, stub run, audit log가 실제 UI와 DB에 일관되게 반영되어야 한다.
- Phase 3은 한 번에 구현하지 않고 `3a Helm host runner`, `3b Docker Hermes observer`, `3c gate chain`으로 나눈다.
- 실제 agent 실행은 `maxParallelRuns=1`에서 시작한다. worktree 격리, artifact 저장, diff 검증, cancel/retry가 안정화된 뒤 `2`로 올린다.
- Jira, Slack, terminal split, Git graph는 core loop가 검증된 뒤 붙인다.

## 참고 레퍼런스

Helm은 다른 프로젝트의 코드를 복사하지 않고, 기능 패턴만 참고한다.

- AI Factory: https://github.com/lee-to/ai-factory
  - 참고할 것: spec-driven workflow, explore/grounded/plan/improve/implement/verify 흐름, quality gate 결과 계약, artifact ownership, skill evolution 개념
  - 그대로 가져오지 않을 것: slash command 중심 UX, project 파일을 직접 설치/갱신하는 CLI-first 구조
- AIF Handoff: https://github.com/lee-to/aif-handoff
  - 참고할 것: AI task Kanban, stage 기반 자동 진행, runtime profile, review feedback rework loop, stale-stage watchdog, manual handoff
  - 그대로 가져오지 않을 것: hosted web service/agent daemon 전제, 완전 hands-off 기본값
- Envoy: https://github.com/statecraft-protocol/envoy
  - 참고할 것: shared context layer, task/evidence/decision/authority/provenance/audit/handoff 모델, command evidence와 approval record 형식, bounded MCP adapter의 allowlist/stdio/env 격리 원칙
  - 그대로 가져오지 않을 것: relay, invite/capability crypto, billing/Connected, Envoy CLI나 proprietary 배포물 코드. 공개 repo는 오픈소스 소스 릴리스가 아니므로 구현 아이디어만 참고한다.
- Hermes Desktop: https://github.com/dodo-reach/hermes-desktop
  - 참고할 것: direct SSH source-of-truth 모델, service SSH와 terminal SSH 분리, connection profile/workspace fingerprint, 안전한 원격 파일 편집, workflow preset, session pin/search, usage breakdown, release manifest/checksum 검증 흐름
  - 그대로 가져오지 않을 것: SwiftUI/SwiftTerm 화면 코드, Hermes 전용 Kanban/Cron/Skill 전체 제품 구조, remote host를 기본 source of truth로 두는 제품 전제

Helm의 차별점은 로컬 데스크톱 앱, 사용자 승인 중심, Obsidian/Jira/Slack/터미널/Git 화면을 한곳에 묶은 개인 작업 관제 경험이다.

## 단계 기준

이 문서는 장기 제품 설계와 phase roadmap을 함께 담는다. Phase 0-1의 실제 구현 범위는 `docs/phase-0-1-implementation-plan.md`를 우선한다.

Phase 1은 제품 골격을 검증하는 단계다. agent 실행, terminal PTY, worktree 생성, Jira/Slack, Obsidian backfill, quality gate, permission enforcement는 장기 설계에 남기되 Phase 1 UI와 command layer에서는 실제 기능처럼 노출하지 않는다.

핵심 vertical slice는 Phase 2에서 닫는다. 즉, `task 생성 -> stub role run -> structured result 저장 -> audit log -> 상태 전이`가 DB와 UI에 일관되게 반영되어야 Helm의 오케스트레이션 가치를 처음 검증할 수 있다.

## 기술 스택 방향

기존 Node CLI 기술 스택을 유지할 필요는 없다. 새 기본 스택은 다음을 목표로 한다.

- Desktop shell: Tauri v2
- Backend: Rust command layer
- Frontend: React, Vite, TypeScript
- Local state: SQLite
- Terminal: xterm.js + Rust PTY service
- Secret storage: macOS Keychain
- Git integration: git CLI 기반 worktree/branch/status/merge 관리
- Runner: HelmHostRunner가 로컬 host에서 Claude/Codex CLI 실행
- Observer: DockerHermesObserver는 Phase 3b에서 실행 관찰/감사 보조

Tauri를 선택한 이유는 로컬 데스크톱 앱으로 가볍게 배포하면서도 파일 시스템, 프로세스 실행, secure storage, 네이티브 창 제어를 다룰 수 있기 때문이다. agent 실행, git 조작, 터미널 PTY는 UI가 직접 수행하지 않고 backend command layer가 담당한다.

## 역할 분리

### Helm이 담당하는 일

- 현재 프로젝트, 에픽, 태스크 상태 관리
- 다음 단계 실행 여부 결정
- 역할별 AI 설정 조회
- Context Pack 구성
- agent command 실행
- stdout/stderr, diff, test 결과, review 결과 저장
- 승인 대기 상태 생성
- 실패/충돌/권한 차단 시 중단
- 토큰 추정 사용량 집계
- 감사 로그 기록

### AI 작업자가 담당하는 일

- 설계 초안 작성
- 코드 수정
- 계획 준수 검토
- 코드 퀄리티 리뷰
- 테스트 실행 또는 테스트 실패 분석
- 충돌 해결 제안 작성

AI 작업자는 다음 단계로 누구를 실행할지 결정하지 않는다. 다음 실행자는 Helm의 상태 머신이 결정한다.

## 기본 역할

역할은 설정창에서 변경할 수 있다.

```text
설계자        Planner
구현자        Coder
계획 검토자    Plan Verifier
코드 리뷰어    Code Reviewer
테스트 담당자  Tester
```

예시 설정:

```text
설계자        Codex
구현자        Claude
계획 검토자    Codex
코드 리뷰어    Gemini
테스트 담당자  Codex
```

설정 항목:

- provider
- model
- command template
- system prompt
- token budget
- 허용 명령 규칙

오케스트레이터 자체에는 AI provider/model을 설정하지 않는다.

## 상태 머신

상태는 하나의 선형 enum으로 합치지 않는다. 에픽 상태, 태스크 진행 상태, agent 실행 상태, 승인 상태, 외부 연동 상태를 분리해야 실제 작업 중 생기는 부분 실패를 표현할 수 있다.

### EpicStatus

```text
Drafting
AwaitingPlanApproval
Approved
Splitting
Active
Done
Archived
```

에픽 계획 승인 전에는 태스크 코딩을 시작할 수 없다.

### TaskStatus

기본 흐름:

```text
Planned
-> Ready
-> Coding
-> PlanVerification
-> CodeReview
-> Testing
-> MergeWaiting
-> Merged
-> Done
Blocked
```

`TaskStatus`는 코드와 DB에서는 위 enum ID를 그대로 사용하고, UI에서는 한국어 라벨로만 변환한다.

```text
Planned          계획됨
Ready            준비됨
Coding           코딩중
PlanVerification 계획 검토
CodeReview       코드 리뷰
Testing          테스트
MergeWaiting     머지 대기
Merged           머지됨
Done             완료
Blocked          막힘
```

실행 실패, 테스트 실패, 리뷰 실패, 권한 차단, merge conflict, 토큰 예산 초과는 Task를 `Blocked`로 전환한다. Blocked 상태에서는 Helm이 자동 진행하지 않는다. 사용자가 승인하거나 재시도해야 한다.

### AgentRunStatus

```text
Queued
-> Running
-> Succeeded | Failed | Canceled | TimedOut | NeedsInspection
```

AgentRun은 Task와 독립적으로 기록한다. Task가 `코드 리뷰` 상태여도 이전 Coder run이 `Succeeded`, Reviewer run이 `Failed`일 수 있다.

### ApprovalStatus

```text
Pending
Approved
Rejected
Expired
```

계획 승인, merge 승인, Jira 생성/수정 승인, Slack 답장 승인, 위험 명령 승인은 모두 Approval로 기록한다.

### ExternalSyncStatus

```text
NotLinked
Linked
SyncPending
Synced
Stale
SyncFailed
```

Jira와 Slack은 Task 상태를 대체하지 않는다. Jira/Slack 연결 상태는 별도 sync 상태로 표시한다.

## 실행 규칙

### 자동 다음 단계가 꺼져 있을 때

기본값은 수동 실행이다.

```text
구현자 실행 완료
-> 태스크 상태: 계획 검토 대기
-> 사용자가 [계획 검토 실행] 클릭
-> Helm이 계획 검토자 role 실행
```

### 자동 다음 단계가 켜져 있을 때

특정 프로젝트 또는 에픽에서만 선택적으로 켤 수 있다.

```text
구현자 실행 완료
-> Helm이 변경사항과 exit code 확인
-> Context Pack 생성
-> 계획 검토자 role 실행
```

자동 진행이 켜져 있어도 다음 상태는 항상 멈춘다.

- 에픽 계획 승인 전
- merge 전
- 권한 위험 작업 발생
- 충돌 발생
- 테스트/review 실패

### 계획 전 탐색과 근거 확인

Planner role은 바로 계획을 만들지 않고 두 가지 사전 모드를 선택할 수 있다.

```text
탐색 모드      Explore
근거확인 모드  Grounded
```

- 탐색 모드: 요구사항이 흐릿할 때 선택지, 제약, 기존 구현 방향을 비교한다. 결과는 에픽 계획의 research context로 남길 수 있다.
- 근거확인 모드: 버전, 현재 repo 상태, 법/정책/보안처럼 추측하면 안 되는 질문을 증거 기반으로 확인한다. 충분한 근거가 없으면 계획을 만들지 않고 사용자에게 부족한 정보를 알려준다.

이 개념은 AI Factory의 `/aif-explore`, `/aif-grounded` 흐름을 Helm의 Planner UX로 가져온 것이다.

## Role Adapter 계약

AI 작업자는 Helm을 직접 호출하지 않는다. Helm이 role adapter를 통해 command를 실행하고 산출물을 수집한다.

Helm은 각 role 실행 전에 wrapper 입력을 만든다.

```text
artifactDir: repo/.helm/artifacts/runs/<agent-run-id>/
contextPackPath: <artifactDir>/context-pack.md
contextManifestPath: <artifactDir>/context-pack.json
resultPath: <artifactDir>/structured-result.json
summaryPath: <artifactDir>/summary.md
schemaPath: <artifactDir>/structured-result.schema.json
timeout: role 설정값
```

role command는 항상 task worktree를 cwd로 실행한다. command template에는 다음 placeholder를 사용할 수 있다.

```text
{artifactDir}
{contextPackPath}
{contextManifestPath}
{resultPath}
{summaryPath}
{schemaPath}
{worktreePath}
{taskId}
{roleId}
```

Helm wrapper는 같은 값을 환경 변수로도 제공한다.

```text
HELM_ARTIFACT_DIR
HELM_CONTEXT_PACK
HELM_CONTEXT_MANIFEST
HELM_RESULT_PATH
HELM_SUMMARY_PATH
HELM_SCHEMA_PATH
HELM_WORKTREE_PATH
HELM_TASK_ID
HELM_ROLE_ID
```

모든 role 실행 입력:

- role id
- task id
- worktree path
- Context Pack path
- Context Pack manifest path
- system prompt
- user instruction
- allowed command policy

모든 role 실행 출력은 `artifactDir`에 남긴다.

- exit code
- stdout/stderr log
- changed files
- token estimate
- `summary.md`
- `structured-result.json`

`summary.md`와 `structured-result.json`은 필수 산출물이다. Helm wrapper는 실행 후 `resultPath`의 JSON schema를 검증한다.

Source of truth 규칙:

- exit code, stdout/stderr, 실제 changed files, diff, commit hash는 Helm이 직접 계산한 값을 기준으로 한다.
- `structured-result.json`의 `changedFiles`는 role의 의도 설명 또는 자체 보고로만 취급하고, 실제 변경 파일 판정에는 사용하지 않는다.
- gate 결과는 사람이 읽는 자유 문장이 아니라 schema validation을 통과한 `structured-result.json`만 파싱한다.
- schema validation에 실패한 run은 성공처럼 자동 진행하지 않고 `NeedsInspection`으로 멈춘다.

`structured-result.json`의 최소 필드:

```json
{
  "schemaVersion": 1,
  "status": "pass | fail | needs_changes",
  "summary": "human readable summary",
  "changedFiles": [],
  "risks": [],
  "nextActions": [],
  "gateResult": null
}
```

역할별 판정:

- Coder: exit code와 changed files를 기록한다. 변경 파일이 없으면 `needs_changes`로 처리할 수 있다.
- Plan Verifier: 승인된 계획과 diff를 비교해 `pass | needs_changes | fail`을 반환한다.
- Code Reviewer: 유지보수성, 위험, 스타일, 누락 테스트를 검토해 `pass | needs_changes | fail`을 반환한다.
- Tester: test command exit code와 실패 로그를 기반으로 `pass | fail`을 반환한다.

structured result가 없거나 schema validation에 실패하면 Helm은 stdout/stderr 요약만 저장하고 해당 run을 `AgentRunStatus=NeedsInspection`으로 기록한다.

### Execution Owner와 Observer 계약

Role Adapter는 "무엇을 실행할지"를 정하고, HelmHostRunner는 "로컬 host에서 어떻게 실행할지"를 담당한다. DockerHermesObserver는 실행 주체가 아니라 HelmHostRunner의 run lifecycle, artifact, policy signal을 관찰하는 보조 계층이다. Helm의 상태 전이, 승인, 다음 role 결정은 Runner나 Observer가 아니라 Helm backend가 소유한다.

Phase 3 실행/관찰 구성:

- `HelmHostRunner`: task worktree에서 인증된 Claude/Codex CLI를 controlled child process로 실행한다.
- `DockerHermesObserver`: Docker container에서 host run의 event, artifact, timeout, policy signal을 관찰한다.

HelmHostRunner 입력:

- `runId`
- `taskId`
- `roleId`
- `worktreePath`
- `artifactDir`
- `contextPackPath`
- `contextManifestPath`
- `resultPath`
- `summaryPath`
- `schemaPath`
- `timeoutSeconds`
- `allowedCommandPolicy`

HelmHostRunner 출력:

- `exitCode`
- `startedAt`
- `finishedAt`
- `stdoutLogPath`
- `stderrLogPath`
- `resultPath`
- `summaryPath`
- `observedChangedFiles`
- `policyViolations`

Run event stream:

```text
run.started
process.output
artifact.created
git.changed
policy.blocked
run.finished
```

DockerHermesObserver는 위 event stream과 artifact directory를 관찰하고, 누락 artifact, timeout 의심, policy violation 의심, Docker 관찰 실패 같은 보조 신호를 Helm backend에 보고한다. Hermes는 Helm의 상위 오케스트레이터가 아니며 TaskStatus 전이, approval 생성, 다음 role scheduling, audit source of truth, provider credential, Claude/Codex CLI 실행을 소유하지 않는다.

Provider credential 원칙:

- Claude/Codex 인증은 Helm backend와 로컬 host가 소유한다.
- DockerHermesObserver container에는 provider token, login session, Keychain secret을 전달하지 않는다.
- Hermes는 provider API를 직접 호출하지 않는다.
- 인증 실패는 Hermes 오류가 아니라 HelmHostRunner 또는 provider 설정 오류로 기록한다.

DockerHermesObserver 기본 관찰 스펙:

- `artifactDir`를 read-only 또는 append-only 관찰 대상으로 mount한다.
- task worktree는 가능하면 mount하지 않는다. 필요하면 read-only 관찰 대상으로만 mount한다.
- provider credential directory와 Keychain secret은 mount하지 않는다.
- observer failure는 agent run 실패로 즉시 간주하지 않고 `NeedsInspection` 또는 observer warning으로 기록한다.
- 권장 Docker Desktop 리소스는 CPU 2-4 cores, memory 2-4GB, disk image 64GB 이상이다.
- `maxParallelRuns`는 HelmHostRunner 설정이며 Hermes observer의 병렬 실행 권한이 아니다.
- 같은 worktree에 두 HelmHostRunner를 동시에 실행하지 않는다.

## 품질 게이트 결과 계약

Plan Verifier, Code Reviewer, Tester, Security Reviewer 같은 검증 역할은 사람이 읽는 Markdown 요약과 별도로 machine-readable gate result를 남긴다.

Helm은 agent 출력의 자유 문장을 scraping하지 않고, 마지막 `structured-result.json`만 파싱한다. gate role은 공통 result의 optional `gateResult` 객체에 아래 필드를 채운다.

```json
{
  "status": "needs_changes",
  "summary": "human readable summary",
  "changedFiles": [],
  "risks": [],
  "nextActions": [],
  "gateResult": {
    "gate": "plan_verification | code_review | test | security | rules",
    "status": "pass | warn | fail",
    "blocking": true,
    "blockers": [
      {
        "id": "review-1",
        "severity": "error | warning",
        "file": "src/example.ts",
        "summary": "Blocking issue summary"
      }
    ],
    "affectedFiles": [],
    "suggestedNext": {
      "action": "fix | retry | request_changes | approve | manual_review",
      "reason": "why"
    }
  }
}
```

규칙:

- `blocking=true`이면 Task는 자동 진행하지 않고 `Blocked` 또는 승인 대기로 전환한다.
- `status=warn`은 기본적으로 사람에게 노출하지만 자동 진행 차단 여부는 role policy가 결정한다.
- Security Reviewer의 critical/high finding은 `blocking=true`로 본다.
- gate role에서 `gateResult`가 없거나 schema가 틀리면 해당 `AgentRunStatus=NeedsInspection`으로 둔다.
- 이 계약은 AI Factory의 quality gate 결과 블록 개념을 Helm의 `structured-result.json`로 흡수한 것이다.

## Context Pack

Helm은 각 role 실행 전에 작업에 필요한 컨텍스트를 묶어 전달한다. AI가 repo 전체를 무작위로 훑는 구조를 피하고, 작업 품질과 토큰 사용량을 안정화하기 위해서다.

Context Pack은 항상 두 파일로 생성한다.

```text
context-pack.md    AI 작업자에게 전달하는 사람이 읽을 수 있는 본문
context-pack.json  재현과 검증을 위한 manifest
```

`context-pack.json`에는 최소한 다음 정보를 기록한다.

- `taskId`
- `roleId`
- `generatedAt`
- `tokenBudget`
- `sources`
- `includedFiles`
- `fileHashes`
- `baseBranch`
- `diffRef`
- `isStale`
- `staleReason`

포함된 파일, diff 기준, 승인된 계획이 바뀌면 기존 Context Pack은 stale로 본다. 자동 다음 단계 실행 전 Context Pack이 stale이면 Helm은 재생성하거나 사용자 확인을 요구한다.

포함 대상:

- 에픽 계획
- 태스크와 서브태스크 설명
- acceptance criteria
- 관련 Obsidian 문서
- README, docs, AGENTS.md
- 관련 소스 파일 목록
- 이전 agent run 요약
- 현재 diff
- 테스트 결과
- 리뷰 결과

역할별 Context Pack은 달라야 한다.

```text
설계자: 문서, 기존 프로젝트 구조, 사용자 의도 중심
구현자: 승인된 계획, 관련 파일, acceptance criteria 중심
계획 검토자: 승인 계획과 실제 diff 비교 중심
코드 리뷰어: diff, 스타일, 위험 지점, 유지보수성 중심
테스트 담당자: 변경 파일, test command, 실패 로그 중심
```

## 계획과 문서 흐름

계획 작업은 에픽 단위로 시작한다. Planner role은 사용자와 대화하면서 기존 프로젝트와 Obsidian 문서를 먼저 검토하고, 승인 가능한 에픽 설계 문서를 만든다.

계획 흐름:

```text
프로젝트 선택
-> Obsidian/README/docs/AGENTS/context scan
-> 필요 시 탐색 모드 또는 근거확인 모드
-> Planner와 에픽 설계
-> 필요 시 계획 개선 패스
-> 사용자 승인
-> 태스크/서브태스크 분해
-> Coder role에 전달
```

계획 문서에는 목표, 범위, acceptance criteria, 태스크 목록, 위험, 관련 문서/파일, Jira/Slack 연결 정보를 담는다. 승인된 계획은 Helm DB에 metadata를 저장하고, Markdown/Obsidian 문서에는 사람이 읽을 수 있는 원본 설계를 유지한다.

계획 문서는 실행 가능한 task list뿐 아니라 commit checkpoint도 가질 수 있다. 큰 에픽은 3-5개 태스크 단위로 checkpoint를 제안하고, merge 전에는 계획 준수 검토와 코드 리뷰를 통과해야 한다.

## Jira 연동

Helm은 Markdown/Helm 계획을 기준 소스로 유지하고, Jira는 실행 추적과 협업 티켓 시스템으로 연결한다. 기존 업무 흐름처럼 사용자가 MD 설계 문서를 만든 뒤 수동으로 Jira 티켓을 따는 과정을 Helm 안에서 초안 생성, 승인, 생성, 상태 동기화 흐름으로 줄인다.

Jira 연동 1차 범위(Phase 5):

```text
MD/Helm 계획
-> Jira 티켓 초안
-> 사용자 검토/수정
-> 사용자 승인 후 Jira 생성
-> 생성 key를 Helm DB와 MD 문서에 backfill
-> Jira status, assignee, updated time, URL 동기화
```

### 기준 소스

- Helm과 MD 문서가 에픽, 태스크, 서브태스크 구조의 원본이다.
- Jira는 실행 상태와 협업 추적을 위한 외부 시스템이다.
- 1차에서는 Jira에서 바뀐 티켓 구조를 Helm 태스크 구조로 역변환하지 않는다.
- Jira 상태, 담당자, 갱신 시각, URL은 Helm에 동기화하되, 설계 의도와 acceptance criteria는 Helm/MD를 기준으로 본다.

### 모델

Jira 연동에는 다음 모델을 둔다.

- `JiraConnection`: site URL, 인증 상태, 사용자 계정, 권한 확인 결과
- `JiraProjectMapping`: project key, issue type mapping, parent/epic field mapping, 기본 labels/components/assignee
- `JiraTicketDraft`: 생성 전 사용자가 검토하는 ticket 초안
- `JiraIssueLink`: Helm task/subtask와 Jira issue key/URL 연결
- `JiraSyncState`: 마지막 동기화 시각, Jira status, assignee, updated time, 동기화 오류

### 계층 매핑

Jira issue type과 parent hierarchy는 프로젝트마다 다르므로 설정 가능해야 한다. 기본 사용 사례는 기존 Jira Epic이 이미 만들어져 있고, Helm이 Task 또는 Story부터 생성하는 흐름이다.

지원해야 할 매핑:

- 기존 Epic 연결: `existingEpicKey`를 선택하면 새 Epic을 만들지 않고 Helm Task를 해당 Epic 아래 Jira Task/Story로 생성한다.
- Task 중심 생성: Helm Task를 Jira Task 또는 Story로 만든다.
- Subtask 생성: Jira parent key가 있는 경우에만 Helm Subtask를 Jira Sub-task로 만든다.
- 새 Epic 생성: 프로젝트 설정에서 허용한 경우에만 Helm Epic을 Jira Epic으로 만든다.

### UI 반영

태스크 상세에 `Jira` 탭을 추가한다.

표시/동작:

- `Jira 초안 만들기`
- `Jira에 생성`
- `Jira 동기화`
- `Jira에서 열기`
- Jira key
- Jira status
- Jira assignee
- 마지막 동기화 시각
- 동기화 오류

태스크 카드에는 Jira key, Jira status, 동기화 상태를 작게 표시한다. Jira 생성은 사용자 승인 액션으로만 수행한다.

### MD backfill

Jira 생성 후 Helm은 생성된 key와 URL을 MD 문서에 기록한다. 기존 문서 형식을 깨지 않도록 frontmatter의 `helm` namespace 또는 Helm managed block만 갱신한다. 사용자가 작성한 자유 문단과 표는 자동 수정하지 않는다.

기록 대상:

- `jiraKey`
- `jiraUrl`
- `jiraStatus`
- `lastSyncedAt`

### 권한과 보안

- Jira URL, project key, issue type mapping은 설정에 저장한다.
- Jira API token은 평문 DB에 저장하지 않고 macOS Keychain에 저장한다. DB에는 token 값이 아니라 keychain reference만 저장한다.
- Jira 생성/수정은 사용자 승인 액션으로만 실행한다.
- 필수 field 누락, 인증 실패, 권한 부족, custom field mismatch는 사용자가 수정 가능한 오류로 보여준다.
- Jira status 동기화는 수동 버튼으로만 실행한다.
- 앱 시작 시 자동 refresh와 주기 polling은 1차 범위에서 제외한다.

### API 기준

기본 대상은 Jira Cloud REST API v3다. issue 생성, bulk create, create metadata, issue link, remote issue link, transition/status 조회를 사용한다. Data Center나 회사별 custom field 차이는 mapping layer로 분리한다.

Jira 구현 규칙:

- 티켓 생성 전 create metadata를 조회해 issue type별 required field와 custom field를 검증한다.
- Markdown description은 Jira Cloud의 Atlassian Document Format(ADF)으로 변환한다.
- ADF 변환에 실패하면 Jira 생성 전 사용자 수정 가능한 오류로 보여준다.
- Sub-task 생성은 Jira parent key와 subtask issue type이 모두 확인된 경우에만 허용한다.
- bulk create는 일부 성공/일부 실패를 고려해 성공 issue key는 저장하고 실패 draft는 재시도 가능하게 남긴다.
- Jira transition 변경은 1차 범위에서 자동 수행하지 않는다. status 동기화만 기본으로 한다.

참고 공식 문서:

- Jira Cloud REST API v3 Issues: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/
- Jira Cloud REST API v3 Issue links: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-links/
- Jira Cloud REST API v3 Issue remote links: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-remote-links/

## Slack 연동

Slack은 실행 주체가 아니라 업무 신호 수집과 결과 회신 채널이다. Slack에서 들어온 메시지는 바로 agent 실행으로 가지 않고 Helm Inbox를 거친다.

Slack 연동 1차 범위(Phase 6):

```text
Slack message shortcut 또는 Helm bot mention
-> Helm Inbox 수집
-> Slack Inbox Epic 아래 Task draft 생성
-> 사용자 확인/지시 추가
-> Helm 오케스트레이터가 role chain 실행
-> Slack reply draft 생성
-> 사용자 승인 후 원본 Slack thread에 답장
```

### 모델

Slack 연동에는 다음 모델을 둔다.

- `SlackConnection`: workspace, bot user, token 상태, Socket Mode 연결 상태
- `SlackInboxItem`: Slack에서 들어온 원본 알림, 멘션, shortcut 항목
- `SlackSourceRef`: channel, thread timestamp, message timestamp, user, permalink
- `SlackTaskLink`: Helm task와 Slack 원본 thread 연결
- `SlackReplyDraft`: 작업 결과를 Slack에 답장하기 전 사용자 검토용 초안

### 수집 정책

- 기본 입력은 message shortcut과 Helm bot mention이다.
- 선택 채널 상시 감시, DM 전체 수집, 키워드 기반 넓은 수집은 1차 범위에서 제외한다.
- Slack에서 온 항목은 기본적으로 `Slack Inbox Epic` 아래에 모으고, 사용자가 나중에 기존 에픽으로 이동할 수 있다.
- 앱이 참여하지 않은 채널 또는 권한이 없는 private channel의 메시지는 수집하지 않는다.
- 데스크톱 앱이 실행 중일 때만 Socket Mode 이벤트를 수신한다. 백그라운드 helper는 1차 범위에서 제외한다.
- 앱이 꺼져 있을 때 들어온 shortcut/mention 처리는 Helm이 보장하지 않는다.

### UI 반영

태스크 화면에 `Slack Inbox` 필터 또는 섹션을 추가한다. 태스크 상세에는 `Slack` 탭을 추가한다.

표시/동작:

- `태스크로 만들기`
- `에픽으로 이동`
- `답장 초안 만들기`
- `Slack에 답장`
- `Slack에서 열기`
- 원본 channel/thread/user/permalink
- reply draft 상태
- Slack API 오류와 권한 오류

Slack 답장은 항상 사용자 승인 후 게시한다. 완료, 실패, 승인 대기 요약을 원본 thread에 답장할 수 있지만 자동 답장은 기본값이 아니다.

Slack message shortcut에는 threaded message에서 시작된 shortcut이 원본 thread로 직접 publish되지 못하는 플랫폼 제한이 있다. Helm은 `SlackSourceRef`에 입력 종류와 thread 여부를 저장하고, thread shortcut의 답장 대상은 다음 우선순위를 따른다.

```text
1. 원본 thread 답장 가능하면 thread에 게시
2. 불가능하면 부모 conversation에 답장 초안 게시 대상으로 표시
3. 사용자가 원하면 수동 복사용 답장문만 제공
```

### 권한과 보안

- Slack bot token과 app token은 평문 DB에 저장하지 않고 macOS Keychain에 저장한다. DB에는 token 값이 아니라 keychain reference만 저장한다.
- 로컬 데스크톱 앱은 외부 공개 Request URL 없이 동작하도록 Socket Mode를 기본 수신 방식으로 사용한다.
- Slack API rate limit, token 만료, Socket Mode 재연결 실패는 복구 가능한 오류로 UI에 표시한다.

참고 공식 문서:

- Slack Socket Mode: https://api.slack.com/apis/connections/socket
- Slack app_mention event: https://api.slack.com/events/app_mention
- Slack Shortcuts: https://api.slack.com/interactivity/shortcuts/using
- Slack chat.postMessage: https://docs.slack.dev/reference/methods/chat.postMessage

## Worktree와 Merge

각 태스크는 별도 git worktree와 branch에서 수행한다.

```text
project root
task branch
task worktree
agent runs
artifacts
merge approval
git merge
```

기본 머지 방식은 Git Merge다. merge conflict가 발생하면 태스크는 Blocked로 전환되고, Guided Resolver 화면에서 처리한다.

기본 정책:

- worktree root 기본값: `<project-parent>/.helm-worktrees/<project-slug>/`
- task branch 기본값: `helm/task/<task-id>-<slug>`
- merge target 기본값: 프로젝트를 열 때 선택한 base branch
- main worktree가 dirty이면 merge를 시작하지 않고 사용자에게 정리/보류를 요구한다.
- task branch merge 전 local base branch 기준으로 dirty 여부와 divergence를 확인한다.
- 자동 fetch는 1차 범위에서 제외한다.
- remote 최신화가 필요하면 사용자가 터미널에서 직접 수행한다.
- 기본 merge 방식은 merge commit이다. squash/rebase는 1차 범위에서 제외한다.
- merge conflict 해결 후에는 Plan Verifier, Code Reviewer, Tester를 다시 실행해야 merge approval을 받을 수 있다.

Guided Resolver는 다음 정보를 보여준다.

- 충돌 파일 목록
- base/current/incoming diff
- 태스크 의도
- AI 해결 제안
- 사용자 승인/반려

## 권한 모델

Helm은 Scoped Allowlist를 사용한다.

허용 범위는 실행 컨텍스트별로 다르다.

- agent runner: 해당 task worktree만 writable, project root는 read-only
- backend command: 승인된 작업에 한해 project root, `.helm/`, 설정된 Obsidian 출력 경로 writable
- 사용자 터미널: 사용자가 직접 조작하는 shell이므로 agent allowlist 제한 대상에서 제외

위험 작업:

- `rm`
- `git reset`
- force push
- credential 접근
- 외부 네트워크 명령
- allowlist 밖 파일 쓰기

위험 작업은 자동 실행하지 않고 승인 대기 상태로 전환한다.

권한 모델은 구현 난이도와 실제 강제력을 분리해서 다룬다.

```text
정책 차단     command template과 Helm command layer에서 실행 전 거부
실행 경계     cwd, worktree, Tauri capability, connector scope로 실행 표면 축소
사후 검증     실행 후 Git diff, artifact, audit log로 위반 여부 기록
운영 승인     사용자가 위험 작업을 명시적으로 승인해야 진행
```

임의 CLI agent를 일반 child process로 실행하는 것만으로는 OS 수준 파일 쓰기와 네트워크 접근을 완전히 강제할 수 없다. 따라서 "agent runner는 task worktree만 writable"은 최종 목표로 두되, 초기 구현에서는 worktree 격리, command allowlist, 실행 전 정책 차단, 실행 후 diff 검증을 먼저 닫는다. OS sandbox나 더 강한 process isolation은 별도 보안 hardening 단계에서 검증한다.

DockerHermesObserver는 Phase 3b의 observability/audit hardening 수단이다. 현재 성공 경로에서는 Docker container가 agent 실행 보안 경계가 아니다. 최종 판정은 Helm backend가 실제 Git diff, artifact, exit code, structured result를 다시 계산해 내린다.

네트워크 권한은 두 종류로 나눈다.

- 허용된 connector 네트워크: Jira, Slack, AI provider/CLI 등 사용자가 설정한 connector가 필요한 네트워크
- 임의 shell 네트워크: `curl`, `wget`, 임의 API 호출, package install 등 agent가 shell에서 직접 수행하는 네트워크

허용된 connector 네트워크는 설정된 connector 권한으로 관리하고, 임의 shell 네트워크는 위험 작업으로 승인 대기 처리한다.

Tauri 보안 원칙:

- frontend에 generic shell execute 권한을 열지 않는다.
- Tauri capabilities에는 좁은 Rust command만 노출한다.
- 예: `agent.run`, `git.status`, `git.getRepositoryState`, `git.getBranchGraph`, `git.getCommitDetail`, `git.getTaskGitState`, `git.getFileDiff`, `git.worktreeCreate`, `git.mergeApproved`, `terminal.spawn`, `jira.createTickets`, `slack.postApprovedReply`
- allowlist 검증은 frontend가 아니라 backend command layer에서 수행한다.
- agent command는 사용자 터미널과 분리된 controlled runner에서만 실행한다.

## 온보딩과 설정

첫 실행 경험은 별도 온보딩 흐름으로 둔다.

필수 단계:

- 프로젝트 열기
- git repo 감지
- Obsidian vault 연결
- worktree root 설정
- 역할별 AI preset 설정
- 테스트 명령 자동 감지 또는 수동 입력
- Jira/Slack 연결은 선택 설정으로 제공
- 권한 allowlist 초기값 확인

설정 화면에는 역할별 AI, 권한 allowlist, Obsidian, Jira, Slack, worktree, token budget, backup/export 설정을 둔다.

설정 저장 우선순위는 다음과 같이 고정한다.

```text
project override > global default > built-in default
```

- 전역 기본값은 Tauri app data directory에 저장한다.
- 프로젝트별 override는 `repo/.helm/helm.sqlite`에 저장한다.
- 역할별 AI, Jira/Slack mapping, worktree root, token budget, artifact retention은 프로젝트별 override가 가능하다.
- UI preference와 최근 프로젝트 목록은 전역 설정에 둔다.
- secret 값은 어느 설정 저장소에도 평문으로 저장하지 않고 macOS Keychain에만 저장한다.

## 데이터 보존과 복구

Helm은 로컬 앱이므로 데이터 보존과 복구가 중요하다.

- SQLite에는 프로젝트, 에픽, 태스크, 상태, 링크, 설정 metadata를 저장한다.
- 프로젝트 DB 위치는 `repo/.helm/helm.sqlite`로 고정한다.
- repo-local `.helm/`에는 해당 프로젝트와 함께 이동되어야 하는 metadata와 artifact를 저장한다.
- 앱 data directory에는 전역 설정, 최근 프로젝트 목록, macOS Keychain reference, UI preference를 저장한다.
- 큰 로그, diff, review, test output, Context Pack snapshot은 repo-local `.helm/artifacts`에 저장한다.
- Jira/Slack/API token 값은 SQLite나 artifact에 저장하지 않는다. macOS Keychain에 저장하고 DB에는 reference만 둔다.
- 주기적 local backup/export 기능을 둔다.
- 오래된 terminal scrollback, agent logs, artifact는 보존 기간을 설정할 수 있어야 한다.
- 앱 재시작 후 running으로 남은 agent/terminal/worktree 상태를 복구하거나 orphan 상태로 표시한다.
- agent run은 취소, 재시도, 보류가 가능해야 한다.

## MD backfill 정책

Helm이 사용자 Markdown 문서를 수정할 때는 문서 손상을 피하기 위해 관리 영역을 제한한다.

기본 정책:

- frontmatter는 `helm` namespace 아래 key만 수정한다.
- 본문은 Helm managed block만 수정한다.
- 사용자가 작성한 자유 문단과 표는 자동 수정하지 않는다.

관리 블록 형식:

```md
<!-- HELM:BEGIN task-id -->
...
<!-- HELM:END task-id -->
```

Jira/Slack key, URL, sync status, last synced time은 frontmatter `helm` namespace 또는 managed block에만 기록한다.

frontmatter 예시:

```yaml
helm:
  taskId: T-24
  lastSyncedAt: "2026-05-16T12:00:00+09:00"
  jira:
    key: PROJ-123
    url: https://example.atlassian.net/browse/PROJ-123
    status: In Progress
  slack:
    channelId: C123
    threadTs: "1715840000.000000"
    permalink: https://example.slack.com/archives/C123/p1715840000000000
```

### Artifact metadata

Helm이 관리하는 Markdown/Obsidian artifact에는 가능한 한 작은 frontmatter metadata를 둔다.

```yaml
helm:
  id: plan-auth-login
  type: plan
  status: accepted
  owners:
    - planner
  dependsOn:
    - spec-auth-login
  affects:
    - tests-auth-login
  implements:
    - spec-auth-login
  verifies: []
  supersedes: []
```

목적:

- 계획, ADR, QA, 테스트, 리뷰 문서의 관계를 추적한다.
- 어떤 문서를 바꾸면 어떤 downstream artifact를 재검토해야 하는지 UI에 보여준다.
- Jira/Slack backfill과 충돌하지 않도록 `helm` namespace만 사용한다.

기본 관계:

- `dependsOn`: 이 artifact가 의존하는 상위 결정/요구사항
- `affects`: 변경 시 검토해야 하는 하위 artifact
- `implements`: 구현이 만족하는 spec/plan
- `verifies`: 테스트/QA가 검증하는 spec/plan
- `supersedes`: 대체한 이전 artifact

이 구조는 AI Factory의 artifact metadata/audit 개념을 Helm의 MD backfill 정책에 맞게 줄인 것이다.

## Markdown과 artifact 확인 단계

Helm은 작업 중 생성되는 Markdown을 처음부터 넓게 스캔하지 않는다. 먼저 Helm이 직접 만든 run artifact를 안전하게 확인하는 기능부터 닫고, 이후 사용자가 관리하는 계획/Obsidian 문서로 확장한다.

단계별 실행 계획:

```text
Phase 2: run artifact viewer
Phase 3a: 실제 Claude/Codex run의 summary.md/result/log 확인
Phase 4: task 상세 문서 탭
Phase 5+: MD backfill과 Obsidian 문서 연결
```

### Phase 2. Run artifact viewer

대상:

- `.helm/artifacts/runs/<agent-run-id>/summary.md`
- `.helm/artifacts/runs/<agent-run-id>/structured-result.json`
- `.helm/artifacts/runs/<agent-run-id>/stdout.log`
- `.helm/artifacts/runs/<agent-run-id>/stderr.log`

규칙:

- `agent_runs.artifact_dir` 아래의 allowlisted 파일만 읽는다.
- 임의 Markdown 경로, 절대 경로, `..` path traversal, symlink target은 읽지 않는다.
- UI는 task 상세의 run history에서 artifact를 인라인으로 보여준다.
- Phase 2에서는 repo 전체 Markdown 검색, Obsidian scan, MD backfill을 하지 않는다.

### Phase 3a. 실제 run artifact 확인

HelmHostRunner가 실제 Claude/Codex를 실행해도 artifact viewer 계약은 Phase 2와 같다. 실제 agent가 `summary.md`를 만들지 못하면 Helm wrapper가 fallback summary를 만들고 run은 `NeedsInspection`으로 멈춘다.

### Phase 4. Task 문서 탭

task 상세에 문서 탭을 추가한다.

표시 대상:

- 승인된 계획 문서
- run summary
- review/test 결과 Markdown
- 관련 artifact metadata

이 단계에서도 사용자가 작성한 Markdown 원본을 자동 수정하지 않는다.

### Phase 5 이후. MD backfill과 Obsidian 연결

Jira/Slack key, sync status, artifact relation처럼 Helm이 관리하는 metadata만 frontmatter `helm` namespace 또는 Helm managed block에 기록한다. Obsidian scan/backfill은 사용자가 연결한 vault 경로와 승인된 문서에만 수행한다.

## 프로젝트 학습 루프

Helm은 실패와 수정에서 반복 가능한 교훈을 축적할 수 있어야 한다.

1차에서는 자동 skill rewriting을 하지 않는다. 대신 다음 artifact를 남긴다.

- 실패한 agent run 요약
- root cause
- 적용한 수정
- 재발 방지 규칙 후보
- 관련 파일과 태그

후속 단계에서는 사용자가 승인한 규칙만 role system prompt, Context Pack, Obsidian project memory에 반영한다. AI Factory의 fix patch/evolve 흐름을 참고하되, Helm은 자동 반영보다 사용자 승인과 감사 로그를 우선한다.

## UI 반영

UI는 한국어 라이트 테마 고정이다. 메뉴는 세 개로 단순화한다.

```text
태스크
깃
터미널
```

Phase 1 UI는 장기 UI의 축소판이 아니다. 실제로 동작하는 프로젝트 열기, 태스크/에픽 skeleton, 설정 skeleton, read-only Git snapshot만 노출한다. 승인 대기, 실행 중 AI, token 소진률, task worktree, Jira/Slack, merge, review/test 상세는 해당 backend model이 들어오기 전까지 기본 화면에서 숨긴다.

### 태스크 화면

기본 화면이다. 아래 항목은 Phase 4 이후 완성 목표이며, Phase 1 노출 범위는 `docs/phase-0-1-implementation-plan.md`를 따른다.

- 에픽/태스크 보드
- 승인 대기
- 진행률
- 각 AI 작업자 상태
- 선택 태스크 상세
- 계획, 실행 기록, 변경사항, 리뷰, 테스트, Jira, Slack, 머지 정보
- task branch, worktree path, 관련 commits, 변경 파일 수, `깃에서 보기` 액션

보드 컬럼:

```text
계획됨
준비됨
코딩중
계획 검토
코드 리뷰
테스트
머지 대기
머지됨
완료
막힘
```

상단 상태바에는 장기적으로 프로젝트명, branch, 전체 진행률, 승인 대기 수, 실행 중 AI 작업자, 추정 token 소진률, 터미널 실행 수를 표시한다. Phase 1에서는 `docs/phase-0-1-implementation-plan.md`를 우선해 프로젝트명, branch, head, dirty count, 태스크 수, 완료 수만 표시하고 아직 backend model이 없는 값은 숨긴다.

### 깃 화면

깃은 프로젝트 전체 Git 상태를 보는 독립 화면이다. 태스크 화면에 Git 전체 패널을 넣지 않고, 태스크 상세에서는 해당 태스크와 연결된 요약만 보여준 뒤 `깃에서 보기`로 이동한다. Phase 1에서는 read-only local viewer만 구현하고, branch graph와 task worktree 연결은 Phase 4로 미룬다.

표시 대상:

- 현재 branch와 HEAD
- dirty/staged/unstaged/untracked 파일 수
- local base branch 대비 ahead/behind/diverged 상태
- 브랜치 트리와 커밋 그래프
- 최근 커밋 목록: hash, author, date, subject, refs
- `git config user.name`, `git config user.email` 기준 `내 커밋` badge
- 변경 파일 목록과 diff summary
- task branch, task worktree, task commits 연결

Phase 1의 Git 화면은 read-only local viewer다. checkout, commit, merge, push, fetch는 노출하지 않는다. remote 최신화가 필요하면 사용자가 터미널에서 직접 수행한다.

Git 상태 파싱은 사람이 읽는 `git status` 출력이 아니라 machine-readable 형식을 사용한다. 공백/한글/rename path, detached HEAD, empty repo, upstream 없음, git user 미설정은 모두 표시 가능한 정상 edge case로 처리한다.

### 터미널 화면

터미널은 별도 메뉴에서 관리한다. Phase 1에서는 메뉴 skeleton만 두고 PTY와 split pane은 구현하지 않는다.

- 여러 터미널 세션 생성
- 프로젝트 root 또는 task worktree cwd 선택
- 탭 지원
- 좌우 분할
- 상하 분할
- pane 크기 조절
- pane focus 이동
- 태스크 화면에서 `작업 터미널 열기`로 연결

터미널 canvas는 가독성을 위해 어두운 팔레트를 사용할 수 있지만, 앱 전체 테마는 라이트로 고정한다.

### 디자인 원칙

- 앱 전체는 라이트 테마만 제공한다.
- 다크 모드 토글은 1차 범위에서 제외한다.
- 정보 밀도는 높게 유지하되 카드 남발을 피하고, 보드, 테이블, split pane, 상태 pill, diff viewer, terminal pane 중심으로 구성한다.
- 큰 hero, 마케팅식 랜딩 페이지, 보라/파랑 그라데이션 중심 디자인은 피한다.
- UI 문구는 한국어를 기본으로 하되, branch, task id, agent role id, 파일 경로, 로그, diff는 원문을 유지한다.
- 참고 디자인 방향: interface-design의 dashboard/tool craft, frontend-design의 비제너릭 미감 원칙을 Helm 전용 시각 언어로 번역한다.

### 키보드와 상태 UX

- Command palette를 제공한다.
- 빠른 task 검색, approval inbox 이동, terminal focus 전환, run/retry/cancel 단축키를 둔다.
- 계획 승인 대기, merge 승인 대기, 테스트 실패, 충돌 발생, token 예산 초과, agent 완료는 알림과 inbox로 노출한다.
- 프로젝트 없음, 에픽 없음, task 없음, agent 설정 없음, Obsidian/Jira/Slack 연결 실패, worktree 생성 실패, git 충돌 같은 빈 상태와 오류 상태를 별도 화면으로 설계한다.

## 감사 로그

Helm은 모든 중요한 전환을 기록한다.

- 어떤 역할이 실행되었는지
- 어떤 provider/model/command가 사용되었는지
- 어떤 Context Pack을 사용했는지
- 어떤 파일이 변경되었는지
- 어떤 check/review/test 결과가 있었는지
- 누가 어떤 승인을 했는지
- 어떤 branch/worktree가 merge되었는지
- 어떤 Jira 초안/issue 생성/backfill/sync가 실행되었는지
- Jira 동기화 실패와 충돌이 있었는지
- 어떤 Slack inbox item/task 승격/reply draft/post가 실행되었는지
- Slack API 실패와 권한 실패가 있었는지

이 로그는 나중에 "왜 이 변경이 들어갔는가"를 추적하기 위한 제품의 핵심 데이터다.

## 검증 계획

구현 시 다음 검증을 포함한다.

- 상태 머신: 계획 승인 전 코딩 불가, 실패 시 Blocked, merge 전 승인 필수, enum ID와 UI 라벨 분리 확인
- 역할 실행: 역할별 command template, placeholder, env var, cwd, Context Pack이 올바르게 구성되는지 확인
- Context Pack: `context-pack.md`와 `context-pack.json` 생성, file hash, stale 판정, 재생성 흐름 확인
- 설정: project override, global default, built-in default 우선순위 확인
- worktree: 태스크별 branch/worktree 생성, status, merge, conflict 처리
- Git 화면: read-only branch tree, commit graph, dirty/staged/unstaged/untracked, 내 커밋 badge, detached HEAD/upstream 없음/untracked 상태 확인
- 품질 게이트: gate result schema, blocking/warn/pass 처리, suggested next action 표시
- Artifact metadata: duplicate id, unknown relation, dependsOn cycle, downstream affects 표시 확인
- Jira: 초안 생성, 기존 Epic 연결, issue 생성, key backfill, 수동 status sync
- Slack: shortcut/mention 수집, Inbox 승격, reply draft, 승인 후 thread 답장
- 터미널: 탭, 좌우/상하 분할, pane resize/focus, cwd 선택
- 보안: macOS Keychain reference 저장, token 평문 DB 저장 금지, allowlist 밖 명령/파일 쓰기 차단, agent/user terminal 권한 분리
- 복구: 앱 재시작 후 orphan run/terminal/worktree 표시
- UI: 한국어 라이트 테마, task 중심 메뉴, empty/error states, overflow 없는 반응형 화면

## 구현 순서

Phase 0과 Phase 1의 세부 구현 계획은 [phase-0-1-implementation-plan.md](phase-0-1-implementation-plan.md)를 기준으로 한다. Phase 2의 세부 구현 계획은 [phase-2-implementation-plan.md](phase-2-implementation-plan.md)를 기준으로 한다.

### Phase 0. 문서와 기존 상태 정리

- 이전 UI 임시 변경분 원복 또는 폐기
- 기존 CLI MVP에서 재사용할 개념과 버릴 구현 분리
- repo-local `.helm/` 저장 정책 확정
- 완료 기준: 새 데스크톱 앱 기준 설계 문서가 최신이고, 기존 CLI/UI 임시 변경분 처리 방침이 결정되어 있다.

### Phase 1. Desktop shell과 기본 DB

- Tauri v2 앱 생성
- React/Vite/TypeScript UI shell
- SQLite schema와 migration
- 프로젝트 열기, 온보딩, 설정 skeleton
- 한국어 라이트 태스크 보드 skeleton
- read-only 깃 화면 skeleton
- 완료 기준: 앱이 프로젝트를 열고 `repo/.helm/helm.sqlite`를 생성/열며, 태스크 보드 skeleton, read-only 깃 화면 skeleton, 설정 저장/로드가 동작한다. Agent 실행은 포함하지 않는다.

### Phase 2. Task/Approval/AgentRun 상태 머신

- Epic/Task/Subtask 모델
- Approval queue
- Role preset 설정
- Role adapter 계약과 stub adapter
- 감사 로그
- 완료 기준: 상태 전이, 승인 대기, 감사 로그, stub adapter run 기록이 DB와 UI에 일관되게 반영된다.

### Phase 3a. Worktree와 Helm host runner

- git worktree/branch 생성
- HelmHostRunner 기반 Claude/Codex 단일 실행
- Context Pack 생성
- log/diff/artifact 저장
- cancel/retry/timeout 처리
- 완료 기준: task worktree에서 agent 1개가 실행되고, Context Pack, stdout/stderr, summary, structured result, diff artifact가 저장된다. 같은 worktree 동시 실행은 금지한다.

### Phase 3b. Docker Hermes observer 검증

- DockerHermesObserver adapter 추가
- Docker daemon 상태와 observer resource limit 점검
- artifact directory read-only 관찰 검증
- HelmHostRunner가 실행한 Codex 또는 Claude 단일 role을 observer가 추적
- observer warning과 policy signal을 `AgentRunStatus=NeedsInspection` 또는 audit warning으로 매핑
- 완료 기준: Claude/Codex 실행과 인증은 HelmHostRunner가 소유하고, Hermes는 Docker에서 실행 관찰/감사 보조 신호만 제공한다.

### Phase 3c. Gate chain과 merge 대기

- Plan Verifier, Code Reviewer, Tester chain
- gate result schema 처리
- merge approval 대기 상태 연결
- 완료 기준: verifier/reviewer/tester 결과가 상태 머신을 전환하고, merge 전 사용자 승인 없이는 진행하지 않는다.

### Phase 4. UI 완성

- 한국어 라이트 태스크 화면
- 깃 화면: 브랜치 트리, 커밋 그래프, 변경 파일, diff summary
- 상세 탭: 계획, 실행 기록, 변경사항, 리뷰, 테스트, Jira, Slack, 머지
- 터미널 화면: 탭, 좌우/상하 분할, pane resize/focus
- empty/error states와 command palette
- 완료 기준: 사용자가 태스크 중심으로 승인, 실행, 결과 검토, 터미널 이동을 처리할 수 있고 주요 empty/error state가 깨지지 않는다.

### Phase 5. Jira 연동

- Jira 설정과 secure token 저장
- create metadata 조회
- ticket draft 생성
- 사용자 승인 후 issue 생성
- key backfill과 status sync
- 완료 기준: 승인된 Helm/MD 계획에서 Jira draft를 만들고, 사용자 승인 후 issue를 생성하며, key backfill과 수동 status sync가 동작한다.

### Phase 6. Slack 연동

- Slack 설정과 Socket Mode 연결
- shortcut/mention Inbox 수집
- Task 승격
- reply draft 생성
- 사용자 승인 후 thread 또는 fallback target에 답장
- 완료 기준: 앱 실행 중 shortcut/mention이 Inbox로 들어오고, 사용자가 task로 승격한 뒤 reply draft를 승인해야 Slack에 게시된다.

### Phase 7. 백업과 복구

- local backup/export
- orphan run/terminal/worktree recovery
- artifact retention 설정
- 완료 기준: 앱 재시작 후 orphan run/terminal/worktree를 식별하고, backup/export와 artifact retention 설정이 동작한다.

## 원칙

- 오케스트레이터는 AI가 아니라 상태 머신이다.
- AI는 자기 다음 작업자를 직접 호출하지 않는다.
- 모든 실행은 Helm을 거친다.
- 계획 승인 전에는 코딩하지 않는다.
- merge 전에는 반드시 사용자 승인을 받는다.
- Jira 생성/수정 전에는 반드시 사용자 승인을 받는다.
- Slack 답장 게시 전에는 반드시 사용자 승인을 받는다.
- Helm과 MD 문서를 계획/태스크 구조의 기준 소스로 유지한다.
- 실패와 충돌은 자동으로 숨기지 않고 Blocked로 노출한다.
- 토큰과 권한은 중앙에서 추적한다.
