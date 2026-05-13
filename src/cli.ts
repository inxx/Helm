#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { buildAgentCommand, AGENTS, isAgentName, type AgentName } from "./harness/agents.ts";
import { runCommand } from "./core/process.ts";
import {
  captureSnapshot,
  changedPaths,
  findGitRoot,
  formatStatusEntries,
  readStatus,
  readStagedFiles,
  readWorktreeDiff,
  stageFiles,
  commitStaged,
} from "./workspace/git.ts";
import {
  createSession,
  createSessionStore,
  getSessionStore,
  listSessions,
  resolveSession,
  saveSession,
  sessionArtifactPath,
} from "./session/store.ts";

const VERSION = "0.1.0";

type CliResult = {
  code: number;
  stdout?: string;
  stderr?: string;
};

type CliContext = {
  cwd: string;
};

function formatHelp(): string {
  return `Helm ${VERSION}

개인용 Oz-like CLI agent hub.

Usage:
  helm <command> [options]

Commands:
  help              도움말을 출력합니다.
  version           버전을 출력합니다.
  agents            지원 agent 목록을 출력합니다.
  run               agent를 실행하고 세션을 기록합니다.
  status            현재 repo 상태와 최근 세션을 출력합니다.
  diff              세션 또는 현재 repo diff를 출력합니다.
  commit            세션 변경사항만 stage/commit합니다.
  log               세션 로그를 출력합니다.

Options:
  -h, --help        도움말을 출력합니다.
  -v, --version     버전을 출력합니다.
`;
}

function formatAgents(): string {
  const rows = AGENTS.map(
    (agent) =>
      `- ${agent.name} (${agent.command}, ${agent.status}): ${agent.purpose}`,
  );

  return ["Agents:", ...rows, ""].join("\n");
}

export function runCli(argv: string[]): CliResult {
  return runCliWithContext(argv, { cwd: process.cwd() });
}

export function runCliWithContext(argv: string[], context: CliContext): CliResult {
  const [command] = argv;

  if (!command || command === "help" || command === "-h" || command === "--help") {
    return { code: 0, stdout: formatHelp() };
  }

  if (command === "version" || command === "-v" || command === "--version") {
    return { code: 0, stdout: `${VERSION}\n` };
  }

  if (command === "agents") {
    return { code: 0, stdout: formatAgents() };
  }

  if (command === "run") {
    return runAgent(argv.slice(1), context);
  }

  if (command === "status") {
    return runStatus(context);
  }

  if (command === "diff") {
    return runDiff(argv.slice(1), context);
  }

  if (command === "commit") {
    return runCommit(argv.slice(1), context);
  }

  if (command === "log") {
    return runLog(argv.slice(1), context);
  }

  return {
    code: 1,
    stderr: `알 수 없는 명령입니다: ${command}\n\n${formatHelp()}`,
  };
}

function runCommit(args: string[], context: CliContext): CliResult {
  try {
    const parsed = parseCommitArgs(args);
    const repoPath = findGitRoot(context.cwd);
    const store = getSessionStore(repoPath);
    const session = resolveSession(store, parsed.sessionId);

    if (!session) {
      return { code: 1, stderr: "커밋할 세션을 찾지 못했습니다.\n" };
    }

    const files = session.changedFiles ?? [];

    if (files.length === 0) {
      return { code: 1, stderr: "세션에 기록된 변경 파일이 없습니다.\n" };
    }

    if (parsed.dryRun) {
      return {
        code: 0,
        stdout: formatCommitSummary(session.id, files, parsed.message, null, true),
      };
    }

    stageFiles(repoPath, files);
    const stagedFiles = readStagedFiles(repoPath);
    const commitHash = commitStaged(repoPath, parsed.message);

    session.status = "committed";
    session.commitHash = commitHash;
    session.updatedAt = new Date().toISOString();
    saveSession(store, session);

    return {
      code: 0,
      stdout: formatCommitSummary(session.id, stagedFiles, parsed.message, commitHash, false),
    };
  } catch (error) {
    return { code: 1, stderr: `${formatError(error)}\n` };
  }
}

function parseCommitArgs(args: string[]): { sessionId?: string; message: string; dryRun: boolean } {
  let sessionId: string | undefined;
  let message = "";
  let dryRun = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg === "-m" || arg === "--message") {
      message = args[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (arg?.startsWith("--message=")) {
      message = arg.slice("--message=".length);
      continue;
    }

    if (arg && !sessionId) {
      sessionId = arg;
      continue;
    }

    if (arg) {
      throw new Error(`알 수 없는 commit 인자입니다: ${arg}`);
    }
  }

  if (!message.trim()) {
    throw new Error("커밋 메시지가 필요합니다. 예: helm commit -m \"테스트 실패 수정\"");
  }

  return { sessionId, message: message.trim(), dryRun };
}

function formatCommitSummary(
  sessionId: string,
  files: string[],
  message: string,
  commitHash: string | null,
  dryRun: boolean,
): string {
  return [
    dryRun ? "Commit dry-run:" : "Commit created:",
    `Session: ${sessionId}`,
    `Message: ${message}`,
    `Commit: ${commitHash ?? "(dry-run)"}`,
    "",
    "Files:",
    ...files.map((file) => `- ${file}`),
    "",
  ].join("\n");
}

function runAgent(args: string[], context: CliContext): CliResult {
  try {
    const parsed = parseRunArgs(args);
    const before = captureSnapshot(context.cwd);
    const store = createSessionStore(before.repoPath);
    const session = createSession(store, before);
    const command = buildAgentCommand(parsed.agent, parsed.prompt);
    const logPath = sessionArtifactPath(store, session.id, "log");
    const diffPath = sessionArtifactPath(store, session.id, "diff");

    session.status = "running";
    session.agent = parsed.agent;
    session.prompt = parsed.prompt;
    session.command = [command.command, ...command.args];
    session.logPath = logPath;
    session.diffPath = diffPath;
    session.updatedAt = new Date().toISOString();
    saveSession(store, session);

    const result = parsed.dryRun
      ? { code: 0, stdout: "dry-run: agent 실행을 건너뜁니다.\n", stderr: "" }
      : runCommand(command.command, command.args, { cwd: before.repoPath });
    const after = captureSnapshot(before.repoPath);
    const diff = readWorktreeDiff(before.repoPath);
    const log = formatRunLog(command, parsed.prompt, result.stdout, result.stderr);

    writeFileSync(logPath, log);

    if (diff.trim()) {
      writeFileSync(diffPath, `${diff}\n`);
    }

    session.status = result.code === 0 ? "completed" : "failed";
    session.exitCode = result.code;
    session.after = after;
    session.changedFiles = changedPaths(after.status);
    session.updatedAt = new Date().toISOString();
    saveSession(store, session);

    return {
      code: result.code,
      stdout: formatRunSummary(session.id, parsed.agent, result.code, logPath, diff.trim() ? diffPath : null, session.changedFiles),
      stderr: result.stderr && result.code !== 0 ? result.stderr : undefined,
    };
  } catch (error) {
    return { code: 1, stderr: `${formatError(error)}\n` };
  }
}

function runStatus(context: CliContext): CliResult {
  try {
    const repoPath = findGitRoot(context.cwd);
    const status = readStatus(repoPath);
    const store = getSessionStore(repoPath);
    const sessions = listSessions(store).slice(0, 5);
    const sessionRows =
      sessions.length === 0
        ? ["최근 세션 없음"]
        : sessions.map(
            (session) =>
              `${session.id} ${session.status} ${session.agent ?? "-"} ${session.branch}`,
          );

    return {
      code: 0,
      stdout: [
        `Repo: ${repoPath}`,
        "",
        "Git status:",
        formatStatusEntries(status),
        "",
        "Recent sessions:",
        ...sessionRows,
        "",
      ].join("\n"),
    };
  } catch (error) {
    return { code: 1, stderr: `${formatError(error)}\n` };
  }
}

function runDiff(args: string[], context: CliContext): CliResult {
  try {
    const sessionId = args[0];

    if (sessionId) {
      const repoPath = findGitRoot(context.cwd);
      const store = getSessionStore(repoPath);
      const session = resolveSession(store, sessionId);

      if (!session?.diffPath || !existsSync(session.diffPath)) {
        return { code: 0, stdout: "세션 diff가 없습니다.\n" };
      }

      return { code: 0, stdout: readFileSync(session.diffPath, "utf8") };
    }

    const diff = readWorktreeDiff(context.cwd);

    if (!diff.trim()) {
      return { code: 0, stdout: "변경사항이 없습니다.\n" };
    }

    return { code: 0, stdout: `${diff}\n` };
  } catch (error) {
    return { code: 1, stderr: `${formatError(error)}\n` };
  }
}

function runLog(args: string[], context: CliContext): CliResult {
  try {
    const repoPath = findGitRoot(context.cwd);
    const store = getSessionStore(repoPath);
    const session = resolveSession(store, args[0]);

    if (!session) {
      return { code: 0, stdout: "세션이 없습니다.\n" };
    }

    if (!session.logPath || !existsSync(session.logPath)) {
      return { code: 0, stdout: "세션 로그가 없습니다.\n" };
    }

    return { code: 0, stdout: readFileSync(session.logPath, "utf8") };
  } catch (error) {
    return { code: 1, stderr: `${formatError(error)}\n` };
  }
}

function parseRunArgs(args: string[]): { agent: AgentName; prompt: string; dryRun: boolean } {
  let agent: AgentName = "codex";
  let dryRun = false;
  const promptParts: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--agent" || arg === "-a") {
      const value = args[index + 1];

      if (!value || !isAgentName(value)) {
        throw new Error("지원하지 않는 agent입니다. codex, claude, gemini 중 하나를 사용하세요.");
      }

      agent = value;
      index += 1;
      continue;
    }

    if (arg?.startsWith("--agent=")) {
      const value = arg.slice("--agent=".length);

      if (!isAgentName(value)) {
        throw new Error("지원하지 않는 agent입니다. codex, claude, gemini 중 하나를 사용하세요.");
      }

      agent = value;
      continue;
    }

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg) {
      promptParts.push(arg);
    }
  }

  const prompt = promptParts.join(" ").trim();

  if (!prompt) {
    throw new Error("prompt가 필요합니다. 예: helm run --agent codex \"테스트 실패 고쳐줘\"");
  }

  return { agent, prompt, dryRun };
}

function formatRunLog(
  command: { command: string; args: string[] },
  prompt: string,
  stdout: string,
  stderr: string,
): string {
  return [
    `$ ${[command.command, ...command.args].join(" ")}`,
    "",
    "Prompt:",
    prompt,
    "",
    "STDOUT:",
    stdout || "(empty)",
    "",
    "STDERR:",
    stderr || "(empty)",
    "",
  ].join("\n");
}

function formatRunSummary(
  id: string,
  agent: AgentName,
  exitCode: number,
  logPath: string,
  diffPath: string | null,
  changedFiles: string[] = [],
): string {
  const files = changedFiles.length === 0 ? ["변경 파일 없음"] : changedFiles;

  return [
    `Session: ${id}`,
    `Agent: ${agent}`,
    `Exit: ${exitCode}`,
    `Log: ${logPath}`,
    `Diff: ${diffPath ?? "없음"}`,
    "",
    "Changed files:",
    ...files.map((file) => `- ${file}`),
    "",
  ].join("\n");
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export async function main(argv: string[]): Promise<number> {
  const result = runCli(argv);

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }

  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  return result.code;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
}
