import { existsSync } from "node:fs";

export type AgentName = "codex" | "claude" | "gemini";

export type AgentDescriptor = {
  name: AgentName;
  command: string;
  status: "supported";
  purpose: string;
};

export type AgentCommand = {
  command: string;
  args: string[];
};

type AgentEnvironment = Record<string, string | undefined>;

const AGENT_ENV_VARS: Record<AgentName, string> = {
  codex: "HELM_CODEX_BIN",
  claude: "HELM_CLAUDE_BIN",
  gemini: "HELM_GEMINI_BIN",
};

const DEFAULT_COMMANDS: Record<AgentName, string> = {
  codex: "codex",
  claude: "claude",
  gemini: "gemini",
};

const HOMEBREW_CODEX = "/opt/homebrew/bin/codex";

export const AGENTS: AgentDescriptor[] = [
  {
    name: "codex",
    command: "codex",
    status: "supported",
    purpose: "코드 수정, 테스트 실행, repo 작업 자동화",
  },
  {
    name: "claude",
    command: "claude",
    status: "supported",
    purpose: "계획 수립, 코드 분석, 장문 설계",
  },
  {
    name: "gemini",
    command: "gemini",
    status: "supported",
    purpose: "대안 검토, 코드 리뷰, 보조 분석",
  },
];

export function isAgentName(value: string): value is AgentName {
  return AGENTS.some((agent) => agent.name === value);
}

export function buildAgentCommand(
  agent: AgentName,
  prompt: string,
  env: AgentEnvironment = process.env,
): AgentCommand {
  const command = resolveAgentBinary(agent, env);

  if (agent === "codex") {
    return { command, args: ["exec", prompt] };
  }

  if (agent === "claude") {
    return { command, args: ["-p", prompt] };
  }

  return { command, args: ["-p", prompt] };
}

export function resolveAgentBinary(agent: AgentName, env: AgentEnvironment = process.env): string {
  const override = env[AGENT_ENV_VARS[agent]]?.trim();

  if (override) {
    return override;
  }

  if (agent === "codex" && process.platform === "darwin" && existsSync(HOMEBREW_CODEX)) {
    return HOMEBREW_CODEX;
  }

  return DEFAULT_COMMANDS[agent];
}
