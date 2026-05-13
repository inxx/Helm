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

export function buildAgentCommand(agent: AgentName, prompt: string): AgentCommand {
  if (agent === "codex") {
    return { command: "codex", args: ["exec", prompt] };
  }

  if (agent === "claude") {
    return { command: "claude", args: ["-p", prompt] };
  }

  return { command: "gemini", args: ["-p", prompt] };
}
