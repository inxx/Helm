# Hermes 전용 ACP 아키텍처

작성일: 2026-06-23

이 문서는 [`synara-style-acp-session-direction.md`](./synara-style-acp-session-direction.md)의 방향을 구체화하고, "멀티프로바이더 control plane"에서 **Hermes 전용 control plane**으로 전환하는 결정을 고정한다.

## 결정 요약

Helm은 오케스트레이터를 **자체 구현하지 않는다.** Hermes가 이미 다음을 내장한다:

- **ACP 서버 모드** (`hermes acp`, stdio 위 줄 단위 JSON-RPC)
- **delegate_task 단계별 멀티모델 위임** (child별 model/toolset/iteration override)
- **durable kanban** (`kanban.db`) — 작업 보드 + 작업별 model/skills/step/worktree 설정
- **세션·메시지·툴콜 audit** (`state.db`) — 부모/자식 계보 + 토큰/비용 회계

따라서 Helm의 역할은 둘로 압축된다:

1. **구동(drive)**: ACP로 live 세션(chat/prompt/approval/cancel/load) + `hermes kanban` CLI로 작업 생성·설정
2. **렌더·감사(render/audit)**: `kanban.db`(board) + `state.db`(세션 트리·툴콜·cost)를 읽어 control-center와 audit 화면 구성

## 검증 근거 (2026-06-23 spike)

로컬 네이티브 Hermes v0.17.0(`~/.local/bin/hermes`, provider=mlx 로컬)로 ACP 구동 후 `delegate_task` 강제 실행하여 확인:

- ACP 전송 = **줄 단위 JSON(NDJSON)**. `initialize → session/new → session/prompt → {stopReason}`. update 종류: `agent_message_chunk / tool_call / tool_call_update / usage_update / available_commands_update`.
- agentCapabilities: `loadSession:true`, `sessionCapabilities:{fork, list, resume}`.
- **위임 표면화(부모 ACP 스트림)**: 위임 `tool_call`(title `delegate: ...`) + dispatch 메타(`delegation_id, goals, mode:"background", count`)만. 자식 *최종 결과*는 비동기로 다음 턴 새 메시지로 재진입("Do not wait or poll"). **자식의 내부 tool call·diff는 부모 스트림에 오지 않음.**
- **단, 자식 활동은 `state.db`에 완전 영속**: `sessions.parent_session_id`(FK+인덱스)로 트리, `messages`에 `tool_calls/tool_call_id/tool_name/content`까지. spike에서 자식 세션의 `tool | {"output":"BANANA","exit_code":0}`까지 확인.
- **`kanban.db.tasks`에 Helm이 원하던 knob이 이미 존재**: `model_override`(작업별 모델), `skills`(JSON), `workflow_template_id`+`current_step_key`(단계별 라우팅), `goal_mode`+`goal_max_turns`(judge goal-loop), `branch_name`/`workspace_path`/`workspace_kind`(worktree), `session_id`+`current_run_id`(카드↔세션↔run 조인). `task_runs`(task_id/step_key/status/outcome/summary/error) = 기존 Helm `agent_runs` 대응.

**조인 체인**: `kanban.tasks.session_id → state.db.sessions.id → (parent_session_id 자식들) → messages(tool_calls)`.

## 데이터: 신/구 매핑

| 기존 Helm (`.helm` SQLite) | Hermes 소스 |
| --- | --- |
| `agent_runs` / `run_events` | `kanban.db.task_runs` + `state.db.sessions`/`messages` |
| `tasks` / epics | `kanban.db.tasks` |
| worktree/branch | `kanban.tasks.workspace_path` / `branch_name` |
| approvals (run/plan) | ACP `session/request_permission` (live) |
| `AgentSessionSummary` 투영(`sourceRunId`) | `state.db.sessions` (parent_session_id 트리) |
| 역할별 모델 배정(roleAssignments) | Hermes **프로필**(stage=profile=model). `hermes kanban create --assignee <profile>` |

## 폐기 / 유지

**점진 폐기** (즉시 삭제 아님 — 병행 기간 후):

- host runner 자동 실행 경로, `scripts/claude-desktop-handoff.mjs`의 멀티프로바이더 브리지
- 멀티프로바이더 connection / role-selection UI (Hermes profile/model_override로 대체)
- Helm 자체 task/run/approval **write** 경로

**유지**:

- `SessionsScreen` 채팅 surface (ACP transcript로 내용 교체)
- 터미널·Git 화면 (Git diff는 worktree에서 Helm이 직접 읽음)
- 승인 UI (`ApprovalInbox`) — ACP 권한 요청에 매핑
- 프로젝트 등록/recents

**주의(비가역)**: 기존 `.helm` SQLite는 즉시 제거하지 않고 read-path만 Hermes로 전환한다. 마이그레이션은 별도 단계.

## 결정적 워크플로 = kanban 단계 (확정, 택 b)

"설계(Opus) → 코딩(Sonnet) → 검증" 결정적 게이팅은 delegate_task가 아니라 **kanban 의존성 그래프**로 구현한다.

- **단계 = 프로필 = 모델**: `hermes profile create`로 단계별 프로필(예: `opus-designer`, `sonnet-coder`, `verifier`)을 만들고 각자 모델을 바인딩. 모델 선택은 `--assignee <profile>`로 라우팅(`kanban create`에 `--model` 없음).
- **순서 = 의존성**: `hermes kanban create ... --parent <prev_task_id>` 체인. child는 parent가 done 되기 전 ready가 되지 않으므로 게이트가 구조적으로 보장된다.
- **작업별 설정**: `--skill`(강제 스킬), `--goal`+`--goal-max-turns`(judge 루프=검증), `--workspace worktree`+`--branch`, `--idempotency-key`(재실행 안전), `--json`(생성된 task id 회수).
- **단축**: `hermes kanban swarm "<goal>" --worker P:T:S --verifier V --synthesizer S` = 병렬 워커→검증→통합 그래프 한 번에.
- **관찰**: `kanban.db.task_runs.status` 읽기 + `hermes kanban watch`/`tail`(라이브 이벤트 push) + `kanban show/runs/log`.
- Helm은 단계를 직접 advance하지 않고 의존성 그래프를 만든 뒤 `task_runs` 상태를 관찰·렌더한다. (delegate_task background fan-out은 관찰만.)

## ACP 클라이언트 (Rust) 설계

집 스타일(`std::process::Command` + `std::thread` 리더, `spawn_output_reader`/`spawn_pty_shell` 패턴)을 따른다. **tokio·async ACP 크레이트 불필요** — 의존성은 이미 있는 `serde_json`만.

- `hermes --yolo acp --accept-hooks`를 stdin/stdout 파이프로 spawn, NDJSON 송수신, reader thread에서 파싱.
- `AppState`에 ACP 세션 핸들 맵(`session_id → {child stdin writer, pending id 맵}`).
- Tauri command: `acp_session_new` / `acp_session_prompt` / `acp_session_cancel` / `acp_session_load`.
- Tauri event: `acp-session://update`, `acp-session://permission` (기존 `agent-run://event` 패턴 미러).
- `session/request_permission` → UI 승인 카드 → `{outcome:{outcome:"selected", optionId}}` 응답.
- `clientCapabilities`: `fs/terminal = false` (Hermes 내부 실행). Git diff는 Helm이 worktree에서 직접 읽어 표시.

## 첫 vertical slice

1. **ACP 클라이언트 모듈** + Tauri 명령 3개(new/prompt/cancel) + `update`/`permission` 이벤트.
2. **SessionsScreen**: 실제 ACP 세션 1개 생성 → 프롬프트 → 스트리밍 transcript(`agent_message_chunk`/`tool_call`) 렌더 + 권한 카드 응답 + cancel.
3. **read 경로**: `state.db`에서 활성 세션의 부모/자식 트리 + tool_call 요약을 Environment 패널에 표시 (rusqlite read-only).

**slice 제외**: kanban write 통합, 멀티프로바이더 제거, 기존 task 모델 마이그레이션 — 다음 단계.

## 성공 기준

- SessionsScreen에서 Hermes ACP 세션 생성 → 프롬프트 전송 → `tool_call`/메시지 실시간 렌더 → 권한 요청 승인·거부 → cancel 동작.
- 위임 발생 시 자식 세션이 `state.db` 트리에서 식별되고, 자식 tool call 요약이 화면에 보임.
- 기존 기능 회귀 없음 (`npm run check` 통과).

## 구현 현황 (2026-06-23, slice 1 완료)

Hermes-native control plane의 첫 제품 슬라이스가 구현·검증됨.

### 백엔드 (`apps/desktop/src-tauri/src/hermes.rs`, Tauri 커맨드)
- `list_hermes_board(limit)` — `kanban.db` tasks ⨝ task_runs(현재 run) + task_links(부모 의존성) read-only.
- `get_hermes_task_tree(task_id)` — assignee 프로필의 `~/.hermes/profiles/<assignee>/state.db`에서 워커 세션을 찾아(아래 매핑) parent_session_id로 BFS, 세션별 tool-call 근거 수집.
- `create_hermes_stage_chain(goal, stages[])` — `hermes kanban create --assignee <profile> --parent <prev>` 체인 셸아웃, 생성 task id 반환.
- `list_hermes_profiles()` — `default` + `~/.hermes/profiles/*`의 config.yaml `model:` 블록에서 모델/프로바이더 파싱.
- `hermes_kanban_action(action, task_id, reason?)` — unblock/promote/complete/block/archive 화이트리스트 셸아웃(human gate).

### 프론트 (`apps/desktop/src/screens/HermesScreen.tsx`, nav `Hermes`)
- 스테이지 빌더: 단계 추가/삭제, 단계별 프로필(=모델) 선택, 목표 입력 → 의존성 체인 생성.
- 상태 컬럼 보드(Blocked/Queued/Running/Done), blocked attention 표시, 의존성 gate 잠금 표시, 카드 human-gate 액션.
- Evidence 패널: 세션 트리 + tool-call 아코디언(progressive disclosure) + 토큰/cost.
- Hermes 미설치/미초기화 시 셋업 체크리스트 상태. 5초 라이브 폴링.
- 순수 로직은 `lib/hermesBoard.ts`로 분리(단위테스트).

### 핵심 데이터 결합 (실측으로 확정한 비자명 사실)
- 워커 실행 세션은 **메인 state.db가 아니라 per-profile `~/.hermes/profiles/<assignee>/state.db`**.
- `tasks.session_id`는 워커가 아니라 *카드 생성자* 세션(보통 NULL). `task_runs`엔 세션 id 컬럼 없음.
- task→워커세션 매핑: dispatcher가 워커를 `"work kanban task <id>"`로 시드하므로 **task id가 세션 프롬프트/메시지에 박힘** → 그걸로 root 세션을 찾는다.

### 검증
- 결정적 gate 실측: 설계=ready, 코딩=todo(부모 done 전 차단), task_links 엣지. dispatcher가 assignee 프로필로 워커 자동 실행.
- `cargo check`/`cargo test`(5) / `tsc` / `npm test`(15) / `npm run build`(vite prod) 전부 통과.
- 미완(모델 능력): 로컬 MLX 7B 워커는 kanban 워커 프로토콜(`kanban_complete`) 미준수로 crash — Opus/Sonnet 키 연결 시 정상 예상.

### slice 2 (2026-06-23): worktree diff 리뷰 + ACP 인터랙티브 채팅

- **diff 리뷰**: `get_hermes_task_diff(task_id)` — 작업 `workspace_path`에서 `git.rs`(changed_files/file_diff) 재사용한 read-only unified diff. Evidence 패널 "Changes"에 파일별 아코디언(hunk 강조, +/- 카운트). per-hunk accept/reject 쓰기는 Helm Git 승인 플로우와 겹쳐 후속.
- **ACP 채팅**(`hermes_acp.rs`): Helm이 ACP 클라이언트로 `hermes acp`를 spawn(NDJSON JSON-RPC, std process+thread, tokio 없음). 커맨드 `acp_session_new`/`acp_session_prompt`/`acp_session_cancel`/`acp_permission_respond`/`acp_session_close`. 스트리밍은 Tauri 이벤트 `acp://update`/`turn`/`permission`/`notify`/`closed`. 프론트 `HermesChat.tsx`(Hermes 탭 Pipeline/Chat 토글) = 스트리밍 메시지/tool 렌더 + 권한 inline 승인 + cancel. 세션 트리(per-profile state.db)는 사후 audit, ACP 채팅은 실시간 대화 — 둘 다 같은 Hermes 백엔드.
- 검증: cargo check/test(5), tsc, npm test(15), npm run build, 풀 cargo build(네이티브 바이너리) 통과. GUI 렌더(브라우저 프리뷰): nav 탭/모드 토글/셋업 상태/채팅 셸 정상, invoke 데이터 흐름은 Tauri 런타임(`npm run tauri dev`)에서 검증.

## 사용자 셋업 가이드 (단계별 모델 차등)

1. `hermes kanban init` — 보드 초기화.
2. 단계별 프로필 생성: `hermes profile create designer` / `hermes profile create coder`.
3. 각 프로필 모델 지정(예: 설계=Opus, 코딩=Sonnet): 해당 프로필에서 `hermes model`(또는 `~/.hermes/profiles/<name>/config.yaml`의 `model.default`/`provider` + API 키 `.env`).
4. 디스패처 실행: `hermes gateway run`(포그라운드) 또는 `hermes gateway start`.
5. Helm `Hermes` 탭에서 단계에 프로필 할당 → 목표 입력 → 파이프라인 실행 → 보드/근거 관찰.

## 리스크 / open question

- **스키마 결합**: Hermes 내부 SQLite 스키마에 의존 → 업그레이드 시 깨질 수 있음. 완화: 쓰기/안정 읽기는 CLI(`hermes kanban`, `hermes sessions list/export`→JSONL, ACP) 우선, 풍부한 읽기만 raw DB, `schema_version` 가드.
- **결정적 gate (해결, 2026-06-23)**: `delegate_task`는 top-level 에이전트 위임을 코드상 무조건 background로 강제하므로(`delegate_tool.py:3144` `_model_background_value`) sync 위임을 프롬프트로 강제할 수 없다. **결론: gate를 delegate_task에 의존하지 말고 Helm이 직접 소유한다.** 권장 (c) Helm이 단계마다 ACP 프롬프트(`-m` 모델 지정)를 보내고 `stopReason` 대기 후 다음 단계로 advance, 또는 (b) kanban `workflow_template_id`/`current_step_key`+step별 `model_override` → `task_runs.status`로 완료 감지. delegate_task의 background fan-out은 관찰만 한다.
- **ACP session/load 자식 attach**: 자식 granular 활동이 update로 replay되는지 미확인 (DB로는 복원 가능 확인됨).
- **kanban write 주입 경로 (해결, 2026-06-23)**: `hermes kanban create`(+`swarm`)로 작성. 단계별 **모델은 `--assignee <profile>`로 라우팅**(`kanban create`에 `--model` 없음 — 모델은 프로필에 바인딩, `hermes profile create`로 단계별 프로필 생성). 결정적 순서는 `--parent`(의존성 DAG)로 게이트, `--skill`/`--goal`/`--workspace`/`--branch`/`--idempotency-key`/`--json` 지원. 관찰은 `task_runs.status` + `hermes kanban watch`/`tail`. (per-card `model_override` 직접 주입이 필요하면 `kanban edit` 경로 추가 확인 — 현재는 프로필 라우팅으로 충분.)
