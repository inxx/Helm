import assert from "node:assert/strict";
import test from "node:test";
import { deriveControlTowerState, providerLaneId } from "./controlTower.ts";
import type { AgentRunSummary } from "./types";

const NOW = Date.parse("2026-06-12T12:00:00.000Z");

test("providerLaneId groups known providers and sends missing values to unclassified", () => {
  assert.equal(providerLaneId("codex"), "codex");
  assert.equal(providerLaneId(" Claude "), "claude");
  assert.equal(providerLaneId("gemini"), "gemini");
  assert.equal(providerLaneId(null), "unclassified");
  assert.equal(providerLaneId("fixture"), "unclassified");
});

test("deriveControlTowerState groups runs into provider lanes", () => {
  const runs = [
    run({ id: "claude-active", provider: "claude", status: "Running", latestEventAt: "2026-06-12T11:59:00.000Z" }),
    run({ id: "codex-done", provider: "codex", status: "Succeeded", finishedAt: "2026-06-12T11:58:00.000Z" }),
    run({ id: "unknown-active", provider: null, status: "Running", latestEventAt: "2026-06-12T11:57:00.000Z" }),
    run({ id: "gemini-queued", provider: "gemini", status: "Queued", createdAt: "2026-06-12T11:56:00.000Z" }),
  ];

  const state = deriveControlTowerState(runs, NOW);

  assert.deepEqual(
    state.lanes.map((lane) => lane.id),
    ["codex", "claude", "gemini", "unclassified"],
  );
  assert.deepEqual(state.lanes.find((lane) => lane.id === "claude")?.activeRuns.map((view) => view.run.id), [
    "claude-active",
  ]);
  assert.deepEqual(state.lanes.find((lane) => lane.id === "codex")?.recentRuns.map((view) => view.run.id), [
    "codex-done",
  ]);
  assert.deepEqual(state.lanes.find((lane) => lane.id === "unclassified")?.activeRuns.map((view) => view.run.id), [
    "unknown-active",
  ]);
  assert.equal(state.activeRunCount, 2);
  assert.equal(state.lastSignalAt, "2026-06-12T11:59:00.000Z");
});

test("deriveControlTowerState extracts attention runs through runLiveState", () => {
  const state = deriveControlTowerState(
    [
      run({
        id: "approval",
        provider: "codex",
        status: "Running",
        pendingRunApprovalId: "approval-1",
        latestEventAt: "2026-06-12T11:59:00.000Z",
      }),
      run({
        id: "stalled",
        provider: "claude",
        status: "Running",
        latestEventAt: "2026-06-12T11:30:00.000Z",
      }),
      run({
        id: "failed",
        provider: "gemini",
        status: "Failed",
        failureReason: "runner failed",
        finishedAt: "2026-06-12T11:58:00.000Z",
      }),
      run({
        id: "healthy",
        provider: "codex",
        status: "Running",
        latestEventAt: "2026-06-12T11:59:30.000Z",
      }),
    ],
    NOW,
  );

  assert.deepEqual(
    state.attentionRuns.map((view) => view.run.id),
    ["approval", "failed", "stalled"],
  );
  assert.equal(state.approvalPendingCount, 1);
  assert.equal(state.activeRunCount, 3);
});

test("deriveControlTowerState limits recent terminal runs per lane", () => {
  const state = deriveControlTowerState(
    Array.from({ length: 6 }, (_, index) =>
      run({
        id: `done-${index}`,
        provider: "codex",
        status: "Succeeded",
        finishedAt: `2026-06-12T11:5${index}:00.000Z`,
      }),
    ),
    NOW,
  );

  assert.deepEqual(state.lanes.find((lane) => lane.id === "codex")?.recentRuns.map((view) => view.run.id), [
    "done-5",
    "done-4",
    "done-3",
    "done-2",
    "done-1",
  ]);
});

function run(overrides: Partial<AgentRunSummary>): AgentRunSummary {
  return {
    id: "run",
    projectId: "project",
    taskId: "task",
    roleId: "coder",
    status: "Running",
    provider: "codex",
    connectionId: null,
    model: null,
    artifactDir: ".helm/artifacts/runs/run",
    summaryPath: "summary.md",
    resultPath: "structured-result.json",
    stdoutLogPath: "stdout.log",
    stderrLogPath: "stderr.log",
    repairRequestId: null,
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
    createdAt: "2026-06-12T11:55:00.000Z",
    updatedAt: "2026-06-12T11:55:00.000Z",
    ...overrides,
  };
}
