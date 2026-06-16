#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const helmRoot = resolve(dirname(scriptPath), "..");
const cliPath = join(helmRoot, "src", "cli.ts");

const DEFAULT_POLL_INTERVAL_MS = 3000;
const SUPPORTED_EXTENSIONS = new Set([".md", ".txt", ".json"]);
const AGENTS = new Set(["codex", "claude", "gemini", "hermes"]);

const APP_SETTINGS_PATH = join(
  homedir(),
  "Library",
  "Application Support",
  "local.inxx.helm",
  "app-settings.json",
);

const args = parseArgs(process.argv.slice(2));
const inboxPath = resolve(args.inbox ?? join(helmRoot, ".helm", "inbox"));
const processingPath = resolve(args.processing ?? join(helmRoot, ".helm", "processing"));
const reportsPath = resolve(args.reports ?? join(helmRoot, ".helm", "outbox", "reports"));
const archivePath = resolve(args.archive ?? join(helmRoot, ".helm", "outbox", "archive"));
const failedPath = resolve(args.failed ?? join(helmRoot, ".helm", "outbox", "failed"));
const pollIntervalMs = args.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

ensureDirectories();

if (args.help) {
  process.stdout.write(formatHelp());
  process.exit(0);
}

if (args.once) {
  const processed = await processNextTask();
  process.exit(processed ? 0 : 2);
}

process.stdout.write(
  [
    "Claude Desktop handoff watcher started.",
    `Inbox: ${inboxPath}`,
    `Reports: ${reportsPath}`,
    `Interval: ${pollIntervalMs}ms`,
    "",
  ].join("\n"),
);

await watchLoop();

function parseArgs(argv) {
  const parsed = {
    once: false,
    dryRun: false,
    help: false,
    inbox: undefined,
    processing: undefined,
    reports: undefined,
    archive: undefined,
    failed: undefined,
    agent: undefined,
    pollIntervalMs: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--once") {
      parsed.once = true;
      continue;
    }

    if (arg === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }

    if (arg === "-h" || arg === "--help") {
      parsed.help = true;
      continue;
    }

    if (arg === "--inbox") {
      parsed.inbox = readOptionValue(argv, index, "--inbox");
      index += 1;
      continue;
    }

    if (arg?.startsWith("--inbox=")) {
      parsed.inbox = arg.slice("--inbox=".length);
      continue;
    }

    if (arg === "--processing") {
      parsed.processing = readOptionValue(argv, index, "--processing");
      index += 1;
      continue;
    }

    if (arg?.startsWith("--processing=")) {
      parsed.processing = arg.slice("--processing=".length);
      continue;
    }

    if (arg === "--reports") {
      parsed.reports = readOptionValue(argv, index, "--reports");
      index += 1;
      continue;
    }

    if (arg?.startsWith("--reports=")) {
      parsed.reports = arg.slice("--reports=".length);
      continue;
    }

    if (arg === "--archive") {
      parsed.archive = readOptionValue(argv, index, "--archive");
      index += 1;
      continue;
    }

    if (arg?.startsWith("--archive=")) {
      parsed.archive = arg.slice("--archive=".length);
      continue;
    }

    if (arg === "--failed") {
      parsed.failed = readOptionValue(argv, index, "--failed");
      index += 1;
      continue;
    }

    if (arg?.startsWith("--failed=")) {
      parsed.failed = arg.slice("--failed=".length);
      continue;
    }

    if (arg === "--agent") {
      parsed.agent = readAgent(readOptionValue(argv, index, "--agent"));
      index += 1;
      continue;
    }

    if (arg?.startsWith("--agent=")) {
      parsed.agent = readAgent(arg.slice("--agent=".length));
      continue;
    }

    if (arg === "--poll-interval") {
      parsed.pollIntervalMs = readPollInterval(readOptionValue(argv, index, "--poll-interval"));
      index += 1;
      continue;
    }

    if (arg?.startsWith("--poll-interval=")) {
      parsed.pollIntervalMs = readPollInterval(arg.slice("--poll-interval=".length));
      continue;
    }

    throw new Error(`알 수 없는 인자입니다: ${arg}`);
  }

  return parsed;
}

function readOptionValue(argv, index, option) {
  const value = argv[index + 1];

  if (!value || value.startsWith("-")) {
    throw new Error(`${option} 값이 필요합니다.`);
  }

  return value;
}

function readAgent(value) {
  if (!AGENTS.has(value)) {
    throw new Error(`지원하지 않는 agent입니다: ${value} (지원: ${[...AGENTS].join(", ")})`);
  }

  return value;
}

function readPollInterval(value) {
  const interval = Number(value);

  if (!Number.isInteger(interval) || interval < 500) {
    throw new Error("--poll-interval 값은 500 이상의 정수여야 합니다.");
  }

  return interval;
}

function ensureDirectories() {
  for (const directory of [inboxPath, processingPath, reportsPath, archivePath, failedPath]) {
    mkdirSync(directory, { recursive: true });
  }
}

// ── SQLite bridge ─────────────────────────────────────────────────────────────

function sqlQuote(value) {
  if (value === null || value === undefined) return "null";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function runSqlite(dbPath, sql) {
  if (!existsSync(dbPath)) return null;
  return spawnSync("sqlite3", [dbPath], { input: sql, encoding: "utf8" });
}

// repoPath의 자체 DB를 우선 사용. 없으면 Helm DB로 fallback.
function resolveProjectDb(repoPath) {
  const resolved = resolve(repoPath);
  const candidates = [
    { dbPath: join(resolved, ".helm", "helm.sqlite"), rootPath: resolved },
    { dbPath: join(helmRoot, ".helm", "helm.sqlite"), rootPath: helmRoot },
  ];

  for (const { dbPath, rootPath } of candidates) {
    if (!existsSync(dbPath)) continue;
    const result = spawnSync(
      "sqlite3",
      ["-separator", "\t", dbPath, `SELECT id FROM projects WHERE root_path = ${sqlQuote(rootPath)} LIMIT 1;`],
      { encoding: "utf8" },
    );
    const line = result.stdout?.trim().split("\n").find(Boolean);
    if (line?.trim()) return { projectId: line.trim(), dbPath };
  }
  return null;
}

function createDbRecords({ agent, projectId, dbPath, taskId, runId, sourcePath, task, artifactDirRel, startedAt }) {
  const now = new Date().toISOString();
  const title = task.title ?? task.id ?? "Handoff task";
  const description = task.prompt ?? "";
  const stdoutLogPath = join(artifactDirRel, "stdout.log");
  const stderrLogPath = join(artifactDirRel, "stderr.log");
  // summary_path, result_path are NOT NULL in schema
  const summaryPath = join(artifactDirRel, "summary.md");
  const resultPath = join(artifactDirRel, "result.json");
  const sourceRefType = extname(sourcePath) === ".md" ? "MarkdownPlan" : "PlainText";

  runSqlite(dbPath, `
BEGIN;
INSERT OR IGNORE INTO tasks
  (id, project_id, epic_id, title, description, status, status_reason, sort_order, created_at, updated_at, last_transition_at)
VALUES
  (${sqlQuote(taskId)}, ${sqlQuote(projectId)}, null, ${sqlQuote(title)}, ${sqlQuote(description)},
   'Coding', null, ${Date.now()}, ${sqlQuote(startedAt)}, ${sqlQuote(now)}, ${sqlQuote(now)});
INSERT OR IGNORE INTO agent_runs
  (id, project_id, task_id, role_id, status, artifact_dir, summary_path, result_path,
   stdout_log_path, stderr_log_path, exit_code, result_status, started_at, finished_at,
   created_at, updated_at, lifecycle_phase, claimed_at, heartbeat_at,
   failure_kind, failure_reason, attempt, repair_request_id, provider)
VALUES
  (${sqlQuote(runId)}, ${sqlQuote(projectId)}, ${sqlQuote(taskId)}, 'coder', 'Running',
   ${sqlQuote(artifactDirRel)}, ${sqlQuote(summaryPath)}, ${sqlQuote(resultPath)},
   ${sqlQuote(stdoutLogPath)}, ${sqlQuote(stderrLogPath)},
   null, null, ${sqlQuote(startedAt)}, null, ${sqlQuote(startedAt)}, ${sqlQuote(now)},
   'claimed', ${sqlQuote(startedAt)}, ${sqlQuote(now)}, null, null, 1, null, ${sqlQuote(agent)});
INSERT OR IGNORE INTO task_external_refs
  (id, project_id, task_id, ref_type, ref_value, ref_title, created_at)
VALUES
  (${sqlQuote(`handoff-ref-${randomUUID().slice(0, 8)}`)}, ${sqlQuote(projectId)}, ${sqlQuote(taskId)},
   ${sqlQuote(sourceRefType)}, ${sqlQuote(sourcePath)}, 'Handoff Plan', ${sqlQuote(startedAt)});
COMMIT;
`);
}

function updateTaskSourceRef({ dbPath, taskId, fromPath, toPath }) {
  runSqlite(dbPath, `
UPDATE task_external_refs
SET ref_value = ${sqlQuote(toPath)}
WHERE task_id = ${sqlQuote(taskId)}
  AND ref_value = ${sqlQuote(fromPath)}
  AND ref_title = 'Handoff Plan';
`);
}

function updateDbRecords({ dbPath, taskId, runId, exitCode, finishedAt }) {
  const now = new Date().toISOString();
  const succeeded = exitCode === 0;
  const runStatus = succeeded ? "Succeeded" : "Failed";
  const taskStatus = succeeded ? "Done" : "Blocked";
  const resultStatus = succeeded ? "pass" : "fail";

  runSqlite(dbPath, `
BEGIN;
UPDATE agent_runs
SET status = ${sqlQuote(runStatus)}, exit_code = ${exitCode}, result_status = ${sqlQuote(resultStatus)},
    finished_at = ${sqlQuote(finishedAt)}, updated_at = ${sqlQuote(now)}, heartbeat_at = ${sqlQuote(finishedAt)},
    lifecycle_phase = 'observed'
WHERE id = ${sqlQuote(runId)};
UPDATE tasks
SET status = ${sqlQuote(taskStatus)}, updated_at = ${sqlQuote(now)}, last_transition_at = ${sqlQuote(now)}
WHERE id = ${sqlQuote(taskId)};
COMMIT;
`);
}

// ── Hermes execution ──────────────────────────────────────────────────────────

function loadAppSettings() {
  try {
    return JSON.parse(readFileSync(APP_SETTINGS_PATH, "utf8"));
  } catch {
    return null;
  }
}

function buildHermesArgs(prompt) {
  const appSettings = loadAppSettings();
  const connection = appSettings?.orchestrator?.connection;

  const base = ["exec", "hermes-local", "/opt/hermes/.venv/bin/hermes"];

  if (connection?.enabled && Array.isArray(connection.commandArgs)) {
    const idx = { provider: -1, model: -1 };
    connection.commandArgs.forEach((arg, i) => {
      if (arg === "--provider") idx.provider = i;
      if (arg === "--model") idx.model = i;
    });
    if (idx.provider !== -1 && connection.commandArgs[idx.provider + 1]) {
      base.push("--provider", connection.commandArgs[idx.provider + 1]);
    }
    if (idx.model !== -1 && connection.commandArgs[idx.model + 1]) {
      base.push("--model", connection.commandArgs[idx.model + 1]);
    }
  }

  base.push("--oneshot", prompt);
  return base;
}

function runHermes(prompt, repoPath) {
  return new Promise((resolveResult) => {
    const child = spawn("docker", buildHermesArgs(prompt), {
      cwd: repoPath,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });

    child.on("error", (error) => {
      resolveResult({ code: 1, stdout, stderr: stderr ? `${stderr}${error.message}` : error.message });
    });

    child.on("close", (code) => {
      resolveResult({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function watchLoop() {
  while (true) {
    await processNextTask();
    await sleep(pollIntervalMs);
  }
}

async function processNextTask() {
  const taskPath = readNextTaskPath();

  if (!taskPath) {
    return false;
  }

  const startedAt = new Date();
  const processingTaskPath = uniquePath(processingPath, basename(taskPath));

  renameSync(taskPath, processingTaskPath);

  // SQLite bridge: 실행 전 task/run 레코드 생성
  const runId = `handoff-${timestamp(startedAt)}-${randomUUID().slice(0, 8)}`;
  const dbTaskId = `task-${runId}`;
  const artifactDirRel = join(".helm", "artifacts", "runs", runId);
  let dbRecord = null;
  mkdirSync(join(helmRoot, artifactDirRel), { recursive: true });

  try {
    const task = readTask(processingTaskPath);
    const reportName = `${timestamp(startedAt)}-${sanitizeFileName(task.id ?? task.title ?? basename(taskPath, extname(taskPath)))}.md`;
    const agent = args.agent ?? task.agent ?? "codex";
    const repoPath = resolve(task.repoPath ?? helmRoot);
    const prompt = buildExecutionPrompt(task);

    process.stdout.write(`Processing: ${basename(taskPath)} -> ${agent} (${repoPath})\n`);

    dbRecord = resolveProjectDb(repoPath);
    if (dbRecord) {
      createDbRecords({
        ...dbRecord,
        agent,
        taskId: dbTaskId,
        runId,
        sourcePath: processingTaskPath,
        task,
        artifactDirRel,
        startedAt: startedAt.toISOString(),
      });
    }

    let result;
    if (agent === "hermes") {
      result = await runHermes(prompt, repoPath);
    } else {
      const runArgs = ["run", "--agent", agent];
      if (args.dryRun) runArgs.push("--dry-run");
      runArgs.push(prompt);
      result = await runHelm(runArgs, repoPath);
    }

    const finishedAt = new Date();

    // stdout/stderr를 artifact 파일로 저장
    if (result.stdout) writeFileSync(join(helmRoot, artifactDirRel, "stdout.log"), result.stdout);
    if (result.stderr) writeFileSync(join(helmRoot, artifactDirRel, "stderr.log"), result.stderr);

    // SQLite bridge: 실행 후 상태 업데이트
    if (dbRecord) {
      updateDbRecords({ dbPath: dbRecord.dbPath, taskId: dbTaskId, runId, exitCode: result.code, finishedAt: finishedAt.toISOString() });
    }

    const report = formatReport({
      task,
      agent,
      repoPath,
      sourcePath: processingTaskPath,
      startedAt,
      finishedAt,
      result,
      runId,
    });
    const reportPath = join(result.code === 0 ? reportsPath : failedPath, reportName);
    const archiveTarget = uniquePath(result.code === 0 ? archivePath : failedPath, basename(processingTaskPath));

    writeFileSync(reportPath, report);
    renameSync(processingTaskPath, archiveTarget);
    if (dbRecord) {
      updateTaskSourceRef({ dbPath: dbRecord.dbPath, taskId: dbTaskId, fromPath: processingTaskPath, toPath: archiveTarget });
    }

    process.stdout.write(`Report: ${reportPath}\nRun: ${runId}\n`);
  } catch (error) {
    const finishedAt = new Date();
    const reportName = `${timestamp(startedAt)}-${sanitizeFileName(basename(taskPath, extname(taskPath)))}.md`;
    const reportPath = join(failedPath, reportName);
    const failedTarget = uniquePath(failedPath, basename(processingTaskPath));

    // SQLite bridge: 예외 발생 시에도 실패 상태로 업데이트
    const fallbackDb = resolveProjectDb(helmRoot);
    if (fallbackDb) {
      updateDbRecords({ dbPath: fallbackDb.dbPath, taskId: dbTaskId, runId, exitCode: 1, finishedAt: finishedAt.toISOString() });
    }

    writeFileSync(
      reportPath,
      formatFailureReport({
        sourcePath: processingTaskPath,
        startedAt,
        finishedAt,
        error,
      }),
    );
    renameSync(processingTaskPath, failedTarget);
    if (dbRecord) {
      updateTaskSourceRef({ dbPath: dbRecord.dbPath, taskId: dbTaskId, fromPath: processingTaskPath, toPath: failedTarget });
    }
    process.stderr.write(`Failed: ${formatError(error)}\nReport: ${reportPath}\n`);
  }

  return true;
}

function readNextTaskPath() {
  return readdirSync(inboxPath)
    .filter((name) => !name.startsWith("."))
    .filter((name) => SUPPORTED_EXTENSIONS.has(extname(name)))
    .sort()
    .map((name) => join(inboxPath, name))
    .find((path) => existsSync(path));
}

function readTask(path) {
  const raw = readFileSync(path, "utf8");

  if (extname(path) === ".json") {
    return normalizeJsonTask(JSON.parse(raw), path);
  }

  return normalizeMarkdownTask(raw, path);
}

function normalizeJsonTask(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} 파일은 JSON object여야 합니다.`);
  }

  return normalizeTask(
    {
      id: value.id,
      title: value.title,
      agent: value.agent,
      repoPath: value.repoPath,
      prompt: value.prompt ?? value.body,
    },
    path,
  );
}

function normalizeMarkdownTask(raw, path) {
  const { metadata, body } = readFrontMatter(raw);

  return normalizeTask(
    {
      id: metadata.id,
      title: metadata.title,
      agent: metadata.agent,
      repoPath: metadata.repoPath,
      prompt: body,
    },
    path,
  );
}

function normalizeTask(task, path) {
  const prompt = readOptionalString(task.prompt)?.trim();

  if (!prompt) {
    throw new Error(`${path} 파일에 실행할 prompt가 없습니다.`);
  }

  return {
    id: readOptionalString(task.id),
    title: readOptionalString(task.title),
    agent: task.agent === undefined ? undefined : readAgent(String(task.agent)),
    repoPath: readOptionalString(task.repoPath),
    prompt,
  };
}

function readOptionalString(value) {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`문자열 값이어야 합니다: ${String(value)}`);
  }

  return value.trim() || undefined;
}

function readFrontMatter(raw) {
  if (!raw.startsWith("---\n")) {
    return { metadata: {}, body: raw.trim() };
  }

  const end = raw.indexOf("\n---\n", 4);

  if (end === -1) {
    return { metadata: {}, body: raw.trim() };
  }

  const metadata = {};
  const header = raw.slice(4, end);
  const body = raw.slice(end + "\n---\n".length).trim();

  for (const line of header.split("\n")) {
    const separator = line.indexOf(":");

    if (separator === -1) {
      continue;
    }

    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();

    if (key) {
      metadata[key] = value;
    }
  }

  return { metadata, body };
}

function buildExecutionPrompt(task) {
  const title = task.title ? `# ${task.title}\n\n` : "";

  return [
    `${title}${task.prompt}`,
    "",
    "---",
    "Helm 실행 규칙:",
    "- 작업 범위를 벗어난 변경은 하지 않는다.",
    "- 구현 후 가능한 검증 명령을 실행한다.",
    "- 완료 시 변경 파일, 검증 결과, 남은 리스크를 한국어로 보고한다.",
  ].join("\n");
}

function runHelm(runArgs, cwd) {
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, [cliPath, ...runArgs], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });

    child.on("error", (error) => {
      resolveResult({ code: 1, stdout, stderr: stderr ? `${stderr}${error.message}` : error.message });
    });

    child.on("close", (code) => {
      resolveResult({ code: code ?? 1, stdout, stderr });
    });
  });
}

function formatReport({ task, agent, repoPath, sourcePath, startedAt, finishedAt, result, runId }) {
  return [
    "# Helm 자동 실행 보고",
    "",
    `- 작업 ID: ${task.id ?? "-"}`,
    `- 제목: ${task.title ?? "-"}`,
    `- Agent: ${agent}`,
    `- Repo: ${repoPath}`,
    `- Source: ${sourcePath}`,
    `- 시작: ${startedAt.toISOString()}`,
    `- 종료: ${finishedAt.toISOString()}`,
    `- Exit: ${result.code}`,
    `- Session: ${extractSessionId(result.stdout) ?? "-"}`,
    `- DB Run ID: ${runId ?? "-"}`,
    "",
    "## Helm 출력",
    "",
    fenced(result.stdout || "(empty)"),
    "",
    "## 오류 출력",
    "",
    fenced(result.stderr || "(empty)"),
    "",
    "## 원본 작업",
    "",
    fenced(task.prompt),
    "",
  ].join("\n");
}

function formatFailureReport({ sourcePath, startedAt, finishedAt, error }) {
  return [
    "# Helm 자동 실행 실패 보고",
    "",
    `- Source: ${sourcePath}`,
    `- 시작: ${startedAt.toISOString()}`,
    `- 종료: ${finishedAt.toISOString()}`,
    "",
    "## 실패 원인",
    "",
    fenced(formatError(error)),
    "",
  ].join("\n");
}

function extractSessionId(stdout) {
  return /^Session: (?<id>\S+)/m.exec(stdout)?.groups?.id ?? null;
}

function fenced(value) {
  return ["```text", value.trimEnd(), "```"].join("\n");
}

function uniquePath(directory, name) {
  const extension = extname(name);
  const base = basename(name, extension);
  let candidate = join(directory, name);
  let suffix = 1;

  while (existsSync(candidate)) {
    candidate = join(directory, `${base}-${suffix}${extension}`);
    suffix += 1;
  }

  return candidate;
}

function timestamp(date) {
  return date.toISOString().replaceAll(/[-:.TZ]/g, "").slice(0, 14);
}

function sanitizeFileName(value) {
  return String(value)
    .trim()
    .replaceAll(/[^A-Za-z0-9가-힣._-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 80) || "task";
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function formatError(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function formatHelp() {
  return `Usage:
  node scripts/claude-desktop-handoff.mjs [options]

Options:
  --once                    inbox 작업 하나만 처리합니다.
  --dry-run                 agent 실행 없이 Helm 세션만 기록합니다.
  --agent <name>            기본 agent를 지정합니다. codex, claude, gemini
  --inbox <path>            작업 파일을 읽을 경로입니다.
  --reports <path>          성공 보고서 경로입니다.
  --poll-interval <ms>      watcher polling 간격입니다. 기본값: ${DEFAULT_POLL_INTERVAL_MS}
  -h, --help                도움말을 출력합니다.
`;
}
