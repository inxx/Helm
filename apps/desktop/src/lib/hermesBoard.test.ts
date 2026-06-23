import assert from "node:assert/strict";
import { test } from "node:test";
import { hermesCardToTask } from "./hermesBoard.ts";
import type { HermesBoardCard } from "./types";

function card(over: Partial<HermesBoardCard>): HermesBoardCard {
  return {
    id: "t_1",
    title: "task",
    status: "ready",
    assignee: "coder",
    priority: 0,
    branchName: null,
    workspacePath: null,
    sessionId: null,
    modelOverride: null,
    createdAt: null,
    startedAt: null,
    completedAt: null,
    parents: [],
    runStatus: null,
    runOutcome: null,
    runSummary: null,
    ...over,
  };
}

test("hermesCardToTask maps Hermes status + run status onto Helm TaskStatus", () => {
  assert.equal(hermesCardToTask(card({ status: "ready" }), "p").status, "Ready");
  assert.equal(hermesCardToTask(card({ status: "todo" }), "p").status, "Ready");
  assert.equal(hermesCardToTask(card({ status: "running" }), "p").status, "Coding");
  assert.equal(hermesCardToTask(card({ status: "done" }), "p").status, "Done");
  assert.equal(hermesCardToTask(card({ status: "blocked" }), "p").status, "Blocked");
  // a crashed/failed run pulls the card to Blocked even if task status lags.
  assert.equal(hermesCardToTask(card({ status: "running", runStatus: "crashed" }), "p").status, "Blocked");
  assert.equal(hermesCardToTask(card({ status: "ready", runStatus: "running" }), "p").status, "Coding");
});

test("hermesCardToTask maps cards onto the Helm TaskBoard model", () => {
  const task = hermesCardToTask(
    card({
      id: "t_9",
      title: "build feature",
      status: "running",
      priority: 5,
      branchName: "feat/x",
      assignee: "coder",
      runOutcome: "in-progress",
      runSummary: "wiring it up",
      createdAt: 1_700_000_000,
      startedAt: 1_700_000_500,
    }),
    "proj-1",
  );
  assert.equal(task.id, "t_9");
  assert.equal(task.projectId, "proj-1");
  assert.equal(task.status, "Coding"); // running → Coding
  assert.equal(task.sortOrder, -5); // higher priority sorts earlier
  assert.equal(task.statusReason, "in-progress");
  assert.equal(task.description, "wiring it up");
  assert.equal(task.externalRefs[0]?.refValue, "feat/x");
  assert.equal(task.lastTransitionAt, new Date(1_700_000_500 * 1000).toISOString());
  // blocked + no branch → Blocked, empty refs
  const blocked = hermesCardToTask(card({ status: "blocked" }), "proj-1");
  assert.equal(blocked.status, "Blocked");
  assert.deepEqual(blocked.externalRefs, []);
});
