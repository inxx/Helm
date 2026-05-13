# Helm Next Steps

작성일: 2026-05-13
브랜치: `feature/helm-cli-mvp`

## 현재 완료 상태

Helm CLI MVP는 로컬 single-agent 실행, safe commit, GitHub PR dry-run/생성, repo-local config 흐름까지 닫힌 상태다.

완료된 명령:

- `helm help`
- `helm version`
- `helm agents`
- `helm run --agent codex|claude|gemini "<prompt>"`
- `helm run --dry-run`
- `helm status`
- `helm show [session]`
- `helm diff [session]`
- `helm log [session]`
- `helm commit [session] -m "..."`
- `helm commit [session] --check "npm run check" -m "..."`
- `helm pr [session] --base main --title "..."`
- `.helm/config.json` 기반 agent binary/default check/PR base 설정

완료 커밋:

- `f93bdce` feat: Helm CLI 초기 스캐폴드 추가
- `d053774` feat: 세션 저장소와 git 상태 명령 추가
- `17cad15` feat: agent 실행 세션 기록 추가
- `0938863` feat: 세션 기반 safe commit 명령 추가
- `1ff307f` fix: agent binary 경로 override 지원
- `fbc0c73` feat: agent 실행 출력 스트리밍 추가
- `c1ea8aa` feat: local link 실행 경로 보강
- `605ba97` feat: commit check 옵션 추가
- `52a476b` feat: session 변경 파일 정밀화
- `7f17946` feat: 세션 기반 GitHub PR 명령 추가
- `3a01766` feat: 세션 상세 조회 명령 추가
- `cd63675` feat: Helm 저장소 로컬 설정 추가

## 검증된 사용법

```bash
npm link
helm --help
helm run --agent codex --dry-run "현재 repo 상태 요약"
helm show <session>
helm commit <session> --check "npm run check" -m "커밋 메시지"
helm pr <session> --dry-run --base main --title "PR 제목"
```

repo-local config 사용 예:

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

검증 결과:

- `npm run check`: 통과
- `helm --help`: 정상 출력
- `helm run --agent codex --dry-run ...`: 정상 세션 생성
- `helm show <session>`: 정상 요약 출력
- `helm commit <session> --dry-run -m ...`: session 변경 파일 기준 출력
- `.helm/config.json`의 `defaultCheckCommand`: commit dry-run에 정상 반영
- `.helm/config.json`의 `prBaseBranch`: PR dry-run에 정상 반영
- `helm pr <session> --dry-run ...`: 정상 명령/본문 출력
- Codex 실제 호출: 성공
- Gemini 실제 호출: 성공
- Claude 실제 호출: `-p "<prompt>"` 옵션은 유효하나 로컬 인증 401로 실패

## 남은 blocker

### Claude 인증

현재 `/opt/homebrew/bin/claude -p "<prompt>"` 호출은 인증 401로 실패한다.

다음 작업 전 확인:

```bash
claude -p "ok만 출력해"
helm run --agent claude "ok만 출력해"
```

실패가 계속되면 Helm adapter 문제가 아니라 로컬 Claude 인증 문제로 분류한다.

### binary 이름 충돌

`npm link`는 `/opt/homebrew/bin/helm`을 만든다. Kubernetes Helm을 쓰는 환경에서는 충돌 가능성이 있으므로 장기적으로 binary 이름을 `hhelm`, `inxx-helm` 같은 별도 이름으로 바꿀지 결정해야 한다.

## 다음 실행 순서

### Step 1. GitHub/PR 연동 설계

상태: 구현/검증 완료

목표:

- 세션 커밋 hash를 기준으로 branch push와 draft PR 생성을 연결한다.

권장 명령 초안:

```bash
helm pr <session> --draft --base main --title "..."
```

설계 시 결정할 것:

- GitHub CLI(`gh`) 직접 호출로 시작한다.
- push와 PR 생성을 한 명령에 묶는다.
- PR body에는 session metadata, prompt, artifact 경로, 변경 파일 목록만 넣고 log/diff 원문은 넣지 않는다.
- 실패한 check가 기록된 session의 PR 생성은 막는다.

구현된 명령:

```bash
helm pr <session> --base main --title "..."
helm pr <session> --dry-run --base main --title "..."
```

### Step 2. session summary

상태: 구현/검증 완료

목표:

- `helm status`보다 자세한 단일 세션 요약을 제공한다.

권장 명령 초안:

```bash
helm show <session>
```

포함할 정보:

- agent, prompt, exit code
- branch, head, changedFiles
- log/diff/check log path
- commit hash

구현된 명령:

```bash
helm show <session>
helm show
```

### Step 3. config 파일

상태: 구현/검증 완료

목표:

- agent binary, default check command, PR base branch를 repo-local config로 관리한다.

권장 파일:

```text
.helm/config.json
```

주의:

- `.helm/`은 현재 gitignore 대상이다.
- 팀 공유 config가 필요해지면 `.helm.example.json` 같은 tracked 파일을 따로 둔다.

구현된 config:

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

적용 우선순위:

- agent binary: 환경 변수 > `.helm/config.json` > 내장 기본값
- commit check: `--check` 옵션 > `.helm/config.json`
- PR base: `--base` 옵션 > `.helm/config.json` > `main`

### Step 4. dogfood 시나리오 정리

상태: 완료

목표:

- Helm repo 자체에서 `.helm/config.json` 기본값을 사용해 run → show → commit dry-run → pr dry-run 흐름을 한 번에 검증한다.

권장 검증 순서:

```bash
mkdir -p .helm
$EDITOR .helm/config.json
helm run --agent codex --dry-run "Helm repo 상태 요약"
helm show
helm commit --dry-run -m "테스트 커밋"
helm pr <committed-session> --dry-run --title "Helm dogfood"
```

확인할 것:

- `helm run` 세션 metadata의 `command`가 config의 agent binary를 사용한다. 검증 완료: `/opt/homebrew/bin/codex`.
- `helm commit --dry-run`이 `--check` 없이도 config의 `defaultCheckCommand`를 표시한다. 검증 완료: `npm run check`.
- `helm pr <committed-session> --dry-run`이 `--base` 없이도 config의 `prBaseBranch`를 사용한다. 검증 완료: `main`.
- `.helm/config.json`은 gitignore 대상이므로 커밋하지 않는다. 검증 완료: `.gitignore`의 `.helm/` 항목 유지.

주의:

- `helm run --dry-run`이 만든 최신 세션은 commit되지 않은 세션이므로 `helm pr --dry-run`의 기본 대상이 될 수 없다.
- PR dry-run 검증은 기존 committed 세션을 명시하거나, 실제 commit 이후 최신 세션으로 실행해야 한다.

### Step 5. binary 이름 충돌 결정

상태: 다음 작업

목표:

- Kubernetes Helm과의 이름 충돌을 피할지 결정하고, 필요하면 package `bin` 이름과 README 사용법을 바꾼다.

선택지:

- `helm` 유지: 사용감은 좋지만 Kubernetes Helm 사용자 환경과 충돌한다.
- `hhelm` 또는 `inxx-helm`로 변경: 충돌은 줄지만 명령이 길어진다.

구현 시 확인할 것:

- [package.json](../package.json)의 `bin` key
- README의 `helm ...` 예시
- CLI help 문구
- symlink direct-run 테스트

### Step 6. PR 명령 안정화

상태: 다음 작업

목표:

- `helm pr`을 실제 repo에서 반복 사용해도 실패 원인을 명확히 알 수 있게 한다.

후보 작업:

- `gh` 미설치/미인증 시 에러 메시지 개선
- remote `origin` 없음 또는 upstream push 실패 시 안내 개선
- PR 생성 후 session metadata 조회 테스트 보강
- ready PR 생성 옵션 `--ready` 실제 출력/저장 검증 보강

## 다음 세션 시작 체크

```bash
git status --short --branch
npm run check
helm status
```

작업 시작 시 위 세 명령이 정상이어야 다음 단계를 진행한다. 현재 마지막 정상 커밋은 `cd63675 feat: Helm 저장소 로컬 설정 추가`다.
