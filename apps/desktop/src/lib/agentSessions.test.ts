import assert from "node:assert/strict";
import test from "node:test";
import { collapseSessionsByTask, groupAgentSessionsForBoard, toAgentSessionBoardCard } from "./agentSessions.ts";
import type { AgentSessionSummary } from "./types";

test("toAgentSessionBoardCard keeps board cards summary-only", () => {
  const card = toAgentSessionBoardCard(
    session({
      title: "ACP 세션 전환",
      provider: "codex",
      model: "gpt-5",
      nextAction: "watch",
      branch: "feature/acp-session",
      changedFileCount: 3,
    }),
  );

  assert.equal(card.title, "ACP 세션 전환");
  assert.equal(card.providerLabel, "codex · gpt-5");
  assert.equal(card.column, "active");
  assert.equal(card.projectId, "project");
  assert.equal(card.taskId, "task");
  assert.equal(card.branch, "feature/acp-session");
  assert.equal(card.changedFileCount, 3);
});

test("groupAgentSessionsForBoard groups by next action", () => {
  const grouped = groupAgentSessionsForBoard([
    session({ id: "approval", nextAction: "approval" }),
    session({ id: "retry", nextAction: "retry" }),
    session({ id: "watch", nextAction: "watch" }),
    session({ id: "review", nextAction: "review" }),
    session({ id: "done", status: "Succeeded", nextAction: "open" }),
  ]);

  assert.deepEqual(
    grouped.attention.map((card) => card.id),
    ["approval", "retry"],
  );
  assert.deepEqual(
    grouped.active.map((card) => card.id),
    ["watch"],
  );
  assert.deepEqual(
    grouped.review.map((card) => card.id),
    ["review"],
  );
  assert.deepEqual(
    grouped.done.map((card) => card.id),
    ["done"],
  );
});

test("collapseSessionsByTask keeps one row per task, individuals for null taskId", () => {
  const collapsed = collapseSessionsByTask([
    session({ id: "tester-run", taskId: "task-a", roleId: "tester" }),
    session({ id: "coder-run", taskId: "task-a", roleId: "coder" }),
    session({ id: "planner-run", taskId: "task-a", roleId: "planner" }),
    session({ id: "other-task", taskId: "task-b" }),
    session({ id: "loose-1", taskId: null }),
    session({ id: "loose-2", taskId: null }),
  ]);

  assert.deepEqual(
    collapsed.map((item) => item.id),
    ["tester-run", "other-task", "loose-1", "loose-2"],
  );
});

function session(overrides: Partial<AgentSessionSummary>): AgentSessionSummary {
  return {
    id: "session",
    projectId: "project",
    taskId: "task",
    sourceRunId: "run",
    title: "Session",
    status: "Running",
    provider: null,
    connectionId: null,
    model: null,
    roleId: "coder",
    taskStatus: "Coding",
    branch: null,
    worktreePath: null,
    lastSignalAt: "2026-06-18T00:00:00.000Z",
    nextAction: "open",
    changedFileCount: null,
    eventCount: 0,
    createdAt: "2026-06-18T00:00:00.000Z",
    updatedAt: "2026-06-18T00:00:00.000Z",
    ...overrides,
  };
}
