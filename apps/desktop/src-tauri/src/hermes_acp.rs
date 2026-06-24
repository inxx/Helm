// Hermes ACP client: Helm drives `hermes acp` over stdio (newline-delimited JSON-RPC) as
// an interactive session — initialize -> session/new -> session/prompt, streaming
// session/update notifications and session/request_permission to the UI via Tauri events.
// Mirrors the existing PTY pattern (child process + reader thread + emit). Verified
// framing/method shapes against `hermes acp` directly.
use crate::models::{CommandError, CommandResult};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

pub struct AcpSession {
    stdin: Arc<Mutex<ChildStdin>>,
    child: Child,
    next_id: AtomicI64,
}

impl AcpSession {
    fn write(&self, msg: &Value) -> CommandResult<()> {
        let mut stdin = self
            .stdin
            .lock()
            .map_err(|_| CommandError::new("AcpPoisoned", "ACP 세션 상태가 손상되었습니다."))?;
        let line = format!("{}\n", msg);
        stdin
            .write_all(line.as_bytes())
            .and_then(|_| stdin.flush())
            .map_err(|err| CommandError::io("ACP 세션에 쓰지 못했습니다.", err))
    }

    fn next_id(&self) -> i64 {
        self.next_id.fetch_add(1, Ordering::SeqCst)
    }
}

fn home() -> CommandResult<std::path::PathBuf> {
    std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .ok_or_else(|| CommandError::validation("HOME 경로를 찾을 수 없습니다."))
}

fn hermes_bin() -> CommandResult<String> {
    let local = home()?.join(".local/bin/hermes");
    Ok(if local.exists() {
        local.to_string_lossy().to_string()
    } else {
        "hermes".to_string()
    })
}

/// Spawn `hermes acp`, complete the initialize + session/new handshake synchronously, then
/// hand stdout to a streaming reader thread. Returns the ACP session id. `cwd` scopes the
/// agent's workspace. The caller stores the returned `AcpSession` in app state keyed by id.
pub fn start_session(app: &AppHandle, cwd: Option<String>) -> CommandResult<(String, AcpSession)> {
    let bin = hermes_bin()?;
    let mut child = Command::new(&bin)
        .args(["--yolo", "acp", "--accept-hooks"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| CommandError::io("hermes acp 실행 실패", err))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| CommandError::new("AcpNoStdin", "ACP stdin을 열지 못했습니다."))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| CommandError::new("AcpNoStdout", "ACP stdout을 열지 못했습니다."))?;
    let stderr = child.stderr.take();

    let stdin = Arc::new(Mutex::new(stdin));
    let mut reader = BufReader::new(stdout);

    // drain stderr so the pipe buffer never blocks the agent (logs are discarded).
    if let Some(stderr) = stderr {
        std::thread::spawn(move || {
            let mut sink = BufReader::new(stderr);
            let mut buf = String::new();
            while sink.read_line(&mut buf).map(|n| n > 0).unwrap_or(false) {
                buf.clear();
            }
        });
    }

    let write = |id: i64, method: &str, params: Value| -> CommandResult<()> {
        let msg = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        let mut guard = stdin
            .lock()
            .map_err(|_| CommandError::new("AcpPoisoned", "ACP 세션 상태가 손상되었습니다."))?;
        guard
            .write_all(format!("{}\n", msg).as_bytes())
            .and_then(|_| guard.flush())
            .map_err(|err| CommandError::io("ACP 핸드셰이크 쓰기 실패", err))
    };

    // 1) initialize
    write(
        1,
        "initialize",
        json!({
            "protocolVersion": 1,
            "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false }, "terminal": false }
        }),
    )?;
    read_until_response(&mut reader, 1, app, "init")?;

    // 2) session/new
    write(
        2,
        "session/new",
        json!({ "cwd": cwd.unwrap_or_else(|| "/tmp".to_string()), "mcpServers": [] }),
    )?;
    let new_result = read_until_response(&mut reader, 2, app, "init")?;
    let session_id = new_result
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or_else(|| CommandError::new("AcpNoSession", "ACP 세션 id를 받지 못했습니다."))?
        .to_string();

    // 3) stream the rest of stdout to the UI.
    let app_thread = app.clone();
    let sid = session_id.clone();
    std::thread::spawn(move || {
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break, // EOF: agent exited
                Ok(_) => {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    if let Ok(msg) = serde_json::from_str::<Value>(trimmed) {
                        dispatch(&app_thread, &sid, &msg);
                    }
                }
                Err(_) => break,
            }
        }
        let _ = app_thread.emit("acp://closed", json!({ "sessionId": sid }));
    });

    Ok((
        session_id,
        AcpSession {
            stdin,
            child,
            next_id: AtomicI64::new(3),
        },
    ))
}

/// Read lines until the JSON-RPC response with `id` arrives; emit any updates seen meanwhile
/// so nothing is dropped during the handshake. Returns the response `result`.
fn read_until_response<R: BufRead>(
    reader: &mut R,
    id: i64,
    app: &AppHandle,
    session_id: &str,
) -> CommandResult<Value> {
    let mut line = String::new();
    loop {
        line.clear();
        let n = reader
            .read_line(&mut line)
            .map_err(|err| CommandError::io("ACP 응답을 읽지 못했습니다.", err))?;
        if n == 0 {
            return Err(CommandError::new(
                "AcpClosed",
                "ACP 세션이 핸드셰이크 중 종료되었습니다.",
            ));
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(msg) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        if msg.get("id").and_then(Value::as_i64) == Some(id) && msg.get("method").is_none() {
            if let Some(err) = msg.get("error") {
                return Err(CommandError::with_details(
                    "AcpError",
                    "ACP 오류",
                    err.to_string(),
                ));
            }
            return Ok(msg.get("result").cloned().unwrap_or(Value::Null));
        }
        // not our response — surface it so streaming starts immediately.
        dispatch(app, session_id, &msg);
    }
}

/// Route an incoming ACP message to the right Tauri event.
fn dispatch(app: &AppHandle, session_id: &str, msg: &Value) {
    let method = msg.get("method").and_then(Value::as_str);
    match method {
        Some("session/update") => {
            let _ = app.emit(
                "acp://update",
                json!({ "sessionId": session_id, "update": msg.get("params").and_then(|p| p.get("update")) }),
            );
        }
        Some("session/request_permission") => {
            let _ = app.emit(
                "acp://permission",
                json!({
                    "sessionId": session_id,
                    "requestId": msg.get("id"),
                    "params": msg.get("params"),
                }),
            );
        }
        Some(other) => {
            let _ = app.emit(
                "acp://notify",
                json!({ "sessionId": session_id, "method": other, "params": msg.get("params") }),
            );
        }
        None => {
            // a response to a prompt request -> turn finished.
            let _ = app.emit(
                "acp://turn",
                json!({ "sessionId": session_id, "result": msg.get("result"), "error": msg.get("error") }),
            );
        }
    }
}

pub fn prompt(session: &AcpSession, session_id: &str, text: &str) -> CommandResult<()> {
    let id = session.next_id();
    session.write(&json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "session/prompt",
        "params": { "sessionId": session_id, "prompt": [{ "type": "text", "text": text }] }
    }))
}

pub fn cancel(session: &AcpSession, session_id: &str) -> CommandResult<()> {
    // session/cancel is a notification (no id).
    session.write(&json!({
        "jsonrpc": "2.0",
        "method": "session/cancel",
        "params": { "sessionId": session_id }
    }))
}

pub fn respond_permission(
    session: &AcpSession,
    request_id: Value,
    option_id: &str,
) -> CommandResult<()> {
    session.write(&json!({
        "jsonrpc": "2.0",
        "id": request_id,
        "result": { "outcome": { "outcome": "selected", "optionId": option_id } }
    }))
}

pub fn close(mut session: AcpSession) {
    let _ = session.child.kill();
    let _ = session.child.wait();
}
