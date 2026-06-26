import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRunSummary } from "./types";
import { selectVisibleRun } from "./runLiveState.ts";

test("selectVisibleRun prefers an active follow-up run over older inspection state", () => {
  const inspection = run({
    id: "planner-inspection",
    roleId: "planner",
    status: "NeedsInspection",
    updatedAt: "2026-06-22T05:35:00.000Z",
  });
  const coding = run({
    id: "coder-running",
    roleId: "coder",
    status: "Running",
    startedAt: "2026-06-22T05:38:00.000Z",
    latestEventAt: "2026-06-22T05:38:30.000Z",
    updatedAt: "2026-06-22T05:38:30.000Z",
  });

  assert.equal(selectVisibleRun([inspection, coding])?.id, "coder-running");
});

test("selectVisibleRun keeps approval pending ahead of ordinary running work", () => {
  const approval = run({
    id: "approval-pending",
    status: "Running",
    pendingRunApprovalId: "approval-1",
    updatedAt: "2026-06-22T05:35:00.000Z",
  });
  const coding = run({
    id: "coder-running",
    status: "Running",
    latestEventAt: "2026-06-22T05:38:30.000Z",
    updatedAt: "2026-06-22T05:38:30.000Z",
  });

  assert.equal(selectVisibleRun([coding, approval])?.id, "approval-pending");
});

function run(overrides: Partial<AgentRunSummary>): AgentRunSummary {
  return {
    id: "run",
    projectId: "project",
    taskId: "task",
    roleId: "coder",
    status: "Queued",
    artifactDir: ".helm/artifacts/runs/run",
    summaryPath: "summary.md",
    resultPath: "structured-result.json",
    stdoutLogPath: "stdout.log",
    stderrLogPath: "stderr.log",
    repairRequestId: null,
    provider: null,
    connectionId: null,
    model: null,
    exitCode: null,
    resultStatus: null,
    startedAt: null,
    finishedAt: null,
    lifecyclePhase: null,
    claimedAt: null,
    heartbeatAt: null,
    failureKind: null,
    failureReason: null,
    attempt: 1,
    pendingRunApprovalId: null,
    latestEventKind: null,
    latestEventMessage: null,
    latestEventAt: null,
    createdAt: "2026-06-22T05:30:00.000Z",
    updatedAt: "2026-06-22T05:30:00.000Z",
    eventCount: 0,
    ...overrides,
  };
}
