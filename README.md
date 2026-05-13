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
node src/cli.ts log
```

### agent binary 경로

기본 command는 `codex`, `claude`, `gemini`다. macOS에서 Homebrew Codex binary가 있으면 `/opt/homebrew/bin/codex`를 우선 사용한다.

전역 npm 설치본이 깨졌거나 PATH가 다른 binary를 먼저 잡으면 환경 변수로 명시한다.

```bash
HELM_CODEX_BIN=/opt/homebrew/bin/codex node src/cli.ts run --agent codex "현재 repo 상태 요약"
HELM_CLAUDE_BIN=/path/to/claude node src/cli.ts run --agent claude "계획 세워줘"
HELM_GEMINI_BIN=/path/to/gemini node src/cli.ts run --agent gemini "리뷰해줘"
```

향후 목표 명령:

```bash
helm run --agent codex "현재 repo 테스트 실패 고쳐줘"
helm status
helm diff
helm commit -m "테스트 실패 수정"
```

## 세션 저장

`helm run`은 repo-local `.helm/sessions`에 다음 파일을 남긴다.

- `<session>.json`: 세션 metadata
- `<session>.log`: agent stdout/stderr 로그
- `<session>.diff`: 실행 후 git diff

`.helm/`은 개인 실행 기록이므로 git에 커밋하지 않는다.
