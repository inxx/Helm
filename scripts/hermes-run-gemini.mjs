#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const bridgeRoot = resolve(scriptDir, "..");
const projectRoot = resolve(process.env.HELM_PROJECT_ROOT ?? process.cwd());

const prompt = process.argv.slice(2).join(" ").trim();

if (!prompt) {
  console.error('Usage: node scripts/hermes-run-gemini.mjs "prompt"');
  process.exit(1);
}

const startedAt = new Date();
const runId = `hermes-gemini-${startedAt.toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
const artifactDirRel = join(".helm", "artifacts", "runs", runId);
const artifactDir = join(projectRoot, artifactDirRel);
const hermesTimeoutMs = readTimeout("HERMES_TIMEOUT_MS", 45_000);
const geminiTimeoutMs = readTimeout("GEMINI_TIMEOUT_MS", 60_000);
const referencedMarkdown = readListEnv("HELM_CONTEXT_MD");

mkdirSync(artifactDir, { recursive: true });
const gitBefore = gitSnapshot();
writeFileSync(join(artifactDir, "git-before.txt"), gitBefore.statusText);

const hermesPrompt = [
  "Codex Desktop이 Gemini CLI에게 아래 작업을 위임하려고 한다.",
  "너는 실행자가 아니라 관찰자다.",
  "작업 목적을 한 문장으로만 요약해.",
  "",
  prompt,
].join("\n");

const request = {
  runId,
  kind: "codex-hermes-gemini-smoke-test",
  authority: "codex-desktop",
  bridge: "scripts/hermes-run-gemini.mjs",
  projectRoot,
  observer: {
    name: "hermes",
    command: ["docker", "exec", "hermes-local", "/opt/hermes/.venv/bin/hermes", "--oneshot"],
  },
  agent: {
    name: "gemini",
    command: ["gemini", "-p"],
  },
  prompt,
  startedAt: startedAt.toISOString(),
};

writeJson("runner-request.json", request);

const hermes = await runProcess(
  "docker",
  ["exec", "hermes-local", "/opt/hermes/.venv/bin/hermes", "--oneshot", hermesPrompt],
  { cwd: projectRoot, timeoutMs: hermesTimeoutMs },
);
writeFileSync(join(artifactDir, "hermes.stdout.log"), hermes.stdout);
writeFileSync(join(artifactDir, "hermes.stderr.log"), hermes.stderr);

const gemini = await runProcess("gemini", ["-p", prompt], {
  cwd: projectRoot,
  timeoutMs: geminiTimeoutMs,
});
writeFileSync(join(artifactDir, "stdout.log"), gemini.stdout);
writeFileSync(join(artifactDir, "stderr.log"), gemini.stderr);

const gitAfter = gitSnapshot();
const changedFiles = gitChangedFiles();
const diff = gitDiff();
writeFileSync(join(artifactDir, "git-after.txt"), gitAfter.statusText);
writeJson("changed-files.json", changedFiles);
if (diff.trim()) {
  writeFileSync(join(artifactDir, "diff.patch"), `${diff}\n`);
}

const finishedAt = new Date();
const result = {
  ...request,
  finishedAt: finishedAt.toISOString(),
  durationMs: finishedAt.getTime() - startedAt.getTime(),
  hermes: {
    exitCode: hermes.code,
    timedOut: hermes.timedOut,
    stdoutPath: "hermes.stdout.log",
    stderrPath: "hermes.stderr.log",
  },
  gemini: {
    exitCode: gemini.code,
    timedOut: gemini.timedOut,
    stdoutPath: "stdout.log",
    stderrPath: "stderr.log",
  },
  status: hermes.code === 0 && gemini.code === 0 ? "completed" : "failed",
};

writeJson("structured-result.json", result);
writeFileSync(
  join(artifactDir, "summary.md"),
  [
    `# Hermes Gemini Smoke Test`,
    "",
    `- Run: ${runId}`,
    `- Status: ${result.status}`,
    `- Started: ${result.startedAt}`,
    `- Finished: ${result.finishedAt}`,
    `- Hermes exit: ${hermes.code}`,
    `- Gemini exit: ${gemini.code}`,
    "",
    "## Hermes Observation",
    "",
    hermes.stdout.trim() || "(empty)",
    "",
    "## Gemini Output",
    "",
    gemini.stdout.trim() || "(empty)",
    "",
  ].join("\n"),
);

const contextManifest = {
  schemaVersion: 1,
  runId,
  role: "coder",
  authority: request.authority,
  bridge: request.bridge,
  projectRoot,
  promptSummary: prompt.slice(0, 240),
  referencedMarkdown,
  writtenMarkdown: ["summary.md"],
  writtenArtifacts: [
    "runner-request.json",
    "context-manifest.json",
    "structured-result.json",
    "summary.md",
    "hermes.stdout.log",
    "hermes.stderr.log",
    "stdout.log",
    "stderr.log",
    "git-before.txt",
    "git-after.txt",
    "changed-files.json",
    ...(diff.trim() ? ["diff.patch"] : []),
  ],
  git: {
    before: gitBefore,
    after: gitAfter,
    changedFiles,
    diffPath: diff.trim() ? "diff.patch" : null,
  },
  commands: [request.observer.command, request.agent.command],
  startedAt: result.startedAt,
  finishedAt: result.finishedAt,
};
result.contextManifest = contextManifest;
writeJson("context-manifest.json", contextManifest);

const dbAppend = appendHelmObservation(result);

console.log(`Run: ${runId}`);
console.log(`Status: ${result.status}`);
console.log(`Artifacts: ${artifactDir}`);
console.log(`Helm DB: ${dbAppend.status}`);
if (dbAppend.message) {
  console.log(`Helm DB detail: ${dbAppend.message}`);
}
console.log("");
console.log("Hermes:");
console.log(hermes.stdout.trim() || "(empty)");
console.log("");
console.log("Gemini:");
console.log(gemini.stdout.trim() || "(empty)");

process.exit(result.status === "completed" ? 0 : 1);

function writeJson(name, value) {
  writeFileSync(join(artifactDir, name), `${JSON.stringify(value, null, 2)}\n`);
}

function appendHelmObservation(result) {
  const dbPath = join(projectRoot, ".helm", "helm.sqlite");
  const project = querySqliteOne(dbPath, "select id from projects where root_path = ${rootPath};", {
    rootPath: projectRoot,
  });

  if (!project) {
    return { status: "skipped", message: "project row not found" };
  }

  const projectId = project[0];
  const now = new Date().toISOString();
  const taskId = `task-${result.runId}`;
  const runIdForDb = result.runId;
  const taskStatus = result.status === "completed" ? "Done" : "Blocked";
  const runStatus = result.status === "completed" ? "Succeeded" : "Failed";
  const resultStatus = result.status === "completed" ? "pass" : "fail";
  const exitCode = result.status === "completed" ? 0 : 1;
  const summaryPath = join(artifactDirRel, "summary.md");
  const resultPath = join(artifactDirRel, "structured-result.json");
  const stdoutPath = join(artifactDirRel, "stdout.log");
  const stderrPath = join(artifactDirRel, "stderr.log");
  const changedFilesPath = join(artifactDirRel, "changed-files.json");
  const diffPath = result.contextManifest.git.diffPath
    ? join(artifactDirRel, result.contextManifest.git.diffPath)
    : null;
  const title = "Hermes 경유 Gemini smoke test";
  const description = [
    "Codex Desktop이 wrapper를 실행하고, Hermes가 요청을 관찰한 뒤 Gemini CLI가 응답한 테스트입니다.",
    `Project: ${projectRoot}`,
    `Prompt: ${result.prompt}`,
  ].join("\n");

  const events = [
    {
      kind: "status",
      message: "Hermes/Gemini 관찰 run 시작",
      payload: { bridge: result.bridge, authority: result.authority },
    },
    {
      kind: "artifact",
      message: "runner-request.json 기록",
      payload: { path: join(artifactDirRel, "runner-request.json") },
    },
    {
      kind: "artifact",
      message: "context-manifest.json 기록",
      payload: {
        path: join(artifactDirRel, "context-manifest.json"),
        referencedMarkdown: result.contextManifest.referencedMarkdown.length,
        writtenMarkdown: result.contextManifest.writtenMarkdown.length,
        writtenArtifacts: result.contextManifest.writtenArtifacts.length,
      },
    },
    {
      kind: "stdout",
      message: "Hermes 관찰 stdout 기록",
      payload: { path: join(artifactDirRel, "hermes.stdout.log"), exitCode: result.hermes.exitCode },
    },
    {
      kind: "stdout",
      message: "Gemini stdout 기록",
      payload: { path: stdoutPath, exitCode: result.gemini.exitCode },
    },
    {
      kind: "result",
      message: result.status === "completed" ? "Hermes/Gemini run 완료" : "Hermes/Gemini run 실패",
      payload: { status: result.status, resultPath },
    },
  ];

  const eventSql = events
    .map((event, index) => {
      const eventId = `${runIdForDb}-event-${index + 1}`;
      return `insert into run_events (id, project_id, task_id, run_id, seq, kind, message, payload_json, created_at)
values (${sql(eventId)}, ${sql(projectId)}, ${sql(taskId)}, ${sql(runIdForDb)}, ${index + 1}, ${sql(event.kind)}, ${sql(event.message)}, ${sql(JSON.stringify(event.payload))}, ${sql(now)});`;
    })
    .join("\n");

  const sqlText = `
begin;
insert into tasks (id, project_id, epic_id, title, description, status, status_reason, sort_order, created_at, updated_at, last_transition_at)
values (${sql(taskId)}, ${sql(projectId)}, null, ${sql(title)}, ${sql(description)}, ${sql(taskStatus)}, null, ${Date.now()}, ${sql(result.startedAt)}, ${sql(now)}, ${sql(now)});

insert into task_external_refs (id, project_id, task_id, ref_type, ref_value, ref_title, created_at)
values (${sql(`${taskId}-session-ref`)}, ${sql(projectId)}, ${sql(taskId)}, 'PlainText', ${sql("Hermes Gemini smoke tests")}, ${sql("Hermes Gemini smoke tests")}, ${sql(now)});

insert into agent_runs (
  id, project_id, task_id, role_id, status, artifact_dir, summary_path, result_path, stdout_log_path, stderr_log_path,
  exit_code, result_status, started_at, finished_at, created_at, updated_at, lifecycle_phase, claimed_at, heartbeat_at,
  failure_kind, failure_reason, attempt, repair_request_id
)
values (
  ${sql(runIdForDb)}, ${sql(projectId)}, ${sql(taskId)}, 'coder', ${sql(runStatus)}, ${sql(artifactDirRel)}, ${sql(summaryPath)}, ${sql(resultPath)}, ${sql(stdoutPath)}, ${sql(stderrPath)},
  ${exitCode}, ${sql(resultStatus)}, ${sql(result.startedAt)}, ${sql(result.finishedAt)}, ${sql(result.startedAt)}, ${sql(now)}, 'observed', ${sql(result.startedAt)}, ${sql(result.finishedAt)},
  null, null, 1, null
);

${eventSql}

insert into command_evidence (
  id, project_id, task_id, run_id, command_json, cwd, exit_code, timed_out, canceled, stdout_path, stderr_path,
  changed_files_path, diff_path, duration_ms, started_at, finished_at, created_at
)
values (
  ${sql(`${runIdForDb}-gemini-command`)}, ${sql(projectId)}, ${sql(taskId)}, ${sql(runIdForDb)}, ${sql(JSON.stringify(["gemini", "-p", result.prompt]))}, ${sql(projectRoot)},
  ${result.gemini.exitCode}, ${result.gemini.timedOut ? 1 : 0}, 0, ${sql(stdoutPath)}, ${sql(stderrPath)},
  ${sql(changedFilesPath)}, ${diffPath ? sql(diffPath) : "null"}, ${result.durationMs}, ${sql(result.startedAt)}, ${sql(result.finishedAt)}, ${sql(now)}
);
commit;
`;

  const inserted = runSqlite(dbPath, sqlText);

  if (inserted.status !== 0) {
    return { status: "failed", message: inserted.stderr.trim() || inserted.stdout.trim() };
  }

  return { status: "appended", message: `task=${taskId}` };
}

function querySqliteOne(dbPath, statement, values) {
  const sqlText = statement.replace("${rootPath}", sql(values.rootPath));
  const result = spawnSync("sqlite3", ["-separator", "\t", dbPath, sqlText], {
    cwd: bridgeRoot,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    return null;
  }

  const line = result.stdout.trim().split("\n").find(Boolean);
  return line ? line.split("\t") : null;
}

function runSqlite(dbPath, sqlText) {
  return spawnSync("sqlite3", [dbPath], {
    cwd: bridgeRoot,
    input: sqlText,
    encoding: "utf8",
  });
}

function sql(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function readTimeout(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readListEnv(name) {
  return (process.env[name] ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function gitSnapshot() {
  return {
    branch: gitText(["branch", "--show-current"]) || null,
    head: gitText(["rev-parse", "HEAD"]) || null,
    statusText: gitText(["status", "--short"]) || "(clean)",
  };
}

function gitChangedFiles() {
  const output = gitText(["diff", "--name-only"]);
  const statusFiles = gitText(["status", "--short"])
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
  return Array.from(new Set([
    ...output.split("\n").map((line) => line.trim()).filter(Boolean),
    ...statusFiles,
  ]));
}

function gitDiff() {
  return gitText(["diff"]);
}

function gitText(args) {
  const result = spawnSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    return "";
  }

  return result.stdout.trim();
}

function runProcess(command, args, options) {
  return new Promise((resolveProcess) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      stderr += `Timed out after ${options.timeoutMs}ms\n`;
      terminateChild(child, "SIGTERM");

      setTimeout(() => {
        terminateChild(child, "SIGKILL");
        finish(124);
      }, 2_000).unref();
    }, options.timeoutMs);

    const finish = (code) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      resolveProcess({ code, stdout, stderr, timedOut });
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      stderr += `${error.message}\n`;
      finish(127);
    });

    child.on("close", (code) => {
      finish(timedOut ? 124 : code ?? 1);
    });
  });
}

function terminateChild(child, signal) {
  if (!child.pid) {
    return;
  }

  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process may have already exited.
    }
  }
}
