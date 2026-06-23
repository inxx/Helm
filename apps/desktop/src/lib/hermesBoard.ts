import type { HermesBoardCard, TaskStatus, TaskSummary } from "./types";

// Map a Hermes board card onto the Helm TaskBoard. Kept separate from the screen so it is
// unit-testable. Hermes task status: todo | ready | running | blocked | done | archived;
// task_runs status adds crashed | failed | timed_out.
type HermesColumn = "blocked" | "queued" | "running" | "done";

function cardColumn(card: HermesBoardCard): HermesColumn {
  const status = (card.status || "").toLowerCase();
  const run = (card.runStatus || "").toLowerCase();
  if (status.includes("block") || run === "crashed" || run === "failed" || run === "timed_out") {
    return "blocked";
  }
  if (status === "running" || run === "running") return "running";
  if (status === "done" || status === "completed" || run === "done") return "done";
  return "queued"; // todo (gated) + ready
}

// Adapter: render Hermes board cards through Helm's native TaskBoard by mapping a card to
// a TaskSummary. The board is unified on the Helm UI; Hermes' 4 columns collapse into the
// Helm 10-status set (only these 4 land), so empty Helm-only columns stay empty.
const COLUMN_TO_STATUS: Record<HermesColumn, TaskStatus> = {
  blocked: "Blocked",
  queued: "Ready",
  running: "Coding",
  done: "Done",
};

// Hermes timestamps are epoch seconds (or null); TaskSummary wants ISO. Null → epoch 0.
function hermesTimeToIso(seconds: number | null | undefined): string {
  return new Date((seconds ?? 0) * 1000).toISOString();
}

export function hermesCardToTask(card: HermesBoardCard, projectId: string): TaskSummary {
  const createdAt = hermesTimeToIso(card.createdAt);
  const transitionAt = hermesTimeToIso(card.completedAt ?? card.startedAt ?? card.createdAt);
  return {
    id: card.id,
    projectId,
    epicId: null,
    title: card.title,
    description: card.runSummary ?? "",
    status: COLUMN_TO_STATUS[cardColumn(card)],
    statusReason: card.runOutcome ?? null,
    sortOrder: -card.priority, // higher Hermes priority → earlier in the column
    externalRefs: card.branchName
      ? [
          {
            id: `${card.id}-branch`,
            projectId,
            taskId: card.id,
            refType: "branch",
            refValue: card.branchName,
            refTitle: card.assignee ?? null,
            createdAt,
          },
        ]
      : [],
    createdAt,
    updatedAt: transitionAt,
    lastTransitionAt: transitionAt,
  };
}
