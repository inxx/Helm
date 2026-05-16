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
- [Next Steps](docs/next-steps.md): legacy CLI MVP 완료 기록

Phase 1 구현자는 `Phase 0-1 Implementation Plan`의 command/DTO, migration runner, Git parser, verification contract를 먼저 따른다. 장기 설계와 충돌하면 Phase 0-1 문서가 우선한다.

Phase 1은 의도적으로 작게 닫는다.

- `apps/desktop` 생성
- Git 프로젝트 열기
- `repo/.helm/helm.sqlite` 생성/열기
- 프로젝트 설정 skeleton 저장/로드
- 한국어 라이트 태스크 보드 skeleton 표시
- read-only local Git snapshot 표시

Phase 1에서는 agent 실행, terminal PTY, worktree, Jira/Slack, Obsidian backfill, Keychain, merge, quality gate를 구현하지 않는다.

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

현재 `src/ui/` 아래의 uncommitted static UI 변경은 미래 Tauri 앱의 기반이 아니다. `apps/desktop` 구현을 시작하기 전에 legacy patch로 보관하거나 원복 대상으로 다룬다.
