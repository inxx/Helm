# Helm

Helm은 개인용 Oz-like CLI agent hub다. 첫 범위는 Warp/Oz를 복제하는 것이 아니라, 로컬 git repo에서 Codex, Claude, Gemini 같은 CLI agent 실행을 추적하고 diff/commit 흐름을 안전하게 관리하는 것이다.

## 원칙

- Warp 코드는 참고만 하고 복사하지 않는다.
- 첫 MVP는 로컬 single-agent 실행, 세션 로그, git diff, safe commit에 집중한다.
- 외부 패키지 없이 Node 내장 모듈로 시작한다.
- repo-local `.helm/`은 실행 기록 저장소로 쓰며 git에 커밋하지 않는다.

## 요구사항

- Node.js 25 이상

Node의 TypeScript type stripping을 사용하므로 별도 빌드 단계가 없다.

## 사용

```bash
npm run check
node src/cli.ts --help
node src/cli.ts agents
node src/cli.ts run --agent codex --dry-run "현재 repo 상태 요약"
node src/cli.ts status
node src/cli.ts show <session>
node src/cli.ts log
node src/cli.ts commit <session> --check "npm run check" -m "테스트 실패 수정"
node src/cli.ts pr <session> --dry-run --base main --title "테스트 실패 수정"
```

다음 작업 순서는 [docs/next-steps.md](docs/next-steps.md)에 정리한다.

### 로컬 개발 설치

개발 중에는 repo 루트에서 npm link로 `inxx-helm` 명령을 연결할 수 있다.

```bash
npm link
inxx-helm --help
inxx-helm run --agent codex --dry-run "현재 repo 상태 요약"
```

실행 명령은 Kubernetes Helm과의 binary 이름 충돌을 피하기 위해 `inxx-helm`을 사용한다. `node src/cli.ts ...` 형태도 로컬 개발에서 그대로 사용할 수 있다.

### repo-local config

Helm은 repo-local `.helm/config.json`을 읽어 agent binary, 기본 commit check, 기본 PR base branch를 적용한다. `.helm/`은 개인 실행 기록과 설정 저장소로 git에 커밋하지 않는다.

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

CLI 옵션과 환경 변수는 config보다 우선한다. 예를 들어 `inxx-helm commit --check "npm test"`는 `defaultCheckCommand`를 덮어쓰고, `HELM_CODEX_BIN`은 `agentBinaries.codex`를 덮어쓴다.

### agent binary 경로

기본 command는 `codex`, `claude`, `gemini`다. macOS에서 Homebrew Codex binary가 있으면 `/opt/homebrew/bin/codex`를 우선 사용한다.

전역 npm 설치본이 깨졌거나 PATH가 다른 binary를 먼저 잡으면 환경 변수로 명시한다.

```bash
HELM_CODEX_BIN=/opt/homebrew/bin/codex node src/cli.ts run --agent codex "현재 repo 상태 요약"
HELM_CLAUDE_BIN=/path/to/claude node src/cli.ts run --agent claude "계획 세워줘"
HELM_GEMINI_BIN=/path/to/gemini node src/cli.ts run --agent gemini "리뷰해줘"
```

2026-05-13 현재 로컬 검증 결과:

- Codex `/opt/homebrew/bin/codex`: `exec "<prompt>"` 호출 성공
- Claude `/opt/homebrew/bin/claude`: `-p "<prompt>"` 옵션은 유효하나 로컬 인증 401로 실행 실패
- Gemini `/opt/homebrew/bin/gemini`: `-p "<prompt>"` 호출 성공

향후 목표 명령:

```bash
inxx-helm run --agent codex "현재 repo 테스트 실패 고쳐줘"
inxx-helm status
inxx-helm diff
inxx-helm commit -m "테스트 실패 수정"
```

### commit check

`inxx-helm commit`은 `--check "<command>"` 옵션으로 커밋 전 검증 명령을 실행할 수 있다. check 명령이 실패하면 Helm은 파일을 stage하지 않고 커밋을 중단하며, `.helm/sessions/<session>.check.log`에 stdout/stderr를 저장한다.

```bash
inxx-helm commit <session> --check "npm run check" -m "테스트 실패 수정"
```

`.helm/config.json`에 `defaultCheckCommand`가 있으면 `--check`를 넘기지 않은 `inxx-helm commit`에도 같은 check가 적용된다.

첫 버전의 `--check`는 사용자가 넘긴 문자열을 shell command로 실행한다. 신뢰한 repo-local 명령에만 사용한다.

### GitHub PR

`inxx-helm pr`은 커밋된 세션의 branch를 `origin`에 push한 뒤 GitHub CLI로 draft PR을 만든다. PR 본문에는 세션 id, agent, prompt, commit hash, check 결과, artifact 경로, 변경 파일 목록을 포함한다.

```bash
inxx-helm pr <session> --base main --title "테스트 실패 수정"
inxx-helm pr <session> --dry-run --base main --title "테스트 실패 수정"
```

`.helm/config.json`에 `prBaseBranch`가 있으면 `--base`를 생략했을 때 해당 branch를 기본값으로 사용한다.

실패한 check가 기록된 세션이나 아직 커밋되지 않은 세션은 PR 생성 대상에서 제외한다. 기본값은 draft PR이며, ready PR이 필요하면 `--ready`를 사용한다.

## 세션 저장

`inxx-helm run`은 repo-local `.helm/sessions`에 다음 파일을 남긴다.

- `<session>.json`: 세션 metadata
- `<session>.log`: agent stdout/stderr 로그
- `<session>.diff`: 실행 후 git diff

실제 agent 실행 중 stdout/stderr는 터미널에도 실시간으로 전달되며, 동일 내용이 세션 로그에 저장된다.

`.helm/`은 개인 실행 기록이므로 git에 커밋하지 않는다.
