import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attentionNeeded,
  availableActions,
  cardColumn,
  groupByStatus,
  isGated,
} from "./hermesBoard.ts";
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

test("cardColumn maps task + run status to columns", () => {
  assert.equal(cardColumn(card({ status: "ready" })), "queued");
  assert.equal(cardColumn(card({ status: "todo" })), "queued");
  assert.equal(cardColumn(card({ status: "running" })), "running");
  assert.equal(cardColumn(card({ status: "done" })), "done");
  assert.equal(cardColumn(card({ status: "blocked" })), "blocked");
  // a crashed/failed run pulls the card to Blocked even if task status lags.
  assert.equal(cardColumn(card({ status: "running", runStatus: "crashed" })), "blocked");
  assert.equal(cardColumn(card({ status: "ready", runStatus: "running" })), "running");
});

test("isGated detects dependency-gated todo cards", () => {
  assert.equal(isGated(card({ status: "todo", parents: ["t_0"] })), true);
  assert.equal(isGated(card({ status: "todo", parents: [] })), false);
  assert.equal(isGated(card({ status: "ready", parents: ["t_0"] })), false);
});

test("attentionNeeded flags only blocked cards", () => {
  assert.equal(attentionNeeded(card({ status: "blocked" })), true);
  assert.equal(attentionNeeded(card({ status: "running" })), false);
});

test("groupByStatus partitions cards", () => {
  const groups = groupByStatus([
    card({ id: "a", status: "ready" }),
    card({ id: "b", status: "running" }),
    card({ id: "c", status: "blocked" }),
    card({ id: "d", status: "done" }),
    card({ id: "e", status: "todo", parents: ["a"] }),
  ]);
  assert.equal(groups.queued.length, 2); // ready + gated todo
  assert.equal(groups.running.length, 1);
  assert.equal(groups.blocked.length, 1);
  assert.equal(groups.done.length, 1);
});

test("availableActions offers a human gate per column", () => {
  assert.deepEqual(availableActions(card({ status: "blocked" })), ["unblock", "complete", "archive"]);
  assert.deepEqual(availableActions(card({ status: "todo", parents: ["a"] })), ["promote", "archive"]);
  assert.deepEqual(availableActions(card({ status: "running" })), ["block", "archive"]);
  assert.deepEqual(availableActions(card({ status: "done" })), ["archive"]);
});
