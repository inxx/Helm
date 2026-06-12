# Codex-Hermes-Helm Observer Plan

## 목표

Helm은 기본적으로 실행자가 아니라 관찰자다. 사용자는 Codex Desktop에 명령하고, Codex Desktop은 승인된 범위 안에서 Hermes 또는 로컬 CLI를 호출한다. Hermes와 runner wrapper는 실행 결과를 Helm의 기존 `agent_runs`, `run_events`, `command_evidence`, `.helm/artifacts/runs/*` 계약에 append한다.

## 권한 경계

| 영역 | 책임 |
| --- | --- |
| Codex Desktop | 사용자 명령 수신, 승인 게이트, 실제 실행 결정 |
| Hermes | Claude/Gemini/Codex CLI 호출 브리지, 요청/응답/artifact 표준화 |
| Helm | run timeline, 상태, stdout/stderr, artifact, diff 관찰 |
| Helm 승인 버튼 | 보조 승인 액션. 기본 명령권자는 Codex Desktop |

## 구현 단계

1. Helm observer UI를 먼저 강화한다.
   - 현재 단계, 실행 환경, 참조/작성 문서, 컨텍스트/스킬 사용, 변경 파일, 검증 근거를 Task 상세에서 즉시 보여준다.
   - 터미널과 Git 화면은 유지한다.

2. 기존 Helm run schema에 관찰 이벤트를 append한다.
   - `Runner request captured`: provider/model/adapter/worktree/artifact/env key 기록
   - `Execution artifacts collected`: stdout/stderr/changed-files/diff 경로와 변경 파일 수 기록
   - 기존 `stdout`, `stderr`, `status`, `result`, `artifact` 이벤트는 유지한다.

3. Codex-Hermes wrapper를 별도 추가한다.
   - 입력: provider, command, cwd, prompt summary, artifact dir
   - 출력: stdout/stderr, exit code, result status, artifact paths, changed files
   - Helm에는 새 테이블을 만들지 않고 기존 run/event/artifact 구조로 기록한다.

4. `helm-claude`와 기존 host runner는 삭제하지 않는다.
   - 기본 실행 경로에서 직접 자동 실행을 줄이고, 수동 승인 fallback으로 유지한다.
   - 터미널과 Git 기능도 별도 유지한다.

## 관찰 데이터 계약

각 run은 최소 다음 정보를 남긴다.

- run 시작/종료 timestamp
- agent 종류와 provider: `claude`, `gemini`, `codex`, `fixture`
- task, worktree, repo
- prompt/context 요약
- 참조 문서: `context-pack.md`, `context-pack.json`, 관련 planning artifact
- 작성 문서: `summary.md`, `structured-result.json`, `stdout.log`, `stderr.log`
- 변경 파일: `changed-files.json`, `diff.patch`
- exit code, result status, failure kind/reason

## 완료 기준

- 사용자가 Task 상세의 현재 실행 카드만 보고 어느 단계인지 판단할 수 있다.
- runner/provider/model/worktree/artifact 경로가 이벤트와 UI에 보인다.
- 어떤 md를 참조했고 어떤 artifact를 작성했는지 버튼 없이도 요약된다.
- 변경 파일과 검증 근거가 종료 후 artifact와 연결된다.
- 터미널과 Git 기능은 삭제하거나 축소하지 않는다.
