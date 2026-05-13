# Helm Next Steps

작성일: 2026-05-13
브랜치: `feature/helm-cli-mvp`

## 현재 완료 상태

Helm CLI MVP는 로컬 single-agent 실행과 safe commit 흐름까지 닫힌 상태다.

완료된 명령:

- `helm help`
- `helm version`
- `helm agents`
- `helm run --agent codex|claude|gemini "<prompt>"`
- `helm run --dry-run`
- `helm status`
- `helm diff [session]`
- `helm log [session]`
- `helm commit [session] -m "..."`
- `helm commit [session] --check "npm run check" -m "..."`

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

## 검증된 사용법

```bash
npm link
helm --help
helm run --agent codex --dry-run "현재 repo 상태 요약"
helm commit <session> --check "npm run check" -m "커밋 메시지"
```

검증 결과:

- `npm run check`: 통과
- `helm --help`: 정상 출력
- `helm run --agent codex --dry-run ...`: 정상 세션 생성
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

목표:

- 세션 커밋 hash를 기준으로 branch push와 draft PR 생성을 연결한다.

권장 명령 초안:

```bash
helm pr <session> --draft --base main --title "..."
```

설계 시 결정할 것:

- GitHub CLI(`gh`) 직접 호출로 시작할지
- push와 PR 생성을 한 명령에 묶을지
- PR body에 session log/diff/check log 요약을 어디까지 넣을지
- 실패한 check가 있는 session의 PR 생성을 막을지

### Step 2. session summary

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

### Step 3. config 파일

목표:

- agent binary, default check command, PR base branch를 repo-local config로 관리한다.

권장 파일:

```text
.helm/config.json
```

주의:

- `.helm/`은 현재 gitignore 대상이다.
- 팀 공유 config가 필요해지면 `.helm.example.json` 같은 tracked 파일을 따로 둔다.

## 다음 세션 시작 체크

```bash
git status --short --branch
npm run check
helm status
```

작업 시작 시 위 세 명령이 정상이어야 다음 단계를 진행한다.
