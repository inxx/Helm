#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const GATES = [
  "planning",
  "claude-plan-review",
  "plan-debate",
  "plan-approved",
  "implementing-sonnet",
  "local-validation",
  "codex-review",
  "claude-review",
  "gemini-review",
  "review-agreed",
  "pr-opened",
  "waiting-user-merge",
];

const STATE_TO_TASK_STATUS = {
  pending: "Planned",
  in_progress: "Coding",
  done: "Done",
  blocked: "Blocked",
};

const [command, ...rest] = process.argv.slice(2);
const options = parseOptions(rest);
const dbPath = resolve(options.db ?? ".helm/helm.sqlite");

if (!command || command === "help" || options.help) usage(0);
if (!existsSync(dbPath)) fail(`DB가 없습니다: ${dbPath}`);

if (command === "init") {
  const projectId = options.projectId ?? onlyProjectId();
  for (const gate of GATES) upsertGate(projectId, gate, "pending", "");
  console.log(`ok init ${GATES.length} gates`);
} else if (command === "set") {
  const [gate, state] = options._;
  if (!gate || !state) usage(1);
  if (!GATES.includes(gate)) fail(`알 수 없는 gate: ${gate}`);
  if (!STATE_TO_TASK_STATUS[state]) fail(`알 수 없는 state: ${state}`);
  const projectId = options.projectId ?? onlyProjectId();
  const task = upsertGate(projectId, gate, state, options.evidence ?? "");
  console.log(`ok ${task.id} ${gate} ${state}`);
} else if (command === "list") {
  const projectId = options.projectId ?? onlyProjectId();
  console.log(
    rows(`SELECT title, status, COALESCE(status_reason, '') AS reason
          FROM tasks
          WHERE project_id = ${q(projectId)} AND title LIKE '[claude-pr-flow] %'
          ORDER BY sort_order, created_at`).map((row) => `${row.status}\t${row.title}\t${row.reason}`).join("\n"),
  );
} else {
  usage(1);
}

function upsertGate(projectId, gate, state, evidence) {
  const title = `[claude-pr-flow] ${gate}`;
  const status = STATE_TO_TASK_STATUS[state];
  const now = new Date().toISOString();
  const reason = evidence ? `${state}: ${evidence}` : state;
  const existing = first(`SELECT id, status FROM tasks WHERE project_id = ${q(projectId)} AND title = ${q(title)}`);

  if (existing) {
    execSql(`
      BEGIN;
      UPDATE tasks
      SET status = ${q(status)}, status_reason = ${q(reason)}, updated_at = ${q(now)}, last_transition_at = ${q(now)}
      WHERE id = ${q(existing.id)} AND project_id = ${q(projectId)};
      ${audit(projectId, existing.id, "task.status_changed", { taskId: existing.id, from: existing.status, to: status, reason, source: "helm-board-cli", gate, state })}
      COMMIT;
    `);
    return { id: existing.id };
  }

  const id = randomUUID();
  const sortOrder = Number(first(`SELECT COALESCE(MAX(sort_order), 0) + 1 AS value FROM tasks WHERE project_id = ${q(projectId)}`)?.value ?? 1);
  execSql(`
    BEGIN;
    INSERT INTO tasks (id, project_id, epic_id, title, description, status, status_reason, sort_order, created_at, updated_at, last_transition_at)
    VALUES (${q(id)}, ${q(projectId)}, NULL, ${q(title)}, ${q("claude-pr-flow gate")}, ${q(status)}, ${q(reason)}, ${sortOrder}, ${q(now)}, ${q(now)}, ${q(now)});
    ${audit(projectId, id, "task.created", { taskId: id, title, status, source: "helm-board-cli", gate, state })}
    COMMIT;
  `);
  return { id };
}

function onlyProjectId() {
  const projects = rows("SELECT id FROM projects ORDER BY created_at");
  if (projects.length !== 1) fail("--project-id가 필요합니다.");
  return projects[0].id;
}

function rows(sql) {
  const out = sqlite(["-json", dbPath, sql]);
  return out.trim() ? JSON.parse(out) : [];
}

function first(sql) {
  return rows(sql)[0] ?? null;
}

function execSql(sql) {
  sqlite([dbPath, sql]);
}

function sqlite(args) {
  const result = spawnSync("sqlite3", args, { encoding: "utf8" });
  if (result.status !== 0) fail((result.stderr || result.stdout).trim());
  return result.stdout;
}

function audit(projectId, taskId, eventType, payload) {
  return `INSERT INTO audit_logs (id, project_id, entity_type, entity_id, event_type, payload_json, created_at)
          VALUES (${q(randomUUID())}, ${q(projectId)}, 'Task', ${q(taskId)}, ${q(eventType)}, ${q(JSON.stringify(payload))}, ${q(new Date().toISOString())});`;
}

function q(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function parseOptions(args) {
  const parsed = { _: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      parsed._.push(arg);
      continue;
    }
    const key = arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const next = args[i + 1];
    parsed[key] = next && !next.startsWith("--") ? (i += 1, next) : true;
  }
  return parsed;
}

function usage(code) {
  console.log(`Usage:
  node scripts/helm-board.mjs init [--db .helm/helm.sqlite] [--project-id id]
  node scripts/helm-board.mjs set <gate> <pending|in_progress|done|blocked> [--evidence text]
  node scripts/helm-board.mjs list`);
  process.exit(code);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
