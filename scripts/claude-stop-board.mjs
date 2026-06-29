#!/usr/bin/env node
// Claude Code Stop 훅: Claude 세션이 한 작업을 Helm 보드에 task 1개로 추적한다.
// inbox handoff와 달리 agent를 spawn하지 않는다 — DB에 task row를 직접 upsert할 뿐이다
// (helm-board.mjs와 동일한 무실행 주입 방식 + audit_logs 기록).
//
// 주의: Stop 훅은 "세션 종료"가 아니라 매 응답 턴마다 fire한다. 그래서 INSERT가 아니라
// session_id로 dedup해서 upsert한다 → 세션당 task 1개가 유지되고 턴마다 갱신된다.
// 추적이 실패해도 세션을 막지 않도록 무슨 일이 있어도 exit 0.
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";

main();

function main() {
  try {
    const evt = safeJson(readFileSync(0, "utf8")) ?? {};
    const cwd = evt.cwd || process.cwd();
    const sessionId = evt.session_id || "unknown";
    const transcript = evt.transcript_path || "";

    const dbPath = findHelmDb(cwd);
    if (!dbPath) return; // Helm으로 추적하는 프로젝트가 아님 → 조용히 skip
    const projectId = resolveProjectId(dbPath, dirname(dirname(dbPath)));
    if (!projectId) return;

    upsertSession({ dbPath, projectId, sessionId, transcript, cwd });
  } catch {
    // 추적 실패는 세션에 영향 주지 않는다
  }
  process.exit(0);
}

// cwd부터 상위로 올라가며 .helm/helm.sqlite를 찾는다 (handoff watcher와 동일한 귀속 규칙).
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

// rootDir(=.helm의 부모)를 root_path로 가진 project를 우선, 없으면 단일 project, 그것도 아니면 첫 project.
function resolveProjectId(dbPath, rootDir) {
  const byRoot = first(dbPath, `SELECT id FROM projects WHERE root_path = ${q(rootDir)} LIMIT 1`);
  if (byRoot) return byRoot.id;
  const all = rows(dbPath, "SELECT id FROM projects ORDER BY created_at");
  return all.length ? all[0].id : null;
}

function upsertSession({ dbPath, projectId, sessionId, transcript, cwd }) {
  const marker = `claude-session:${sessionId}`;
  const title = `[claude-session] ${sessionTitle(transcript, cwd)}`.slice(0, 120);
  const description = `${marker}\ncwd: ${cwd}\ntranscript: ${transcript}`;
  const status = "Done";
  const reason = "claude 세션 추적";
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
       ${audit(projectId, existing.id, "task.status_changed", { taskId: existing.id, from: existing.status, to: status, source: "claude-stop-hook", sessionId })}
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
     ${audit(projectId, id, "task.created", { taskId: id, title, status, source: "claude-stop-hook", sessionId })}
     COMMIT;`,
  );
}

// transcript jsonl의 첫 user 메시지 첫 줄을 제목으로. 못 읽으면 cwd 이름으로 fallback.
function sessionTitle(transcript, cwd) {
  try {
    if (transcript && existsSync(transcript)) {
      for (const line of readFileSync(transcript, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const entry = safeJson(line);
        if (entry?.type !== "user") continue;
        const content = entry.message?.content;
        const text =
          typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content.find((p) => p?.type === "text")?.text
              : "";
        const firstLine = (text ?? "").trim().split("\n")[0].trim();
        if (firstLine) return firstLine.slice(0, 80);
      }
    }
  } catch {
    // fallback 아래로
  }
  return `${basename(cwd)} 세션`;
}

function audit(projectId, taskId, eventType, payload) {
  return `INSERT INTO audit_logs (id, project_id, entity_type, entity_id, event_type, payload_json, created_at)
          VALUES (${q(randomUUID())}, ${q(projectId)}, 'Task', ${q(taskId)}, ${q(eventType)}, ${q(JSON.stringify(payload))}, ${q(new Date().toISOString())});`;
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
