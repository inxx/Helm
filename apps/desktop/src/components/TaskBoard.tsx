import { TASK_STATUS_LABEL, TASK_STATUS_ORDER } from "../lib/status";
import { roleLabel } from "../lib/runnerReadiness";
import type { AgentRunSummary, TaskStatus, TaskSummary } from "../lib/types";

type StageTone = "idle" | "ready" | "active" | "review" | "done" | "blocked";

const STATUS_STAGE: Record<TaskStatus, { label: string; next: string; tone: StageTone }> = {
  Planned: {
    label: "Plan",
    next: "Planner",
    tone: "idle",
  },
  Ready: {
    label: "Ready",
    next: "Coder",
    tone: "ready",
  },
  Coding: {
    label: "Build",
    next: "Watch run",
    tone: "active",
  },
  PlanVerification: {
    label: "Verify",
    next: "Plan review",
    tone: "review",
  },
  CodeReview: {
    label: "Review",
    next: "Code review",
    tone: "review",
  },
  Testing: {
    label: "Test",
    next: "Tester",
    tone: "review",
  },
  MergeWaiting: {
    label: "Merge",
    next: "Readiness",
    tone: "ready",
  },
  Merged: {
    label: "Merged",
    next: "Close out",
    tone: "done",
  },
  Done: {
    label: "Done",
    next: "No action",
    tone: "done",
  },
  Blocked: {
    label: "Blocked",
    next: "Decision",
    tone: "blocked",
  },
};

const COLUMN_HINT: Record<TaskStatus, string> = {
  Planned: "spec and acceptance",
  Ready: "approved for build",
  Coding: "agent is changing files",
  PlanVerification: "plan compliance gate",
  CodeReview: "quality gate",
  Testing: "test gate",
  MergeWaiting: "ready for merge decision",
  Merged: "branch landed",
  Done: "closed loop",
  Blocked: "needs decision",
};

const EMPTY_COLUMN_COPY: Record<TaskStatus, string> = {
  Planned: "새 계획 후보가 들어오면 여기에 쌓입니다.",
  Ready: "승인된 계획이 구현 대기 상태로 이동합니다.",
  Coding: "실행 중인 구현 작업이 여기에 표시됩니다.",
  PlanVerification: "구현 diff가 계획과 맞는지 확인하는 단계입니다.",
  CodeReview: "품질과 위험을 검토할 작업이 들어옵니다.",
  Testing: "테스트 검증이 필요한 작업이 들어옵니다.",
  MergeWaiting: "모든 gate를 통과한 작업이 merge 결정을 기다립니다.",
  Merged: "브랜치가 반영된 작업이 표시됩니다.",
  Done: "완전히 닫힌 작업이 표시됩니다.",
  Blocked: "사용자 결정이나 추가 입력이 필요한 작업이 표시됩니다.",
};

interface TaskBoardProps {
  tasks: TaskSummary[];
  taskRuns?: Record<string, AgentRunSummary[]>;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string | null) => void;
}

export function TaskBoard({ tasks, taskRuns = {}, selectedTaskId, onSelectTask }: TaskBoardProps) {
  const tasksByStatus = groupTasksByStatus(tasks);

  return (
    <div className="task-board">
      {TASK_STATUS_ORDER.map((status) => {
        const columnTasks = tasksByStatus[status];
        const stage = STATUS_STAGE[status];
        return (
          <section className="task-column" data-status={status} key={status}>
            <header className="task-column-header">
              <div>
                <span>{TASK_STATUS_LABEL[status]}</span>
                <small>{COLUMN_HINT[status]}</small>
              </div>
              <strong>{columnTasks.length}</strong>
            </header>
            <div className={columnTasks.length === 0 ? "task-card-list empty" : "task-card-list"}>
              {columnTasks.length === 0 ? (
                <div className="task-column-empty">
                  <strong>{stage.label}</strong>
                  <span>{EMPTY_COLUMN_COPY[status]}</span>
                </div>
              ) : null}
              {columnTasks.map((task) => {
                const externalRef = task.externalRefs[0];
                const activeRun = activeRunForTask(taskRuns[task.id] ?? []);
                const flowLabel = activeRun ? runFlowLabel(activeRun) : stage.next;
                const flowCaption = activeRun ? "run" : "next";
                return (
                  <button
                    aria-pressed={task.id === selectedTaskId}
                    className={task.id === selectedTaskId ? "task-card selected" : "task-card"}
                    key={task.id}
                    onClick={() => onSelectTask(task.id === selectedTaskId ? null : task.id)}
                    type="button"
                  >
                    <div className="task-card-topline">
                      <span className={`task-stage-pill ${stage.tone}`}>{stage.label}</span>
                      <small>{relativeTime(task.lastTransitionAt)}</small>
                    </div>
                    <strong className="task-card-title">{task.title}</strong>
                    {task.description ? <span className="task-card-description">{task.description}</span> : null}
                    {activeRun ? (
                      <div className={`task-card-run ${runTone(activeRun)}`}>
                        <span>{runStatusLabel(activeRun)}</span>
                        <strong>{roleLabel(activeRun.roleId)}</strong>
                        <small>{runHint(activeRun)}</small>
                      </div>
                    ) : null}
                    <div className="task-card-flow">
                      <span>{flowCaption}</span>
                      <strong>{flowLabel}</strong>
                    </div>
                    {task.statusReason ? <span className="task-card-reason">{task.statusReason}</span> : null}
                    {externalRef ? (
                      <small className="task-card-ref">
                        {externalRef.refTitle ? `${externalRef.refTitle} · ` : ""}
                        {externalRef.refValue}
                      </small>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function activeRunForTask(runs: AgentRunSummary[]): AgentRunSummary | null {
  return (
    runs.find((run) => run.status === "Running") ??
    runs.find((run) => run.status === "Queued") ??
    runs.find((run) => isAttentionRun(run.status)) ??
    null
  );
}

function runFlowLabel(run: AgentRunSummary): string {
  if (run.status === "Running") return `${roleLabel(run.roleId)} 진행 중`;
  if (run.status === "Queued") return `${roleLabel(run.roleId)} 대기`;
  if (run.failureKind) return `${roleLabel(run.roleId)} · ${failureKindLabel(run.failureKind)}`;
  return `${roleLabel(run.roleId)} 점검`;
}

function runHint(run: AgentRunSummary): string {
  if (run.status === "Running") {
    return run.heartbeatAt ? `heartbeat ${relativeTime(run.heartbeatAt)}` : "report가 올 때까지 실행 중";
  }
  if (run.status === "Queued") return "worker queue 대기";
  if (run.failureKind) return humanizedFailureReason(run) ?? `${failureKindLabel(run.failureKind)} · 재시도 가능`;
  return run.resultStatus ? `${run.resultStatus} · 재시도 가능` : "상세에서 근거 확인";
}

function runStatusLabel(run: AgentRunSummary): string {
  const status = runStatusKoreanLabel(run.status);
  return run.lifecyclePhase ? `${status} · ${run.lifecyclePhase}` : status;
}

function runTone(run: AgentRunSummary): "running" | "queued" | "attention" {
  if (run.status === "Running") return "running";
  if (run.status === "Queued") return "queued";
  return "attention";
}

function isAttentionRun(status: string): boolean {
  return status === "Failed" || status === "TimedOut" || status === "NeedsInspection" || status === "Canceled";
}

function runStatusKoreanLabel(status: string): string {
  if (status === "NeedsInspection") return "점검 필요";
  if (status === "Failed") return "실패";
  if (status === "TimedOut") return "시간 초과";
  if (status === "Canceled") return "취소됨";
  if (status === "Running") return "실행 중";
  if (status === "Queued") return "대기 중";
  if (status === "Succeeded") return "성공";
  return status;
}

function failureKindLabel(kind: string): string {
  if (kind === "needs_inspection") return "점검 필요";
  if (kind === "blocking_gate") return "게이트 차단";
  if (kind === "diff_mismatch") return "diff 불일치";
  if (kind === "schema_invalid") return "결과 포맷 불일치";
  if (kind === "timeout") return "시간 초과";
  if (kind === "exit_failed") return "실행 실패";
  if (kind === "canceled") return "취소됨";
  return kind;
}

function humanizedFailureReason(run: AgentRunSummary): string | null {
  if (!run.failureReason) return null;
  if (run.failureKind === "needs_inspection") {
    return "자동 판정에 필요한 근거가 부족해 수동 점검이 필요합니다.";
  }
  if (run.failureKind === "blocking_gate") {
    return "차단 이슈가 감지되어 다음 단계로 진행되지 않았습니다.";
  }
  return run.failureReason;
}

function groupTasksByStatus(tasks: TaskSummary[]): Record<TaskStatus, TaskSummary[]> {
  const grouped = Object.fromEntries(
    TASK_STATUS_ORDER.map((status) => [status, [] as TaskSummary[]]),
  ) as Record<TaskStatus, TaskSummary[]>;
  for (const task of tasks) {
    grouped[task.status].push(task);
  }
  for (const status of TASK_STATUS_ORDER) {
    grouped[status].sort(
      (a, b) => a.sortOrder - b.sortOrder || Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
    );
  }
  return grouped;
}

function relativeTime(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "-";
  const diffMs = Date.now() - time;
  const absMs = Math.abs(diffMs);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (absMs < minute) return "now";
  if (absMs < hour) return `${Math.floor(absMs / minute)}m ago`;
  if (absMs < day) return `${Math.floor(absMs / hour)}h ago`;
  return `${Math.floor(absMs / day)}d ago`;
}
