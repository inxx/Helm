# Role Artifact Contract

Helm의 role run은 채팅 응답이 아니라 repo-local artifact를 source of truth로 삼는다. 모든 role은 공통 artifact와 역할별 md dossier를 남겨야 하며, Helm은 이 계약을 기준으로 실행 기록, 검토, 테스트, PR handoff를 제품 화면에 노출한다.

## 공통 산출물

모든 `agent_runs`는 `.helm/artifacts/runs/<run-id>/` 아래에 다음 파일을 남긴다.

- `summary.md`: 짧은 실행 요약
- `structured-result.json`: Helm 상태 전이와 gate 판정용 구조화 결과
- `stdout.log`: runner stdout
- `stderr.log`: runner stderr
- `changed-files.json`: 실행 후 실제 변경 파일
- `diff.patch`: 실행 후 실제 diff

`structured-result.json`은 schema v1을 만족해야 한다. schema를 만족하지 못하면 run은 성공으로 처리하지 않고 `NeedsInspection`으로 멈춘다.

## 역할별 md dossier

역할별 md dossier는 사람이 읽는 handoff source of truth다. `summary.md`보다 길고, 다음 역할이나 PR 작성자가 바로 판단할 수 있는 근거를 포함한다.

| role_id | 파일 | 목적 |
| --- | --- | --- |
| `planner` | `plan.md` | 목표, 범위, 제외 범위, 실행 단계, acceptance criteria, 검증 계획, 위험, open questions |
| `coder` | `pr-dossier.md` | 작업 기록, 변경 파일과 이유, 의사결정, 참고문서, 실행 명령, 검증 결과, 남은 위험, PR 본문 초안 |
| `plan_verifier` | `plan-verification.md` | 승인 계획 대비 구현 일치 여부, 누락된 acceptance criteria, 범위 밖 변경, 차단/비차단 판정 |
| `code_reviewer` | `review-report.md` | 리뷰 finding, 파일/조건 근거, 수정 요청, 수정 확인 여부, 남은 위험 |
| `tester` | `test-report.md` | 실행한 테스트/빌드/타입체크 명령, 결과, 실패 로그 요약, 생략 사유, 재시도 방법, 최종 판정 |

host runner는 `HELM_ROLE_DOSSIER_PATH` 환경변수로 현재 role의 dossier 경로를 받는다. 이 파일이 비어 있거나 queued placeholder 상태로 남아 있으면 Helm은 성공으로 넘기지 않고 `NeedsInspection`으로 멈춘다.

## 제품 표시

Task detail의 run document 영역은 공통 산출물과 현재 role의 dossier를 함께 보여준다. evidence card와 run list에서도 role dossier 버튼을 제공한다.

## Obsidian 저장

프로젝트 설정의 Obsidian vault path가 켜져 있으면 Helm은 계획 문서와 실행 문서를 Obsidian에도 저장한다.

- 기본 저장 위치: `{vault}/projects/{project}/desktop/plans`, `{vault}/projects/{project}/desktop/sessions`
- 설정 메뉴의 `산출물 경로`가 있으면 해당 경로를 우선 사용한다.
- `산출물 경로`가 상대 경로이면 Vault 하위 경로로 해석한다.
- `산출물 경로`가 절대 경로이면 Vault 밖의 지정 위치에 저장할 수 있다.
- 실행 문서에는 `summary.md` 내용과 역할별 md dossier 본문을 함께 포함한다.

## 계약 유지 원칙

- role dossier는 `structured-result.json`의 결론과 충돌하면 안 된다.
- gate role은 차단 이슈를 dossier에 사람이 읽을 수 있게 쓰고, `structured-result.json.gateResult`에도 기계가 읽을 수 있게 남긴다.
- runner가 실제 구현을 하지 못한 경우에도 dossier에 실패 이유와 다음 행동을 남긴다.
- Helm은 자유문장 채팅 응답을 상태 전이 근거로 사용하지 않는다.
