#!/usr/bin/env node

import { findGitRoot, formatStatusEntries, readStatus, readWorktreeDiff } from "./workspace/git.ts";
import { getSessionStore, listSessions } from "./session/store.ts";

const VERSION = "0.1.0";

type CliResult = {
  code: number;
  stdout?: string;
  stderr?: string;
};

type CliContext = {
  cwd: string;
};

type AgentDescriptor = {
  name: string;
  command: string;
  status: "planned";
  purpose: string;
};

const AGENTS: AgentDescriptor[] = [
  {
    name: "codex",
    command: "codex",
    status: "planned",
    purpose: "코드 수정, 테스트 실행, repo 작업 자동화",
  },
  {
    name: "claude",
    command: "claude",
    status: "planned",
    purpose: "계획 수립, 코드 분석, 장문 설계",
  },
  {
    name: "gemini",
    command: "gemini",
    status: "planned",
    purpose: "대안 검토, 코드 리뷰, 보조 분석",
  },
];

function formatHelp(): string {
  return `Helm ${VERSION}

개인용 Oz-like CLI agent hub.

Usage:
  helm <command> [options]

Commands:
  help              도움말을 출력합니다.
  version           버전을 출력합니다.
  agents            지원 예정 agent 목록을 출력합니다.
  status            현재 repo 상태와 최근 세션을 출력합니다.
  diff              현재 repo의 staged/unstaged diff를 출력합니다.

Planned:
  run               agent를 실행하고 세션을 기록합니다.
  commit            세션 변경사항만 안전하게 커밋합니다.
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

  if (command === "status") {
    return runStatus(context);
  }

  if (command === "diff") {
    return runDiff(context);
  }

  return {
    code: 1,
    stderr: `알 수 없는 명령입니다: ${command}\n\n${formatHelp()}`,
  };
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

function runDiff(context: CliContext): CliResult {
  try {
    const diff = readWorktreeDiff(context.cwd);

    if (!diff.trim()) {
      return { code: 0, stdout: "변경사항이 없습니다.\n" };
    }

    return { code: 0, stdout: `${diff}\n` };
  } catch (error) {
    return { code: 1, stderr: `${formatError(error)}\n` };
  }
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
