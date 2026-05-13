#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { buildAgentCommand, AGENTS, isAgentName, type AgentName } from "./harness/agents.ts";
import { runCommand, runCommandStream, runShellCommand, type CommandResult } from "./core/process.ts";
import {
  captureSnapshot,
  changedPaths,
  findGitRoot,
  formatStatusEntries,
  readStatus,
  readStagedFiles,
  readWorktreeDiff,
  readCommitSubject,
  stageFiles,
  commitStaged,
  pushBranch,
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
  stdout?: Writable;
  stderr?: Writable;
};

type CommitArgs = {
  sessionId?: string;
  message: string;
  dryRun: boolean;
  checkCommand?: string;
};

type CommitCheckSummary = {
  command: string;
  logPath: string | null;
};

type PrArgs = {
  sessionId?: string;
  base: string;
  title?: string;
  draft: boolean;
  dryRun: boolean;
};

type PrPlan = {
  sessionId: string;
  branch: string;
  base: string;
  title: string;
  draft: boolean;
  commitHash: string;
  body: string;
  pushCommand: string[];
  prCommand: string[];
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
  show              단일 세션 요약을 출력합니다.
  diff              세션 또는 현재 repo diff를 출력합니다.
  commit            세션 변경사항만 stage/commit합니다.
  pr                세션 커밋 branch를 push하고 GitHub draft PR을 만듭니다.
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

  if (command === "show") {
    return runShow(argv.slice(1), context);
  }

  if (command === "diff") {
    return runDiff(argv.slice(1), context);
  }

  if (command === "commit") {
    return runCommit(argv.slice(1), context);
  }

  if (command === "pr") {
    return runPr(argv.slice(1), context);
  }

  if (command === "log") {
    return runLog(argv.slice(1), context);
  }

  return {
    code: 1,
    stderr: `알 수 없는 명령입니다: ${command}\n\n${formatHelp()}`,
  };
}

export async function runCliWithContextAsync(
  argv: string[],
  context: CliContext,
): Promise<CliResult> {
  const [command] = argv;

  if (command === "run") {
    return runAgentAsync(argv.slice(1), context);
  }

  return runCliWithContext(argv, context);
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
        stdout: formatCommitSummary(
          session.id,
          files,
          parsed.message,
          null,
          true,
          parsed.checkCommand ? { command: parsed.checkCommand, logPath: null } : undefined,
        ),
      };
    }

    const checkSummary = parsed.checkCommand
      ? runCommitCheck(repoPath, store, session, parsed.checkCommand)
      : undefined;

    if (checkSummary && session.checkExitCode !== 0) {
      saveSession(store, session);

      return {
        code: 1,
        stderr: formatCheckFailure(parsed.checkCommand, session.checkExitCode ?? 1, checkSummary.logPath),
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
      stdout: formatCommitSummary(
        session.id,
        stagedFiles,
        parsed.message,
        commitHash,
        false,
        checkSummary,
      ),
    };
  } catch (error) {
    return { code: 1, stderr: `${formatError(error)}\n` };
  }
}

function runCommitCheck(
  repoPath: string,
  store: ReturnType<typeof getSessionStore>,
  session: NonNullable<ReturnType<typeof resolveSession>>,
  command: string,
): CommitCheckSummary {
  const logPath = sessionArtifactPath(store, session.id, "check.log");
  const result = runShellCommand(command, { cwd: repoPath });

  writeFileSync(logPath, formatCheckLog(command, result));

  session.checkCommand = command;
  session.checkExitCode = result.code;
  session.checkLogPath = logPath;
  session.updatedAt = new Date().toISOString();

  return { command, logPath };
}

function parseCommitArgs(args: string[]): CommitArgs {
  let sessionId: string | undefined;
  let message = "";
  let dryRun = false;
  let checkCommand: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg === "--check") {
      checkCommand = args[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (arg?.startsWith("--check=")) {
      checkCommand = arg.slice("--check=".length);
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

  if (checkCommand !== undefined && !checkCommand.trim()) {
    throw new Error("check 명령이 필요합니다. 예: helm commit --check \"npm run check\" -m \"테스트 실패 수정\"");
  }

  return { sessionId, message: message.trim(), dryRun, checkCommand: checkCommand?.trim() };
}

function formatCommitSummary(
  sessionId: string,
  files: string[],
  message: string,
  commitHash: string | null,
  dryRun: boolean,
  check?: CommitCheckSummary,
): string {
  const rows = [
    dryRun ? "Commit dry-run:" : "Commit created:",
    `Session: ${sessionId}`,
    `Message: ${message}`,
    `Commit: ${commitHash ?? "(dry-run)"}`,
  ];

  if (check) {
    rows.push(`Check: ${check.command}`);
    rows.push(`Check log: ${check.logPath ?? "(dry-run)"}`);
  }

  return [...rows, "", "Files:", ...files.map((file) => `- ${file}`), ""].join("\n");
}

function formatCheckLog(command: string, result: CommandResult): string {
  return [
    `$ ${command}`,
    `Exit: ${result.code}`,
    "",
    "STDOUT:",
    result.stdout || "(empty)",
    "",
    "STDERR:",
    result.stderr || "(empty)",
    "",
  ].join("\n");
}

function formatCheckFailure(command: string, exitCode: number, logPath: string): string {
  return [
    "Check failed:",
    `Command: ${command}`,
    `Exit: ${exitCode}`,
    `Log: ${logPath}`,
    "",
  ].join("\n");
}

function runPr(args: string[], context: CliContext): CliResult {
  try {
    const parsed = parsePrArgs(args);
    const repoPath = findGitRoot(context.cwd);
    const store = getSessionStore(repoPath);
    const session = resolveSession(store, parsed.sessionId);

    if (!session) {
      return { code: 1, stderr: "PR을 만들 세션을 찾지 못했습니다.\n" };
    }

    if (!session.commitHash) {
      return { code: 1, stderr: "커밋된 세션만 PR을 만들 수 있습니다.\n" };
    }

    if (session.checkExitCode !== undefined && session.checkExitCode !== 0) {
      return { code: 1, stderr: "실패한 check가 기록된 세션은 PR을 만들 수 없습니다.\n" };
    }

    const title =
      parsed.title ??
      readCommitSubject(repoPath, session.commitHash) ??
      `Helm session ${session.id}`;
    const plan = buildPrPlan(session, parsed, title);

    if (parsed.dryRun) {
      return { code: 0, stdout: formatPrSummary(plan, null, true) };
    }

    pushBranch(repoPath, plan.branch);

    const pr = runCommand("gh", plan.prCommand.slice(1), { cwd: repoPath });

    if (pr.code !== 0) {
      throw new Error(pr.stderr.trim() || "gh pr create 실행에 실패했습니다.");
    }

    const prUrl = (extractFirstUrl(pr.stdout) ?? pr.stdout.trim()) || "(url 확인 실패)";

    session.prBase = plan.base;
    session.prTitle = plan.title;
    session.prDraft = plan.draft;
    session.prUrl = prUrl;
    session.prCreatedAt = new Date().toISOString();
    session.updatedAt = session.prCreatedAt;
    saveSession(store, session);

    return { code: 0, stdout: formatPrSummary(plan, prUrl, false) };
  } catch (error) {
    return { code: 1, stderr: `${formatError(error)}\n` };
  }
}

function parsePrArgs(args: string[]): PrArgs {
  let sessionId: string | undefined;
  let base = "main";
  let title: string | undefined;
  let draft = true;
  let dryRun = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg === "--draft") {
      draft = true;
      continue;
    }

    if (arg === "--ready") {
      draft = false;
      continue;
    }

    if (arg === "--base") {
      base = readOptionValue(args, index, "--base");
      index += 1;
      continue;
    }

    if (arg?.startsWith("--base=")) {
      base = arg.slice("--base=".length);
      continue;
    }

    if (arg === "--title") {
      title = readOptionValue(args, index, "--title");
      index += 1;
      continue;
    }

    if (arg?.startsWith("--title=")) {
      title = arg.slice("--title=".length);
      continue;
    }

    if (arg?.startsWith("-")) {
      throw new Error(`알 수 없는 pr 인자입니다: ${arg}`);
    }

    if (arg && !sessionId) {
      sessionId = arg;
      continue;
    }

    if (arg) {
      throw new Error(`알 수 없는 pr 인자입니다: ${arg}`);
    }
  }

  if (!base.trim()) {
    throw new Error("base branch가 필요합니다. 예: helm pr --base main");
  }

  if (title !== undefined && !title.trim()) {
    throw new Error("PR title이 필요합니다. 예: helm pr --title \"테스트 실패 수정\"");
  }

  return { sessionId, base: base.trim(), title: title?.trim(), draft, dryRun };
}

function readOptionValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];

  if (!value || value.startsWith("-")) {
    throw new Error(`${option} 값이 필요합니다.`);
  }

  return value;
}

function buildPrPlan(
  session: NonNullable<ReturnType<typeof resolveSession>>,
  parsed: PrArgs,
  title: string,
): PrPlan {
  const body = formatPrBody(session);
  const prCommand = [
    "gh",
    "pr",
    "create",
    "--base",
    parsed.base,
    "--head",
    session.branch,
    "--title",
    title,
    "--body",
    body,
  ];

  if (parsed.draft) {
    prCommand.push("--draft");
  }

  return {
    sessionId: session.id,
    branch: session.branch,
    base: parsed.base,
    title,
    draft: parsed.draft,
    commitHash: session.commitHash ?? "",
    body,
    pushCommand: ["git", "push", "-u", "origin", session.branch],
    prCommand,
  };
}

function formatPrBody(session: NonNullable<ReturnType<typeof resolveSession>>): string {
  const changedFiles =
    session.changedFiles && session.changedFiles.length > 0
      ? session.changedFiles.map((file) => `- ${file}`)
      : ["- 변경 파일 없음"];
  const check =
    session.checkCommand === undefined
      ? "미실행"
      : `${session.checkCommand} (exit ${session.checkExitCode ?? "unknown"})`;

  return [
    "## Helm session",
    "",
    `- Session: \`${session.id}\``,
    `- Agent: ${session.agent ?? "-"}`,
    `- Branch: \`${session.branch}\``,
    `- Commit: \`${session.commitHash ?? "-"}\``,
    `- Exit: ${session.exitCode ?? "-"}`,
    `- Check: ${check}`,
    "",
    "## Prompt",
    "",
    session.prompt ?? "-",
    "",
    "## Artifacts",
    "",
    `- Log: ${session.logPath ?? "-"}`,
    `- Diff: ${session.diffPath ?? "-"}`,
    `- Check log: ${session.checkLogPath ?? "-"}`,
    "",
    "## Changed files",
    "",
    ...changedFiles,
    "",
  ].join("\n");
}

function formatPrSummary(plan: PrPlan, prUrl: string | null, dryRun: boolean): string {
  return [
    dryRun ? "PR dry-run:" : "PR created:",
    `Session: ${plan.sessionId}`,
    `Branch: ${plan.branch}`,
    `Base: ${plan.base}`,
    `Title: ${plan.title}`,
    `Draft: ${plan.draft ? "yes" : "no"}`,
    `Commit: ${plan.commitHash}`,
    `URL: ${prUrl ?? "(dry-run)"}`,
    "",
    "Commands:",
    `$ ${formatCommand(plan.pushCommand)}`,
    `$ ${formatCommand(plan.prCommand.map((part) => (part === plan.body ? "<generated body>" : part)))}`,
    "",
    "Body:",
    plan.body,
  ].join("\n");
}

function formatCommand(command: string[]): string {
  return command.map(formatCommandPart).join(" ");
}

function formatCommandPart(part: string): string {
  if (/^[A-Za-z0-9_./:=@-]+$/.test(part)) {
    return part;
  }

  return JSON.stringify(part);
}

function extractFirstUrl(output: string): string | null {
  return /https?:\/\/\S+/.exec(output)?.[0] ?? null;
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

async function runAgentAsync(args: string[], context: CliContext): Promise<CliResult> {
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
      : await runCommandStream(command.command, command.args, {
          cwd: before.repoPath,
          stdout: context.stdout,
          stderr: context.stderr,
        });
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
      stderr: parsed.dryRun || result.code === 0 || context.stderr ? undefined : result.stderr,
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

function runShow(args: string[], context: CliContext): CliResult {
  try {
    const repoPath = findGitRoot(context.cwd);
    const store = getSessionStore(repoPath);
    const session = resolveSession(store, args[0]);

    if (!session) {
      return { code: 0, stdout: "세션이 없습니다.\n" };
    }

    return { code: 0, stdout: formatSessionSummary(session) };
  } catch (error) {
    return { code: 1, stderr: `${formatError(error)}\n` };
  }
}

function formatSessionSummary(session: NonNullable<ReturnType<typeof resolveSession>>): string {
  const changedFiles =
    session.changedFiles && session.changedFiles.length > 0
      ? session.changedFiles.map((file) => `- ${file}`)
      : ["- 변경 파일 없음"];
  const check =
    session.checkCommand === undefined
      ? "미실행"
      : `${session.checkCommand} (exit ${session.checkExitCode ?? "unknown"})`;

  return [
    `Session: ${session.id}`,
    `Status: ${session.status}`,
    `Agent: ${session.agent ?? "-"}`,
    `Exit: ${session.exitCode ?? "-"}`,
    `Branch: ${session.branch}`,
    `Head: ${session.head ?? "-"}`,
    `Commit: ${session.commitHash ?? "-"}`,
    `Created: ${session.createdAt}`,
    `Updated: ${session.updatedAt}`,
    `Check: ${check}`,
    "",
    "Artifacts:",
    `Log: ${session.logPath ?? "-"}`,
    `Diff: ${session.diffPath ?? "-"}`,
    `Check log: ${session.checkLogPath ?? "-"}`,
    "",
    "Prompt:",
    session.prompt ?? "-",
    "",
    "Changed files:",
    ...changedFiles,
    "",
  ].join("\n");
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
  const result = await runCliWithContextAsync(argv, {
    cwd: process.cwd(),
    stdout: process.stdout,
    stderr: process.stderr,
  });

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }

  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  return result.code;
}

function isDirectRun(moduleUrl: string, argvPath: string | undefined): boolean {
  if (!argvPath) {
    return false;
  }

  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvPath);
  } catch {
    return moduleUrl === `file://${argvPath}`;
  }
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
}
