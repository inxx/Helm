import type { AgentSessionSummary } from "./types";

export type AgentSessionBoardColumn = "attention" | "active" | "review" | "done" | "idle";

export interface AgentSessionBoardCard {
  id: string;
  projectId: string;
  taskId: string | null;
  title: string;
  providerLabel: string;
  status: string;
  column: AgentSessionBoardColumn;
  lastSignalAt: string | null;
  nextAction: string;
  branch: string | null;
  worktreePath: string | null;
  changedFileCount: number | null;
}

export function toAgentSessionBoardCard(session: AgentSessionSummary): AgentSessionBoardCard {
  return {
    id: session.id,
    projectId: session.projectId,
    taskId: session.taskId,
    title: session.title,
    providerLabel: providerLabel(session),
    status: session.status,
    column: sessionBoardColumn(session),
    lastSignalAt: session.lastSignalAt,
    nextAction: session.nextAction,
    branch: session.branch,
    worktreePath: session.worktreePath,
    changedFileCount: session.changedFileCount,
  };
}

export function groupAgentSessionsForBoard(
  sessions: AgentSessionSummary[],
): Record<AgentSessionBoardColumn, AgentSessionBoardCard[]> {
  const grouped: Record<AgentSessionBoardColumn, AgentSessionBoardCard[]> = {
    attention: [],
    active: [],
    review: [],
    done: [],
    idle: [],
  };
  for (const session of sessions) {
    const card = toAgentSessionBoardCard(session);
    grouped[card.column].push(card);
  }
  return grouped;
}

function sessionBoardColumn(session: AgentSessionSummary): AgentSessionBoardColumn {
  if (session.nextAction === "approval" || session.nextAction === "retry") return "attention";
  if (session.nextAction === "watch" || session.nextAction === "start") return "active";
  if (session.nextAction === "review") return "review";
  if (session.status === "Succeeded" || session.status === "Completed") return "done";
  return "idle";
}

function providerLabel(session: AgentSessionSummary): string {
  const provider = session.provider?.trim();
  const model = session.model?.trim();
  if (provider && model) return `${provider} · ${model}`;
  return provider || model || "provider 미정";
}
