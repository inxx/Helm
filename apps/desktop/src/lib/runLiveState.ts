import type { AgentRunSummary } from "./types";

const QUIET_AFTER_MS = 5 * 60 * 1000;
const STALLED_AFTER_MS = 20 * 60 * 1000;

export type RunLiveState =
  | "queued"
  | "starting"
  | "running"
  | "approval_pending"
  | "quiet"
  | "stalled_candidate"
  | "done"
  | "failed"
  | "canceled"
  | "timed_out"
  | "orphaned_after_restart"
  | "needs_inspection";

export type RunLiveTone = "running" | "queued" | "attention" | "done";

export interface RunLiveStateView {
  state: RunLiveState;
  label: string;
  summary: string;
  tone: RunLiveTone;
  ageLabel: string;
  attention: boolean;
  terminal: boolean;
}

export function deriveRunLiveState(run: AgentRunSummary, now = Date.now()): RunLiveStateView {
  const anchor = run.latestEventAt ?? run.heartbeatAt ?? run.startedAt ?? run.claimedAt ?? run.updatedAt ?? run.createdAt;
  const ageMs = ageFromNow(anchor, now);
  const ageLabel = formatRelativeAge(anchor, now);

  if (run.status === "Succeeded") {
    return {
      state: "done",
      label: "완료",
      summary: terminalSummary(run, "실행이 완료됐습니다."),
      tone: "done",
      ageLabel,
      attention: false,
      terminal: true,
    };
  }

  if (run.status === "Failed") {
    return terminalAttention(run, "failed", "실패", "실행이 실패했습니다.", ageLabel);
  }

  if (run.status === "Canceled") {
    return terminalAttention(run, "canceled", "취소됨", "실행이 취소됐습니다.", ageLabel);
  }

  if (run.status === "TimedOut") {
    return terminalAttention(run, "timed_out", "시간 초과", "설정된 실행 시간을 초과했습니다.", ageLabel);
  }

  if (run.status === "NeedsInspection") {
    const orphaned = run.lifecyclePhase === "orphaned" || run.failureKind === "orphaned_after_restart";
    return terminalAttention(
      run,
      orphaned ? "orphaned_after_restart" : "needs_inspection",
      orphaned ? "점검 필요 · orphaned" : "점검 필요",
      orphaned ? "앱 재시작 후 실행 프로세스를 확인할 수 없습니다." : "결과와 gate 근거 확인이 필요합니다.",
      ageLabel,
    );
  }

  if (run.status === "Queued") {
    return {
      state: "queued",
      label: "대기 중",
      summary: "runner가 작업을 가져가길 기다립니다.",
      tone: "queued",
      ageLabel,
      attention: false,
      terminal: false,
    };
  }

  if (run.status === "Running" && run.pendingRunApprovalId) {
    return {
      state: "approval_pending",
      label: "승인 대기",
      summary: "사용자 승인이 필요해서 run이 멈췄습니다.",
      tone: "attention",
      ageLabel,
      attention: true,
      terminal: false,
    };
  }

  if (run.status === "Running") {
    if (!run.startedAt && !run.latestEventAt && !run.heartbeatAt) {
      return {
        state: "starting",
        label: "시작 중",
        summary: "agent process를 준비하고 있습니다.",
        tone: "running",
        ageLabel,
        attention: false,
        terminal: false,
      };
    }

    if (ageMs >= STALLED_AFTER_MS) {
      return {
        state: "stalled_candidate",
        label: "정체 후보",
        summary: "최근 신호가 없어 점검이 필요할 수 있습니다.",
        tone: "attention",
        ageLabel,
        attention: true,
        terminal: false,
      };
    }

    if (ageMs >= QUIET_AFTER_MS) {
      return {
        state: "quiet",
        label: "조용함",
        summary: "오래 걸리는 작업일 수 있습니다. 완료로 추정하지 않습니다.",
        tone: "running",
        ageLabel,
        attention: false,
        terminal: false,
      };
    }

    return {
      state: "running",
      label: "실행 중",
      summary: `마지막 신호: ${ageLabel}`,
      tone: "running",
      ageLabel,
      attention: false,
      terminal: false,
    };
  }

  return terminalAttention(run, "needs_inspection", "점검 필요", "알 수 없는 run 상태입니다.", ageLabel);
}

export function selectVisibleRun(runs: AgentRunSummary[]): AgentRunSummary | null {
  const scored = runs
    .map((run, index) => ({ run, state: deriveRunLiveState(run), index }))
    .sort((left, right) => visibleRunPriority(left.state.state) - visibleRunPriority(right.state.state) || left.index - right.index);
  return scored[0]?.run ?? null;
}

export function isRunAttentionState(run: AgentRunSummary): boolean {
  return deriveRunLiveState(run).attention;
}

export function isRunActiveState(run: AgentRunSummary): boolean {
  const state = deriveRunLiveState(run).state;
  return state === "running" || state === "quiet" || state === "stalled_candidate" || state === "approval_pending" || state === "starting";
}

function terminalAttention(
  run: AgentRunSummary,
  state: RunLiveState,
  label: string,
  fallback: string,
  ageLabel: string,
): RunLiveStateView {
  return {
    state,
    label,
    summary: terminalSummary(run, fallback),
    tone: "attention",
    ageLabel,
    attention: true,
    terminal: true,
  };
}

function terminalSummary(run: AgentRunSummary, fallback: string): string {
  return run.failureReason || run.latestEventMessage || run.resultStatus || fallback;
}

function visibleRunPriority(state: RunLiveState): number {
  if (state === "approval_pending") return 0;
  if (state === "stalled_candidate") return 1;
  if (state === "orphaned_after_restart" || state === "needs_inspection" || state === "timed_out" || state === "failed") return 2;
  if (state === "running" || state === "quiet" || state === "starting") return 3;
  if (state === "queued") return 4;
  if (state === "canceled") return 5;
  return 6;
}

function ageFromNow(value: string | null | undefined, now: number): number {
  const time = value ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(time)) return Number.POSITIVE_INFINITY;
  return Math.max(0, now - time);
}

function formatRelativeAge(value: string | null | undefined, now: number): string {
  const time = value ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(time)) return "알 수 없음";
  const diffMs = Math.max(0, now - time);
  if (diffMs < 60_000) return "방금 전";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.floor(hours / 24)}일 전`;
}
