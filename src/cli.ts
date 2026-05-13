#!/usr/bin/env node

const VERSION = "0.1.0";

type CliResult = {
  code: number;
  stdout?: string;
  stderr?: string;
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

Planned:
  run               agent를 실행하고 세션을 기록합니다.
  status            최근 세션 상태를 출력합니다.
  diff              세션 또는 현재 repo diff를 출력합니다.
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

  return {
    code: 1,
    stderr: `알 수 없는 명령입니다: ${command}\n\n${formatHelp()}`,
  };
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
