# Helm

Helm은 로컬 CLI agent hub MVP에서 **AI 개발 작업을 운영하는 데스크톱 control plane**으로 재설계 중인 프로젝트다.

목표는 또 하나의 채팅창을 만드는 것이 아니다. Helm은 로컬 프로젝트 안에서 에픽, 태스크, 역할별 AI 작업자, 승인, Git 상태, 산출물, 감사 로그를 관리하는 결정론적 오케스트레이터가 되어야 한다.

```text
AI 작업자 -> Helm에 결과 보고
Helm -> 다음 허용 상태 전이 결정
Helm -> 승인된 다음 role 실행
```

AI 작업자는 다른 AI 작업자를 직접 호출하지 않는다. 상태 머신과 실행 순서는 Helm이 소유한다.

## 현재 상태

이 저장소에는 현재 두 층이 함께 있다.

- `src/`: legacy Node CLI MVP reference
- `docs/`: 새 데스크톱 오케스트레이터 설계와 Phase 0-1 구현 계획

다음 제품 구현은 `apps/desktop/` 아래에 새 Tauri 데스크톱 앱으로 만든다. Phase 1에서는 기존 Node CLI를 감싸거나 runtime dependency로 import하지 않는다.

## 제품 방향

Helm의 목표 UX는 한국어 우선 로컬 데스크톱 앱이다. 최상위 화면은 세 가지로 둔다.

- `태스크`: 에픽, 태스크, 승인, role 실행, 리뷰/테스트/머지 상태
- `깃`: 처음에는 read-only local Git 상태, 이후 branch/commit graph
- `터미널`: 이후 프로젝트 root와 task worktree 터미널

핵심 원칙:

- 오케스트레이터는 AI가 아니라 결정론적 프로그램이다.
- 계획 승인과 merge 승인은 사용자가 명시적으로 한다.
- AI 출력은 산출물이고, 실제 Git diff/status는 Helm backend가 직접 계산한 값을 기준으로 삼는다.
- frontend에는 generic shell execute 권한을 열지 않는다.
- 기존 CLI 코드는 참고 자료이며 새 제품 기반 코드가 아니다.

## 문서 입구

먼저 읽을 문서:

- [Orchestrator Design](docs/orchestrator-design.md): 장기 제품 아키텍처
- [Phase 0-1 Implementation Plan](docs/phase-0-1-implementation-plan.md): 즉시 구현 범위의 source of truth
- [Phase 1-2 User Flow](docs/phase-1-2-user-flow.md): Jira 작업과 Jira 없는 작업을 모두 포함한 초기 사용자 흐름
- [Phase 2 Implementation Plan](docs/phase-2-implementation-plan.md): stub role run, approval, audit vertical slice
- [Phase 3a Implementation Plan](docs/phase-3a-implementation-plan.md): task worktree, context pack, HelmHostRunner single run
- [Hermes Local API Guide](docs/hermes-local-api-guide.md): 로컬 Docker Hermes를 Helm backend에서 호출하는 방식과 운영 원칙
- [Planner Conversation Approval Feature](docs/ai-plan-conversation-approval-feature.md): planner와 계획 문서를 고정하고 승인 후 Task로 변환하는 기능 계약
- [Reference Adoption Application Plan](docs/reference-adoption-application-plan.md): 외부 레퍼런스 차용 포인트별 Helm 적용 계획
- [Reference-Driven Work Plan](docs/reference-driven-work-plan.md): 레퍼런스 기반 blocker 해소와 제품화 작업 전체 계획
- [UX / Operation Blocker Remediation Plan](docs/ux-operation-blocker-remediation-plan.md): 관찰/승인/실행 준비/host 실행 경계와 blocker 해소 순서
- [Next Steps](docs/next-steps.md): legacy CLI MVP 완료 기록

Phase 1 구현자는 `Phase 0-1 Implementation Plan`의 command/DTO, migration runner, Git parser, verification contract를 먼저 따른다. 장기 설계와 충돌하면 Phase 0-1 문서가 우선한다.

Phase 2 구현자는 `Phase 2 Implementation Plan`의 `AgentRun`, `Approval`, stub adapter, audit event 계약을 먼저 따른다. Phase 2에서는 실제 Claude/Codex 실행이나 Docker Hermes observer를 구현하지 않는다.

Phase 1은 의도적으로 작게 닫는다.

- `apps/desktop` 생성
- Git 프로젝트 열기
- `repo/.helm/helm.sqlite` 생성/열기
- 프로젝트 설정 skeleton 저장/로드
- 한국어 라이트 태스크 보드 skeleton 표시
- read-only local Git snapshot 표시

Phase 1에서는 agent 실행, terminal PTY, worktree, Jira/Slack, Obsidian backfill, Keychain, merge, quality gate를 구현하지 않는다.

## 성공 경로

Helm은 범위를 한 번에 넓히면 실패하기 쉬운 제품이다. 성공 기준은 "많은 연동을 빨리 붙이는 것"이 아니라, 로컬 프로젝트에서 태스크 하나가 계획, 실행, 검토, 승인, 기록까지 추적되는 core loop를 먼저 닫는 것이다.

권장 구현 순서:

```text
Phase 1: 프로젝트 열기 + repo-local DB + 태스크/Git skeleton
Phase 2: stub role run + approval + audit log + 상태 전이
Phase 3a: Helm host runner + Codex/Claude 단일 실행
Phase 3b: Docker Hermes observer + 실행 관찰/감사 보조
Phase 3c: reviewer/tester chain + gate result
Phase 4+: Git graph, terminal, Jira, Slack, backup/recovery
```

초기 다중 agent 실행은 금지한다. 실제 agent 실행은 `maxParallelRuns=1`에서 시작하고, worktree 격리와 artifact/audit 검증이 안정화된 뒤 `2`로 올린다. Claude/Codex 인증과 CLI 실행은 Helm backend가 로컬 host에서 담당한다. Hermes는 Helm을 대체하는 오케스트레이터나 agent 실행자가 아니라 Docker 기반 관찰/감사 보조 계층으로 다룬다.

## Legacy Node CLI

기존 CLI는 Git 상태, 세션 artifact, agent binary resolution, safe commit, PR dry-run/create 흐름을 검증한 reference로 남긴다.

Legacy CLI 요구사항:

- Node.js 25 이상

현재 CLI는 Node의 TypeScript type stripping을 사용한다. Node 20에서는 `node src/cli.ts`를 직접 실행할 수 없다.

주요 명령:

```bash
npm run check
node src/cli.ts --help
node src/cli.ts agents
node src/cli.ts run --agent codex --dry-run "현재 repo 상태 요약"
node src/cli.ts status
node src/cli.ts show <session>
node src/cli.ts commit <session> --check "npm run check" -m "테스트 실패 수정"
node src/cli.ts pr <session> --dry-run --base main --title "테스트 실패 수정"
node src/cli.ts ui
```

로컬 개발 중에는 `npm link`로 `inxx-helm` 명령을 연결할 수 있다. Kubernetes Helm과 binary 이름 충돌을 피하기 위해 `helm`이 아니라 `inxx-helm`을 사용한다.

```bash
npm link
inxx-helm --help
inxx-helm run --agent codex --dry-run "현재 repo 상태 요약"
```

Legacy 실행 기록은 `.helm/` 아래에 저장하며 git에 커밋하지 않는다.

## Repo-Local Config

Legacy CLI는 `.helm/config.json`에서 agent binary, 기본 commit check, PR base branch를 읽는다.

```json
{
  "agentBinaries": {
    "codex": "/opt/homebrew/bin/codex",
    "claude": "/opt/homebrew/bin/claude",
    "gemini": "/opt/homebrew/bin/gemini"
  },
  "defaultCheckCommand": "npm run check",
  "prBaseBranch": "main"
}
```

CLI 옵션과 환경 변수는 이 파일보다 우선한다. 예를 들어 `HELM_CODEX_BIN`은 `agentBinaries.codex`를 덮어쓴다.

## Cleanup Note

기존 `src/ui/` static HTTP UI는 미래 Tauri 앱의 기반이 아니다. Phase 1 구현은 `apps/desktop`에서 새로 시작하고, legacy static UI는 reference로만 둔다.
