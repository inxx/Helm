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
```

향후 목표 명령:

```bash
helm run --agent codex "현재 repo 테스트 실패 고쳐줘"
helm status
helm diff
helm commit -m "테스트 실패 수정"
```
