import type { HermesBoardCard, HermesKanbanAction } from "./types";

// Pure board logic (status → column, attention, available human actions). Kept separate
// from the screen so it is unit-testable. Hermes task status: todo | ready | running |
// blocked | done | archived; task_runs status adds crashed | failed | timed_out.
export type HermesColumn = "blocked" | "queued" | "running" | "done";

export const HERMES_COLUMNS: HermesColumn[] = ["blocked", "queued", "running", "done"];

export const COLUMN_LABELS: Record<HermesColumn, string> = {
  blocked: "Blocked",
  queued: "Queued",
  running: "Running",
  done: "Done",
};

export function cardColumn(card: HermesBoardCard): HermesColumn {
  const status = (card.status || "").toLowerCase();
  const run = (card.runStatus || "").toLowerCase();
  if (status.includes("block") || run === "crashed" || run === "failed" || run === "timed_out") {
    return "blocked";
  }
  if (status === "running" || run === "running") return "running";
  if (status === "done" || status === "completed" || run === "done") return "done";
  return "queued"; // todo (gated) + ready
}

/** A blocked card needs a human decision; pull it to the user's eye. */
export function attentionNeeded(card: HermesBoardCard): boolean {
  return cardColumn(card) === "blocked";
}

/** True when the card is gated behind unfinished dependencies (todo with parents). */
export function isGated(card: HermesBoardCard): boolean {
  return card.status.toLowerCase() === "todo" && card.parents.length > 0;
}

export function groupByStatus(cards: HermesBoardCard[]): Record<HermesColumn, HermesBoardCard[]> {
  const groups: Record<HermesColumn, HermesBoardCard[]> = {
    blocked: [],
    queued: [],
    running: [],
    done: [],
  };
  for (const card of cards) {
    groups[cardColumn(card)].push(card);
  }
  return groups;
}

/** Human gate actions offered per card, by column. */
export function availableActions(card: HermesBoardCard): HermesKanbanAction[] {
  switch (cardColumn(card)) {
    case "blocked":
      return ["unblock", "complete", "archive"];
    case "queued":
      return isGated(card) ? ["promote", "archive"] : ["archive"];
    case "running":
      return ["block", "archive"];
    case "done":
      return ["archive"];
    default:
      return ["archive"];
  }
}

export const ACTION_LABELS: Record<HermesKanbanAction, string> = {
  unblock: "재개",
  promote: "지금 실행",
  complete: "완료 처리",
  block: "중단",
  archive: "보관",
};
