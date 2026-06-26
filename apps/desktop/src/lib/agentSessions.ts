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

// Each role hand-off (planner → coder → reviewer → tester) is its own agent_runs row sharing one
// taskId, so a single task stacks up as N identical-titled sidebar rows. Collapse to one row per
// task — the first occurrence wins, so callers must pass sessions sorted most-recent-first.
// Sessions without a taskId stay individual.
export function collapseSessionsByTask(sessions: AgentSessionSummary[]): AgentSessionSummary[] {
  const seenTaskIds = new Set<string>();
  const collapsed: AgentSessionSummary[] = [];
  for (const session of sessions) {
    if (session.taskId) {
      if (seenTaskIds.has(session.taskId)) continue;
      seenTaskIds.add(session.taskId);
    }
    collapsed.push(session);
  }
  return collapsed;
}

export interface SessionEpicGroup {
  epicId: string | null;
  epicTitle: string | null;
  sessions: AgentSessionSummary[];
}

// Group sidebar sessions under their epic so one planning conversation (= one epic) shows as a
// single collapsible parent with its task sessions nested, instead of N flat rows. Sessions must
// arrive most-recent-first: a group is placed at its first-seen session, so the order stays by
// recency. Sessions with no epic get a unique key and stay standalone rows.
export function groupSessionsByEpic(
  sessions: AgentSessionSummary[],
  epicIdForTask: (taskId: string) => string | null,
  epicTitleById: (epicId: string) => string | null,
): SessionEpicGroup[] {
  const order: string[] = [];
  const groups = new Map<string, SessionEpicGroup>();
  for (const session of sessions) {
    const epicId = session.taskId ? epicIdForTask(session.taskId) : null;
    const key = epicId ?? `solo:${session.id}`;
    let group = groups.get(key);
    if (!group) {
      group = { epicId, epicTitle: epicId ? epicTitleById(epicId) : null, sessions: [] };
      groups.set(key, group);
      order.push(key);
    }
    group.sessions.push(session);
  }
  return order.map((key) => groups.get(key)!);
}

function providerLabel(session: AgentSessionSummary): string {
  const provider = session.provider?.trim();
  const model = session.model?.trim();
  if (provider && model) return `${provider} · ${model}`;
  return provider || model || "provider 미정";
}
