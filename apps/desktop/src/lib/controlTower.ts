import { deriveRunLiveState, type RunLiveStateView } from "./runLiveState.ts";
import type { AgentRunSummary } from "./types";

export type ControlTowerProviderId = "codex" | "claude" | "gemini" | "unclassified";

export interface ControlTowerRunView {
  run: AgentRunSummary;
  live: RunLiveStateView;
  laneId: ControlTowerProviderId;
  signalAt: string | null;
}

export interface ControlTowerLane {
  id: ControlTowerProviderId;
  label: string;
  activeRuns: ControlTowerRunView[];
  recentRuns: ControlTowerRunView[];
  runs: ControlTowerRunView[];
}

export interface ControlTowerState {
  lanes: ControlTowerLane[];
  attentionRuns: ControlTowerRunView[];
  approvalPendingCount: number;
  activeRunCount: number;
  lastSignalAt: string | null;
}

const LANE_DEFINITIONS: Array<{ id: ControlTowerProviderId; label: string }> = [
  { id: "codex", label: "Codex" },
  { id: "claude", label: "Claude" },
  { id: "gemini", label: "Gemini" },
  { id: "unclassified", label: "미분류" },
];

const RECENT_TERMINAL_LIMIT = 5;

export function deriveControlTowerState(runs: AgentRunSummary[], now = Date.now()): ControlTowerState {
  const lanes: ControlTowerLane[] = LANE_DEFINITIONS.map((lane) => ({
    ...lane,
    activeRuns: [],
    recentRuns: [],
    runs: [],
  }));
  const laneById = new Map(lanes.map((lane) => [lane.id, lane]));
  const runViews = runs
    .map((run) => {
      const laneId = providerLaneId(run.provider);
      return {
        run,
        live: deriveRunLiveState(run, now),
        laneId,
        signalAt: runSignalAt(run),
      };
    })
    .sort(compareRunViewsByRecency);

  for (const view of runViews) {
    const lane = laneById.get(view.laneId) ?? laneById.get("unclassified");
    if (!lane) continue;
    lane.runs.push(view);
    if (view.live.terminal) {
      if (lane.recentRuns.length < RECENT_TERMINAL_LIMIT) lane.recentRuns.push(view);
    } else {
      lane.activeRuns.push(view);
    }
  }

  return {
    lanes,
    attentionRuns: runViews.filter((view) => view.live.attention),
    approvalPendingCount: runViews.filter((view) => view.live.state === "approval_pending").length,
    activeRunCount: runViews.filter((view) => isCommandActive(view.live)).length,
    lastSignalAt: latestSignalAt(runViews),
  };
}

export function providerLaneId(provider: string | null | undefined): ControlTowerProviderId {
  const normalized = provider?.trim().toLowerCase();
  if (normalized === "codex" || normalized === "claude" || normalized === "gemini") {
    return normalized;
  }
  return "unclassified";
}

function isCommandActive(live: RunLiveStateView): boolean {
  return (
    live.state === "starting" ||
    live.state === "running" ||
    live.state === "quiet" ||
    live.state === "stalled_candidate" ||
    live.state === "approval_pending"
  );
}

function latestSignalAt(views: ControlTowerRunView[]): string | null {
  return views.reduce<string | null>((latest, view) => {
    if (!view.signalAt) return latest;
    if (!latest) return view.signalAt;
    return Date.parse(view.signalAt) > Date.parse(latest) ? view.signalAt : latest;
  }, null);
}

function compareRunViewsByRecency(left: ControlTowerRunView, right: ControlTowerRunView): number {
  return timestampFor(right.run) - timestampFor(left.run);
}

function timestampFor(run: AgentRunSummary): number {
  const parsed = Date.parse(runSignalAt(run) ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function runSignalAt(run: AgentRunSummary): string | null {
  return (
    run.latestEventAt ??
    run.heartbeatAt ??
    run.finishedAt ??
    run.startedAt ??
    run.claimedAt ??
    run.updatedAt ??
    run.createdAt ??
    null
  );
}
