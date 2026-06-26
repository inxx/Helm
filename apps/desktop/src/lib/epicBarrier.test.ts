import assert from "node:assert/strict";
import test from "node:test";
import { epicBarrierWait } from "./epicBarrier.ts";
import type { TaskStatus, TaskSummary } from "./types";

function task(id: string, status: TaskStatus, sortOrder: number, epicId: string | null = "e1"): TaskSummary {
  return {
    id,
    projectId: "p1",
    epicId,
    title: `task ${id}`,
    description: "",
    status,
    statusReason: null,
    sortOrder,
    externalRefs: [],
    createdAt: "2026-06-26T00:00:00.000Z",
    updatedAt: "2026-06-26T00:00:00.000Z",
    lastTransitionAt: "2026-06-26T00:00:00.000Z",
  };
}

test("anchor at gate waits on a sibling still Coding", () => {
  const anchor = task("a", "PlanVerification", 0);
  const sibling = task("b", "Coding", 1);
  const wait = epicBarrierWait(anchor, [anchor, sibling]);
  assert.ok(wait);
  assert.equal(wait.gateStatus, "PlanVerification");
  assert.deepEqual(wait.blocking.map((t) => t.id), ["b"]);
});

test("no wait once every sibling reached the gate status", () => {
  const anchor = task("a", "PlanVerification", 0);
  const sibling = task("b", "PlanVerification", 1);
  assert.equal(epicBarrierWait(anchor, [anchor, sibling]), null);
});

test("Blocked sibling holds the barrier even though it sorts last", () => {
  const anchor = task("a", "CodeReview", 0);
  const sibling = task("b", "Blocked", 1);
  const wait = epicBarrierWait(anchor, [anchor, sibling]);
  assert.ok(wait);
  assert.deepEqual(wait.blocking.map((t) => t.id), ["b"]);
});

test("non-anchor sibling never shows the wait", () => {
  const anchor = task("a", "PlanVerification", 0);
  const later = task("b", "PlanVerification", 1);
  const behind = task("c", "Coding", 2);
  assert.equal(epicBarrierWait(later, [anchor, later, behind]), null);
});

test("task without an epic is never a barrier", () => {
  const solo = task("a", "PlanVerification", 0, null);
  assert.equal(epicBarrierWait(solo, [solo]), null);
});

test("non-gate status is never a barrier", () => {
  const anchor = task("a", "Coding", 0);
  const sibling = task("b", "Ready", 1);
  assert.equal(epicBarrierWait(anchor, [anchor, sibling]), null);
});
