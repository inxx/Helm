#!/usr/bin/env node
// Codex(Desktop/CLI) 독립 세션을 Helm 보드 task로 추적하는 폴링 watcher.
// Codex는 Claude Code의 Stop 훅이 닿지 않으므로(별도 프로세스), ~/.codex/sessions/**/*.jsonl을
// 주기적으로 스캔해 세션 메타의 cwd로 Helm 프로젝트를 찾고 [codex-session] task를 session_id로
// upsert한다. agent를 spawn하지 않고 DB에 직접 주입할 뿐이다(claude-stop-board.mjs와 동일 방식).
//
// - 첫 실행은 최근 1시간만 본다(과거 344개 세션을 보드에 backfill하지 않도록). 건너뛴 건 로그로 남김.
// - cursor(마지막 스캔 시각) 이후 mtime 파일만 처리 → 매 틱 전체 스캔 안 함.
// - 중복 인스턴스는 lockfile로 차단(handoff watcher가 7개로 샌 전철 방지).
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const SESSIONS_DIR = join(homedir(), ".codex", "sessions");
const CURSOR_FILE = join(homedir(), ".codex", ".helm-board-cursor");
const LOCK_FILE = join(homedir(), ".codex", ".helm-board-watcher.lock");
const POLL_MS = 15_000;
const FIRST_RUN_LOOKBACK_MS = 60 * 60 * 1000;

acquireLockOrExit();

if (!existsSync(SESSIONS_DIR)) {
  process.stderr.write(`Codex sessions 디렉터리가 없습니다: ${SESSIONS_DIR}\n`);
  process.exit(1);
}

process.stdout.write(`Codex→Helm board watcher 시작. 감시: ${SESSIONS_DIR}\n`);
scanOnce();
setInterval(scanOnce, POLL_MS);

function scanOnce() {
  try {
    const now = Date.now();
    const first = !existsSync(CURSOR_FILE);
    const cursor = first
      ? now - FIRST_RUN_LOOKBACK_MS
      : Number(readFileSync(CURSOR_FILE, "utf8").trim()) || now - FIRST_RUN_LOOKBACK_MS;

    const files = listSessionFiles(cursor);
    if (first) {
      process.stdout.write(
        `첫 실행: 최근 1시간 세션만 추적합니다(이전 세션 backfill 생략). 대상 ${files.length}개.\n`,
      );
    }
    for (const file of files) {
      try {
        trackSession(file);
      } catch (err) {
        process.stderr.write(`세션 처리 실패 ${file}: ${String(err)}\n`);
      }
    }
    writeFileSync(CURSOR_FILE, String(now));
  } catch (err) {
    process.stderr.write(`scan 실패: ${String(err)}\n`);
  }
}

function listSessionFiles(cursorMs) {
  return readdirSync(SESSIONS_DIR, { recursive: true })
    .filter((name) => String(name).endsWith(".jsonl"))
    .map((name) => join(SESSIONS_DIR, String(name)))
    .filter((path) => {
      try {
        return statSync(path).mtimeMs > cursorMs;
      } catch {
        return false;
      }
    });
}

function trackSession(file) {
  const lines = readFileSync(file, "utf8").split("\n");
  const meta = findSessionMeta(lines);
  if (!meta?.session_id || !meta?.cwd) return; // 메타 없으면 추적 불가

  const dbPath = findHelmDb(meta.cwd);
  if (!dbPath) return; // Helm으로 추적하는 프로젝트가 아님
  const projectId = resolveProjectId(dbPath, dirname(dirname(dbPath)));
  if (!projectId) return;

  const title = `[codex-session] ${sessionTitle(lines, meta.cwd)}`.slice(0, 120);
  upsertSession({ dbPath, projectId, sessionId: meta.session_id, title, file, cwd: meta.cwd });
}

function findSessionMeta(lines) {
  for (const line of lines) {
    if (!line.trim()) continue;
    const entry = safeJson(line);
    if (entry?.type === "session_meta" && entry.payload) {
      return { session_id: entry.payload.session_id, cwd: entry.payload.cwd };
    }
  }
  return null;
}

// AGENTS.md/instructions/environment 주입 메시지는 건너뛰고 실제 첫 user 프롬프트 첫 줄을 제목으로.
function sessionTitle(lines, cwd) {
  for (const line of lines) {
    if (!line.trim()) continue;
    const entry = safeJson(line);
    const p = entry?.payload;
    if (p?.type !== "message" || p.role !== "user") continue;
    const text = Array.isArray(p.content)
      ? p.content.find((c) => c?.type === "input_text" || c?.type === "text")?.text ?? ""
      : "";
    const trimmed = text.trim();
    if (!trimmed) continue;
    if (
      trimmed.startsWith("# AGENTS.md") ||
      trimmed.startsWith("<INSTRUCTIONS>") ||
      trimmed.startsWith("<user_instructions>") ||
      trimmed.startsWith("<environment_context>")
    ) {
      continue;
    }
    const firstLine = trimmed.split("\n")[0].trim();
    if (firstLine) return firstLine.slice(0, 80);
  }
  return `${basename(cwd)} codex 세션`;
}

function upsertSession({ dbPath, projectId, sessionId, title, file, cwd }) {
  const marker = `codex-session:${sessionId}`;
  const description = `${marker}\ncwd: ${cwd}\nrollout: ${file}`;
  const status = "Done";
  const reason = "codex 세션 추적";
  const now = new Date().toISOString();
  const existing = first(
    dbPath,
    `SELECT id, status FROM tasks WHERE project_id = ${q(projectId)} AND description LIKE ${q(`%${marker}%`)}`,
  );

  if (existing) {
    execSql(
      dbPath,
      `BEGIN;
       UPDATE tasks SET title = ${q(title)}, status = ${q(status)}, status_reason = ${q(reason)},
         updated_at = ${q(now)}, last_transition_at = ${q(now)}
       WHERE id = ${q(existing.id)} AND project_id = ${q(projectId)};
       ${audit(projectId, existing.id, "task.status_changed", { taskId: existing.id, from: existing.status, to: status, source: "codex-board-watcher", sessionId })}
       COMMIT;`,
    );
    return;
  }

  const id = randomUUID();
  const sortOrder =
    Number(first(dbPath, `SELECT COALESCE(MAX(sort_order), 0) + 1 AS value FROM tasks WHERE project_id = ${q(projectId)}`)?.value ?? 1);
  execSql(
    dbPath,
    `BEGIN;
     INSERT INTO tasks (id, project_id, epic_id, title, description, status, status_reason, sort_order, created_at, updated_at, last_transition_at)
     VALUES (${q(id)}, ${q(projectId)}, NULL, ${q(title)}, ${q(description)}, ${q(status)}, ${q(reason)}, ${sortOrder}, ${q(now)}, ${q(now)}, ${q(now)});
     ${audit(projectId, id, "task.created", { taskId: id, title, status, source: "codex-board-watcher", sessionId })}
     COMMIT;`,
  );
  process.stdout.write(`추적: ${title}\n`);
}

function findHelmDb(startDir) {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, ".helm", "helm.sqlite");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function resolveProjectId(dbPath, rootDir) {
  const byRoot = first(dbPath, `SELECT id FROM projects WHERE root_path = ${q(rootDir)} LIMIT 1`);
  if (byRoot) return byRoot.id;
  const all = rows(dbPath, "SELECT id FROM projects ORDER BY created_at");
  return all.length ? all[0].id : null;
}

function audit(projectId, taskId, eventType, payload) {
  return `INSERT INTO audit_logs (id, project_id, entity_type, entity_id, event_type, payload_json, created_at)
          VALUES (${q(randomUUID())}, ${q(projectId)}, 'Task', ${q(taskId)}, ${q(eventType)}, ${q(JSON.stringify(payload))}, ${q(new Date().toISOString())});`;
}

function acquireLockOrExit() {
  try {
    if (existsSync(LOCK_FILE)) {
      const pid = Number(readFileSync(LOCK_FILE, "utf8").trim());
      if (pid && isAlive(pid)) {
        process.stderr.write(`이미 실행 중입니다 (pid ${pid}). 종료.\n`);
        process.exit(0);
      }
    }
    writeFileSync(LOCK_FILE, String(process.pid));
  } catch {
    // 락 못 잡아도 진행은 하되, 중복 위험은 감수
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function rows(dbPath, sql) {
  const out = sqlite(["-json", dbPath, sql]);
  return out.trim() ? JSON.parse(out) : [];
}
function first(dbPath, sql) {
  return rows(dbPath, sql)[0] ?? null;
}
function execSql(dbPath, sql) {
  sqlite([dbPath, sql]);
}
function sqlite(args) {
  const result = spawnSync("sqlite3", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || "").trim());
  return result.stdout;
}
function q(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}
function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
