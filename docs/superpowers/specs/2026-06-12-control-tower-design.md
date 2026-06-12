# 관제탑(Control Tower) 설계

날짜: 2026-06-12
상태: 승인됨

## 배경과 목표

Helm의 관찰(옵저버) 정보가 TaskDetail 패널과 10단계 칸반 안에 묻혀 있어 "지금 누가 뭘 하고 있나"를 한눈에 추적하기 어렵다. 사용자의 1차 추적 단위는 태스크가 아니라 **에이전트(작업자)** 다.

목표: 에이전트 중심의 실시간 관찰 화면 "관제탑"을 최상위 탭으로 신설한다. 칸반은 "작업 구조 보기"로 역할을 축소하되 화면은 그대로 유지한다.

## 결정 사항

1. **추적 1차 단위**: 에이전트(작업자) 중심. provider(codex/claude/gemini)별 레인.
2. **배치**: 새 최상위 탭 "관제탑"을 내비게이션 첫 번째에 추가. 기존 태스크/깃/터미널/설정 화면은 축소·삭제하지 않는다.
3. **지휘 구조**: 중립. Codex Desktop 감시지휘든 Claude Desktop+Hermes 분배든 동일한 이벤트 계약으로 표시. "누가 시켰는가"(명령 체인) 추적은 의도적으로 범위 밖 — 향후 run_event 메타 태깅으로 점진 확장 가능하게만 설계.
4. **실시간성**: 이벤트 즉시 반영. 기존 `agent-run://event`, `agent-run://updated` Tauri 채널 구독 (main.rs `emit_run_event` 기구현). 신규 emit 없음.

## 검토한 대안

- **A. 파생 뷰 레이어**: 기존 agent_runs/run_events를 읽기 전용 재구성. → 채택(A′로 보강)
- **B. command_session 테이블 신설**: 명령 체인 정밀 추적. → 기각. "새 테이블 금지" 원칙(codex-hermes-helm-observer-plan.md) 위반, 중립 구조와 충돌, 양쪽 데스크톱 래퍼 수정 필요.
- **C. run_event 상관관계 태깅**: 래퍼가 메타를 채워야 의미 있음. → 지금은 과투자, 향후 확장 경로로만 유지.

**A′ = A + provider 필드 승격.** `AgentRunSummary`에 provider/connectionId가 없고 `Runner request captured` 이벤트 payload에만 묻혀 있어(db.rs claim_host_run 부근), 레인 그룹핑을 기록된 사실 기반으로 만들기 위해 컬럼으로 승격한다. 컬럼 추가는 기존 run 구조의 확장이므로 "새 테이블 금지" 계약 위반이 아니다.

## 화면 레이아웃 (3층)

```
┌─────────────────────────────────────────────────────┐
│ ① 지휘 현황 줄: 승인 대기 N · 실행 중 N · 마지막 신호 │
├─────────────────────────────────────────────────────┤
│ ② 확인 필요 스트립: 승인 대기·멈춤 의심·실패 run 카드 │
├──────────────┬──────────────┬───────────────────────┤
│ ③ Codex 레인 │  Claude 레인 │  Gemini 레인 │ 미분류 │
└──────────────┴──────────────┴───────────────────────┘
```

- **① 지휘 현황 줄**: 프로젝트 전체의 승인 대기 수, 활성 run 수, 마지막 이벤트 시각. 특정 지휘자를 가정하지 않는다.
- **② 확인 필요 스트립**: `runLiveState.ts`의 attention 상태(`approval_pending`, `stalled_candidate`, `needs_inspection`, `orphaned_after_restart`)인 run만 가로 나열. 없으면 스트립 숨김.
- **③ 작업자 레인**: provider별 세로 레인 + "미분류"(provider NULL).
  - 활성 run 카드: 태스크 제목, 역할, live state 칩, 마지막 신호 경과시간, 변경 파일 수
  - 최근 완료 run: 레인당 최대 5개, 흐리게, 결과(pass/fail)+종료 시각
  - 활성 run 없으면 "유휴"
  - run 카드 클릭 → 기존 TaskDetail 패널 재사용 (상세 관찰 UI 신규 제작 없음)

## 데이터 변경

- `agent_runs`에 nullable 컬럼 3개 추가: `provider`, `connection_id`, `model`
- `claim_host_run`이 이미 받는 메타(runner/provider/connectionId/model/adapter)를 claim 시점에 컬럼으로 저장
- 백필 마이그레이션: 기존 run은 `Runner request captured` 이벤트 payload에서 추출. 불가 시 NULL → 미분류 레인
- `AgentRunSummary`(Rust models.rs / TS types.ts)에 `provider`, `connectionId`, `model` 필드 추가
- 신규 Tauri 커맨드: `list_project_runs(project_id, limit)` — 프로젝트 전체 run을 레인용으로 일괄 조회 (기존 조회는 태스크 단위)

## 실시간 갱신

- `agent-run://updated` 수신 → 레인/지휘 현황 재조회
- `agent-run://event` 수신 → 해당 run 카드의 "마지막 신호" 즉시 갱신
- quiet/stalled 시간 경과 전환은 기존 패턴대로 프론트 타이머에서 `deriveRunLiveState` 재파생

## 에러 처리·엣지 케이스

- provider NULL run은 미분류 레인에 노출 (관찰 도구에서 데이터 누락은 보여야 한다)
- 재시작 후 고아 run은 기존 `orphaned_after_restart` 상태로 확인 필요 스트립에 노출
- 같은 provider 다중 계정: 레인은 provider 단위 유지, 카드에 connection 라벨 칩 표시 (레인 폭발 방지)

## 테스트

- Rust: 마이그레이션+백필 단위 테스트, `list_project_runs` 쿼리 테스트
- TS: 레인 그룹핑 파생 함수(순수 함수로 분리) 단위 테스트 — `runLiveState.ts`와 동일 패턴
- 기존 테스트 회귀 확인: `AgentRunSummary` 필드 추가가 직렬화/역직렬화를 깨지 않는지

## 완료 기준

- 관제탑 탭만 보고 "지금 어느 에이전트가 어떤 태스크의 어떤 역할을 실행 중이고, 내가 개입할 것이 있는지" 판단 가능
- run 시작/이벤트/종료가 수동 새로고침 없이 반영
- 칸반·태스크 상세·터미널·깃 화면은 기존 동작 그대로
- 기존 run(provider 미기록)도 미분류 레인에서 추적 가능
