# Orca-style Terminal Implementation Plan for Helm

## Goal

Helm의 제품 노출 방식은 유지한다. 사용자는 계속 Helm의 `계획`, `태스크`, `깃`, `터미널`, `설정` 탭 안에서 작업한다. 단, `터미널` 탭 안에서 실제로 만지는 terminal pane의 조작감, 복구력, 검색/링크/분할/세션 저장 경험은 Orca 수준으로 끌어올린다.

이 계획은 PoC가 아니다. 완료 기준은 “사용자가 Helm 터미널을 하루 작업에 계속 써도 탭 전환, 앱 재시작, pane 분할, 긴 출력, agent CLI 실행, command 재실행이 안정적으로 동작한다”고 말할 수 있는 상태다.

## Non-goals

- Helm 전체 UI를 Orca처럼 바꾸지 않는다.
- Electron 또는 `node-pty` 코드를 그대로 이식하지 않는다.
- Helm의 host runner, structured-result, approval gate를 터미널 activity로 대체하지 않는다.
- remote/mobile companion은 이번 구현 범위에 넣지 않는다.
- arbitrary shell 실행을 agent runner로 승격하지 않는다. 사용자 터미널은 사용자 조작 도구이고, runner는 Helm contract를 따르는 별도 실행 경로다.

## Source Reference Summary

`stablyai/orca` 확인 결과 terminal stack은 다음 성격을 가진다.

- Electron + `node-pty` 기반 PTY host
- xterm beta 계열 addon 사용: `@xterm/addon-fit`, `addon-search`, `addon-serialize`, `addon-unicode11`, `addon-web-links`, `addon-webgl`, `addon-ligatures`, `@xterm/headless`
- pane lifecycle, layout serialization, terminal search, context menu, command lifecycle, replay guard, OSC 133 command finish detection, mobile/desktop fit reconciliation, hidden output recovery를 별도 모듈로 분리
- terminal tab/split 생성, rename, close, zoom, focus, keyboard shortcut, search, quick command를 IPC/API 계약으로 노출
- agent CLI 상태 감지와 terminal notification을 terminal lifecycle에 연결

Helm은 Tauri/Rust/React 구조라 그대로 가져올 수 없다. 대신 같은 기능 계약을 Helm backend command와 React terminal surface로 재구현한다.

### Review Findings To Preserve

이 문서는 여러 관점에서 다시 검토됐다. 구현 전에 반드시 보존해야 하는 blocker성 발견은 아래와 같다.

- Orca는 xterm `6.1.0-beta` 계열 addon을 쓰지만 Helm은 현재 `@xterm/xterm ^5.5.0`이다. addon 이름만 보고 설치하면 peer/API mismatch가 날 수 있다.
- Orca의 replay guard는 단순 “버퍼 다시 쓰기”가 아니라 xterm이 replay 중 보내는 auto-reply/query response가 실제 shell stdin으로 새어 들어가지 않게 막는 안전장치다. Helm도 serialize restore를 넣으면 이 guard가 필수다.
- Orca는 close confirmation을 단순 running flag가 아니라 child process/foreground process 관찰로 판단한다. Helm의 현재 `running`은 PTY shell 생존 여부에 가까워 사용자 명령 실행 여부와 다르다.
- saved scripts는 단순 localStorage 편의 기능으로 끝내면 보안/복구/프로젝트 이동성 blocker가 된다. DB-backed, project-scoped, secret-filtered, destructive command confirmation이 최소 조건이다.
- Tauri/Rust 구조에서는 Electron IPC와 node-pty lifecycle을 복붙할 수 없다. Rust PTY command가 “renderer serializer 등록/응답/timeout/fallback” 계약을 새로 가져야 한다.
- macOS accessibility/IME/keyboard shortcut은 terminal UX에서 쉽게 깨진다. 한국어 IME composition과 xterm helper textarea focus를 테스트 항목에 포함해야 한다.

## Current Helm Baseline

현재 Helm terminal은 아래를 이미 가진다.

- `apps/desktop/src/screens/TerminalScreen.tsx`의 xterm 기반 pane UI
- Rust backend PTY command:
  - `start_terminal_pty`
  - `list_terminal_ptys`
  - `get_terminal_pty_snapshot`
  - `write_terminal_pty`
  - `resize_terminal_pty`
  - `stop_terminal_pty`
- pane별 cwd, Node runtime 선택, branch switch, directory selector
- 앱 탭 전환 시 terminal component mounted 유지
- backend bounded output history와 snapshot restore
- command history + Tab autocomplete

부족한 점은 Orca와 비교하면 다음이다.

- xterm fit/search/serialize/web-links/unicode/webgl addon 미도입
- terminal buffer restore가 xterm serialize contract가 아니라 backend history replay 중심
- pane split layout이 단순 grid이고 layout persistence가 약함
- command lifecycle 감지가 input tracking/history 수준에 머묾
- context menu와 quick command/saved script UX 없음
- URL/file path click 없음
- foreground process/child process 감지와 close confirmation 없음
- hidden/background terminal output handling과 replay guard가 약함
- search, clear buffer, copy/paste, paste safety, bracketed paste 정책 없음
- terminal과 Task/run 연결 모델이 약함

## Product UX Contract

Helm 방식으로 유지할 것:

- 상위 navigation은 Helm 탭 구조 유지
- 터미널은 `TerminalScreen` 안의 workbench로 남김
- task board/detail은 terminal을 직접 대체하지 않고 필요한 pane으로 deep link만 제공
- run 완료/실패 판정은 structured result와 Helm backend gate가 소유
- terminal activity는 “실행 증거”가 아니라 “사용자 조작/관찰 surface”로 취급

Orca처럼 맞출 것:

- terminal pane 자체는 진짜 IDE terminal처럼 빠르고 안정적으로 동작
- pane split, search, links, saved scripts, context menu, reconnect/restore, close safety 제공
- agent CLI가 터미널 안에서 실행될 때 running/needs-input/completed 느낌을 사용자에게 보여줌
- 긴 출력과 앱 재시작 후에도 사용자가 맥락을 잃지 않음

## Target Architecture

```text
React TerminalScreen
  ├─ TerminalWorkbenchShell  // Helm visual shell, sidebar, toolbar
  ├─ TerminalPaneSurface     // xterm instance + addons + context menu
  ├─ TerminalLayoutStore     // tabs/splits/active pane/cwd/runtime persistence
  ├─ TerminalCommandPalette  // saved scripts, recent commands, run again
  └─ TerminalTaskBridge      // task/run deep link, not status authority

Tauri Commands
  ├─ terminal.spawn / start_terminal_pty
  ├─ terminal.write / write_terminal_pty
  ├─ terminal.resize / resize_terminal_pty
  ├─ terminal.snapshot / get_terminal_pty_snapshot
  ├─ terminal.serialize_state
  ├─ terminal.foreground_process
  ├─ terminal.has_child_processes
  ├─ terminal.kill / stop_terminal_pty
  └─ terminal.saved_scripts CRUD

Rust Terminal Service
  ├─ PtySession registry
  ├─ bounded raw output history
  ├─ structured session metadata
  ├─ process inspection
  ├─ close/restart safety
  └─ project-scoped persistence in .helm/helm.sqlite
```

## Data Model

Add durable DB tables instead of relying only on `localStorage`.

### `terminal_layouts`

- `id TEXT PRIMARY KEY`
- `project_id TEXT NOT NULL`
- `layout_json TEXT NOT NULL`
- `active_terminal_id TEXT`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

`layout_json` stores tabs/splits/order/sizes, not scrollback.

### `terminal_saved_scripts`

- `id TEXT PRIMARY KEY`
- `project_id TEXT NOT NULL`
- `name TEXT NOT NULL`
- `command TEXT NOT NULL`
- `cwd_mode TEXT NOT NULL DEFAULT 'active_pane'`
- `node_bin_path TEXT`
- `tags_json TEXT NOT NULL DEFAULT '[]'`
- `last_used_at TEXT`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

Security rule: reject secret-looking values by default: `password=`, `token=`, `secret=`, `api_key=`, `Authorization=`, `Bearer ...`.

### `terminal_sessions` metadata extension

Current backend stores sessions in memory. Add optional durable metadata:

- terminal id
- project id
- cwd
- node runtime
- title
- last exit code
- last activity at
- created at / updated at
- restore status: `live`, `restored`, `orphaned`, `closed`

Scrollback can stay bounded/in-memory first, then move to compressed persisted chunks only if needed.

## Implementation Phases

### Phase 0: Stopgap Cleanup

Current local work has a small `localStorage` saved-script prototype in `TerminalScreen.tsx`. Before full implementation, either remove it or fold it into Phase 3 behind the final DB-backed API. Do not commit it as the final feature if it bypasses the planned persistence/security contract.

Acceptance:

- working tree has no half-PoC terminal script code unless it is intentionally completed in Phase 3
- plan document is committed separately or with only documentation changes

### Phase 1: Xterm Addon Foundation

Add dependencies:

- `@xterm/addon-fit`
- `@xterm/addon-search`
- `@xterm/addon-serialize`
- `@xterm/addon-unicode11`
- `@xterm/addon-web-links`
- optionally `@xterm/addon-webgl` after perf smoke

Dependency gate:

- Before installation, check addon versions compatible with `@xterm/xterm` currently installed in `apps/desktop/package.json`.
- If compatible `5.x` addons are unavailable or unstable, either upgrade the whole xterm stack in one commit or defer that addon.
- Do not mix Orca's `6.1.0-beta` addon versions with Helm's `5.5.0` without a targeted compatibility proof.

Implementation:

- wrap xterm creation in a `TerminalPaneSurface` helper/hook
- load fit addon per pane
- replace manual `terminalSize()` math with fit addon where possible
- add debounced resize to avoid reflow storms
- add search UI state and keyboard shortcut hooks
- add serialize addon to capture visible buffer before teardown/restart
- add web links addon for URL click

Blockers:

- xterm addon versions must match existing `@xterm/xterm` version
- WebGL addon can fail on older macOS/GPU/webview; must fallback to DOM/canvas renderer
- fit addon may resize incorrectly while hidden; must gate by visibility and run follow-up fit on activation
- serialize addon can replay terminal query sequences that trigger xterm auto-replies; Phase 1 must not persist/replay serialized buffers until replay guard from Phase 6 is available, or it must add a minimal guard in the same phase.
- link addon must not blindly open arbitrary file paths. URL opening is allowed first; file path opening needs repo-root containment and confirmation policy.

Acceptance:

- terminal resizes correctly after app window resize, tab switch, and pane count change
- terminal search opens, finds text, and does not steal normal shell input when closed
- URL printed in terminal is clickable
- build/typecheck pass

### Phase 2: Pane Layout and Session Persistence

Implementation:

- introduce `TerminalLayoutState`
- persist pane order, active pane, split orientation, split ratios, cwd, node runtime
- restore layout on app restart
- keep Helm shell visual style but allow pane split/close/restart from pane header/context menu
- add close confirmation if pane has child process or active foreground command

Backend commands:

- `save_terminal_layout(project_id, layout)`
- `get_terminal_layout(project_id)`
- `terminal_has_child_processes(terminal_id)`
- `terminal_foreground_process(terminal_id)`

Blockers:

- Rust process-tree inspection is OS-specific; macOS first, graceful unknown elsewhere
- active pane resize can race with backend PTY start
- killing a pane must not kill unrelated shell processes
- Current Helm `TerminalSessionState.running` means the shell process is alive, not that a foreground command is active. Close/restart safety must not rely on this flag alone.
- Layout persistence needs generation/version fields. Without a version, future layout shape changes can brick restore for old projects.
- Terminal IDs restored from layout can collide with live backend sessions after restart or project switch. The backend must reject cross-project IDs and the frontend must regenerate IDs when restore conflicts.

Acceptance:

- create 3 panes, change cwd/runtime, restart app, panes restore in same layout
- closing a pane with a running command asks for confirmation
- closing an idle pane does not ask
- hidden tab output remains available when returning to terminal tab

### Phase 3: Saved Scripts and Quick Commands

This is the feature the user liked from Orca-like UX.

Implementation:

- add DB-backed saved script CRUD commands
- terminal sidebar gets `Saved scripts` section inside Helm visual language
- save from current input, save from recent command, edit name/command, delete
- click script to send command to active pane with bracketed paste-safe behavior
- optional scope: project, cwd, task, run
- add command palette entry: `Run saved script`, `Save current command`, `Run last command`

Security:

- reject secret-looking commands by default
- show warning if command is multi-line or includes destructive-looking operations (`rm -rf`, `git reset --hard`, `sudo`)
- for risky scripts, require explicit confirmation at run time
- store scripts in `.helm/helm.sqlite`, not browser `localStorage`, for the final implementation
- never store command output with the saved script record
- future export/sync must treat saved scripts as potentially sensitive and exclude them by default unless explicitly requested

Blockers:

- `window.prompt` is not enough for final UX; use a proper modal/editor
- saved scripts can become an accidental secret store; filtering and warning are required
- multi-line scripts need bracketed paste or temp-file execution decision
- destructive-command detection is heuristic and cannot be the only safety layer. Confirmation must show the exact command and target cwd.
- secrets can be indirect (`export FOO=$(security find-generic-password ...)`). Filtering reduces obvious mistakes but cannot guarantee safety; docs/UI must say saved scripts are local project data.
- command execution should use active pane input first. A separate non-interactive runner path would blur terminal vs Helm runner authority and is out of scope.

Acceptance:

- save `pnpm --dir apps/desktop typecheck`
- restart app and verify saved script remains
- click script and command runs in active pane
- delete script and verify it is gone after restart
- attempt to save `TOKEN=abc command` is rejected

### Phase 4: Terminal Context Menu and Keyboard Model

Implementation:

- context menu on terminal pane:
  - copy
  - paste
  - paste path
  - clear buffer
  - search
  - restart pane
  - close pane
  - save current command
  - run last command
- keyboard shortcuts:
  - new pane
  - close pane
  - next/previous pane
  - search
  - command palette
  - zoom in/out/reset
- preserve normal shell shortcuts and IME behavior

Blockers:

- xterm helper textarea focus makes shortcut handling easy to break
- Korean IME composition must not trigger Enter/shortcut behavior incorrectly
- browser/Tauri context menu integration can conflict with xterm selection
- Global shortcuts must not fire while native dialogs, prompt modals, or composition are active.
- Paste must support bracketed paste where shell enables it; otherwise multi-line paste can accidentally execute partial commands.

Acceptance:

- copy/paste works with selected terminal text
- search shortcut opens terminal search without sending chars to shell
- IME input still works
- Ctrl+C still goes to shell when terminal is focused

### Phase 5: Command Lifecycle and Agent Awareness

Implementation:

- parse OSC 133 if shell emits command lifecycle markers
- fallback to foreground process/child process inspection
- detect known agent CLI states where feasible:
  - Codex
  - Claude Code
  - Gemini/Grok/OpenCode later
- show pane state: `idle`, `running`, `needs input`, `exited`, `failed`, `unknown`
- add unread/attention badge when background pane needs input or exits

Blockers:

- not all shells emit OSC 133 by default
- process inspection may be unreliable for nested shells, tmux, scripts
- CLI output pattern matching can be brittle and should not drive Helm task state
- zsh/bash/fish differ in prompt integration. OSC 133 should be opportunistic, not required for correctness.
- tmux/screen can hide foreground process and terminal title information. In that case state must fall back to `unknown` instead of false idle.
- Agent detection can leak sensitive prompt/output if notifications include details. Notification payload must remain state-only.

Acceptance:

- running `sleep 5` marks pane as running then idle/exited
- Codex/Claude interactive command gets a distinct active/attention marker when detectable
- pane badge persists until user focuses pane
- task board/run status remains unchanged by terminal-only detection

### Phase 6: Scrollback, Replay Guard, and Hidden Output Recovery

Implementation:

- use serialize addon for renderer-owned snapshot before teardown
- keep backend bounded history as authoritative fallback
- add replay guard so terminal auto-replies/query sequences do not leak during restore
- batch output writes to xterm to avoid renderer jank
- mark output truncation explicitly when buffer limit is exceeded

Blockers:

- large output can freeze renderer if replayed synchronously
- serialize addon output may not preserve every xterm mode perfectly
- backend history and renderer serialize can diverge; need sequence numbers
- xterm replay can emit responses to terminal queries. Replay guard must be active before any serialized bytes are written into xterm.
- Renderer-owned serialized buffer can be missing if app crashes. Backend bounded history remains required as fallback.
- Hidden output backlog needs explicit byte/line limit and user-visible truncation marker; silent truncation is unacceptable.
- Binary/control-heavy output can corrupt restore. Snapshot should be treated as best-effort and allowed to fall back to raw history.

Acceptance:

- command producing thousands of lines stays responsive
- switch tabs during output, return, output remains coherent
- restart app after output, recent scrollback restores or shows explicit truncation notice
- no duplicate output after restore

### Phase 7: Terminal to Task/Run Bridge

Implementation:

- Task detail can open/create a terminal pane scoped to task worktree
- terminal pane metadata can store `task_id` and optional `run_id`
- saved scripts can be scoped to project/task/worktree
- running a saved script from Task detail can attach output evidence only when explicitly requested

Blockers:

- terminal output must not be treated as structured result
- user terminal can mutate files outside planned run scope
- audit evidence capture needs clear user intent
- task-scoped terminal cwd must be resolved through the same repo-root/worktree containment rules as existing terminal cwd.
- opening a task terminal must not silently create or switch Git worktrees.
- attached command evidence needs command, cwd, exit code, timestamp, and user confirmation; raw scrollback should not be attached by default.

Acceptance:

- from Task detail, open terminal at task worktree cwd
- pane title indicates task/worktree context
- running tests in terminal does not auto-advance task status
- user can manually attach command evidence if/when that feature exists

## Technical Risk Register

| Risk | Impact | Mitigation |
| --- | --- | --- |
| xterm addon version mismatch | build/runtime failure | pin versions matching current xterm; add smoke test |
| WebGL renderer incompatibility | blank/broken terminal | fallback to default renderer |
| resize loop/reflow jank | app feels frozen | debounce, visibility gating, fit only when dimensions change |
| persisted scrollback too large | DB bloat/perf issue | bounded history, compression later, explicit truncation |
| process inspection unreliable | false close prompts | unknown state fallback, never kill without user action |
| secret leakage through saved scripts | security issue | reject secret-looking values, future encryption/keychain option |
| shortcut conflict with shell/IME | broken terminal input | terminal-focused shortcut policy and IME tests |
| agent status false positives | misleading UX | show as advisory only, never drive task lifecycle |
| remote/mobile scope creep | delayed core | local-only until phases 1-6 are stable |
| addon license/API drift | upgrade churn | pin exact versions and document compatibility test |
| renderer crash during serialize | lost scrollback | backend history fallback and explicit restore warning |
| prompt-based save UX | accidental bad data | proper modal/editor before final saved scripts |
| native dialog focus issues | shortcuts firing in wrong context | modal/composition/terminal focus guards |
| terminal file links | unsafe file open | URL-only first, file links with root containment later |

## Testing Strategy

Automated:

- TypeScript typecheck
- Rust tests for new DB tables and commands
- unit tests for secret filtering, saved script normalization, layout serialization
- terminal size calculation/fit helper tests where possible
- backend process inspection tests with short-lived child process where stable
- compatibility test that imports every chosen xterm addon with the installed `@xterm/xterm` version
- replay guard test with query-like escape sequences to ensure no bytes are written to PTY during restore
- IME/composition regression test where feasible at component level
- migration test for `terminal_layouts` and `terminal_saved_scripts`

Manual/direct use:

1. Open Helm release app.
2. Go to Terminal tab.
3. Create panes, split, switch active pane.
4. Run `seq 1 2000` and verify output stays responsive.
5. Search for `1999`.
6. Print a URL and click it.
7. Save `pnpm --dir apps/desktop typecheck` as a script.
8. Restart app and run saved script.
9. Start `sleep 30`, try closing pane, verify confirmation.
10. Switch away from Terminal during output and return.
11. Restart app and verify layout/scrollback restore.
12. Open Task detail and create task-scoped terminal.
13. Try saving a destructive script and verify run-time confirmation shows exact command/cwd.
14. Try saving a secret-looking script and verify it is rejected.
15. Type Korean text in the terminal and verify shortcuts do not fire during composition.

## Definition of Done

This goal is complete only when all below are true.

- Terminal pane supports fit/search/serialize/web-links/unicode and remains stable after app restart.
- Pane layout and selected pane restore across restart.
- Saved scripts are DB-backed, project-scoped, restart-safe, editable, deletable, and secret-filtered.
- Running saved scripts sends commands to the active pane without breaking shell input.
- Close/restart flows detect active child processes or show safe fallback.
- Long output does not freeze the app and restore never duplicates output.
- Agent CLI awareness is advisory and never mutates Helm task/run state.
- Task/run terminal bridge opens the right cwd without bypassing Helm runner contract.
- Build/typecheck/test pass.
- At least one release app direct-use smoke run proves the feature end-to-end.

## Suggested First Implementation Task

Start with `Phase 1 + minimal Phase 3 design skeleton`.

Why:

- Fit/search/serialize/web-links are the terminal parity foundation.
- Saved scripts are the user-visible feature that motivated this plan.
- If saved scripts are implemented before terminal surface stability, they may feel bolted on.

First task scope:

- Add xterm fit/search/serialize/web-links/unicode addons.
- Create `TerminalPaneSurface` helper inside frontend.
- Add DB model/commands for saved scripts but expose only list/save/run/delete MVP.
- Do not implement WebGL, process inspection, task bridge, or remote/mobile in first task.
- If addon compatibility is uncertain, split the first task into `Addon compatibility spike` and `Saved scripts DB MVP`; do not combine risky dependency upgrades with DB migrations unless both are verified.

First task acceptance:

- Existing terminal still starts and restores.
- Search works.
- URL click works.
- Save/run/delete one script works after app restart.
- Secret-like script is rejected.
- Destructive-looking script requires confirmation before sending to pane.
- `pnpm --dir apps/desktop typecheck`, `cargo test`, `pnpm --dir apps/desktop build`, `tauri build -b app` pass.
