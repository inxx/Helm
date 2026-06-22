import { useEffect, useMemo, useRef } from "react";
import { deriveRunLiveState, isRunActiveState, isRunAttentionState, selectVisibleRun } from "../lib/runLiveState";
import { roleLabel } from "../lib/runnerReadiness";
import { TASK_STATUS_ORDER } from "../lib/status";
import type { AgentRunSummary, TaskStatus, TaskSummary } from "../lib/types";
import { useI18n } from "../lib/i18n";

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

const STATUS_MESSAGE_KEYS: Record<TaskStatus, Parameters<ReturnType<typeof useI18n>["t"]>[0]> = {
  Planned: "tasks.status.Planned",
  Ready: "tasks.status.Ready",
  Coding: "tasks.status.Coding",
  PlanVerification: "tasks.status.PlanVerification",
  CodeReview: "tasks.status.CodeReview",
  Testing: "tasks.status.Testing",
  MergeWaiting: "tasks.status.MergeWaiting",
  Merged: "tasks.status.Merged",
  Done: "tasks.status.Done",
  Blocked: "tasks.status.Blocked",
};

const EMPTY_COLUMN_MESSAGE_KEYS: Record<TaskStatus, Parameters<ReturnType<typeof useI18n>["t"]>[0]> = {
  Planned: "tasks.column.Planned.empty",
  Ready: "tasks.column.Ready.empty",
  Coding: "tasks.column.Coding.empty",
  PlanVerification: "tasks.column.PlanVerification.empty",
  CodeReview: "tasks.column.CodeReview.empty",
  Testing: "tasks.column.Testing.empty",
  MergeWaiting: "tasks.column.MergeWaiting.empty",
  Merged: "tasks.column.Merged.empty",
  Done: "tasks.column.Done.empty",
  Blocked: "tasks.column.Blocked.empty",
};

interface TaskBoardProps {
  tasks: TaskSummary[];
  taskRuns?: Record<string, AgentRunSummary[]>;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string | null) => void;
  projectLabels?: Record<string, string>;
}

export function TaskBoard({ tasks, taskRuns = {}, selectedTaskId, onSelectTask, projectLabels }: TaskBoardProps) {
  const { t } = useI18n();
  const tasksByStatus = groupTasksByStatus(tasks);
  const boardRef = useRef<HTMLDivElement | null>(null);
  const focusStatus = useMemo(
    () => focusStatusForBoard(tasks, taskRuns, selectedTaskId),
    [tasks, taskRuns, selectedTaskId],
  );

  useEffect(() => {
    if (!focusStatus) return;
    const column = boardRef.current?.querySelector<HTMLElement>(`[data-status="${focusStatus}"]`);
    column?.scrollIntoView({ block: "nearest", inline: "start" });
  }, [focusStatus]);

  return (
    <div className="task-board" data-focus-status={focusStatus ?? undefined} ref={boardRef}>
      {TASK_STATUS_ORDER.map((status) => {
        const columnTasks = tasksByStatus[status];
        const stage = STATUS_STAGE[status];
        const columnTone = columnToneForTasks(columnTasks, taskRuns);
        return (
          <section className="task-column" data-status={status} data-tone={columnTone} key={status}>
            <header className="task-column-header">
              <div>
                <span>{t(STATUS_MESSAGE_KEYS[status])}</span>
                <small>{COLUMN_HINT[status]}</small>
              </div>
              <strong>{columnTasks.length}</strong>
            </header>
            <div className={columnTasks.length === 0 ? "task-card-list empty" : "task-card-list"}>
              {columnTasks.length === 0 ? (
                <div className="task-column-empty">
                  <strong>{stage.label}</strong>
                  <span>{t(EMPTY_COLUMN_MESSAGE_KEYS[status])}</span>
                </div>
              ) : null}
              {columnTasks.map((task) => {
                const externalRef = task.externalRefs[0];
                const activeRun = activeRunForTask(taskRuns[task.id] ?? []);
                const flowLabel = activeRun ? runFlowLabel(activeRun) : stage.next;
                const flowCaption = activeRun ? t("tasks.card.run") : t("tasks.card.next");
                const taskAriaLabel = taskCardAriaLabel(task, activeRun, flowLabel, t);
                const projectLabel = projectLabels?.[task.projectId];
                return (
                  <button
                    aria-label={taskAriaLabel}
                    aria-pressed={task.id === selectedTaskId}
                    className={task.id === selectedTaskId ? "task-card selected" : "task-card"}
                    key={task.id}
                    onClick={() => onSelectTask(task.id === selectedTaskId ? null : task.id)}
                    title={task.title}
                    type="button"
                  >
                    <div className="task-card-topline">
                      <span className={`task-stage-pill ${stage.tone}`}>{stage.label}</span>
                      <small>{relativeTime(task.lastTransitionAt)}</small>
                    </div>
                    {projectLabel ? <span className="task-card-project">{projectLabel}</span> : null}
                    <strong className="task-card-title">{task.title}</strong>
                    {task.description ? <span className="task-card-description">{task.description}</span> : null}
                    {activeRun ? (
                      <div className={`task-card-run ${runTone(activeRun)}`}>
                        <span>{runStatusLabel(activeRun)}</span>
                        <strong>
                          {roleLabel(activeRun.roleId)}
                          {runnerModelLabel(activeRun) ? (
                            <span className="task-card-run-model"> · {runnerModelLabel(activeRun)}</span>
                          ) : null}
                        </strong>
                        <small>{runHint(activeRun, t)}</small>
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
  return selectVisibleRun(runs);
}

function runFlowLabel(run: AgentRunSummary): string {
  const live = deriveRunLiveState(run);
  return `${roleLabel(run.roleId)} · ${live.label}`;
}

function runHint(run: AgentRunSummary, t: ReturnType<typeof useI18n>["t"]): string {
  const live = deriveRunLiveState(run);
  if (live.state === "running") return live.summary;
  if (live.state === "approval_pending") return t("tasks.run.approvalPending");
  if (live.state === "quiet" || live.state === "stalled_candidate") return `${live.summary} · ${live.ageLabel}`;
  if (live.state === "queued" || live.state === "starting") return live.summary;
  if (run.failureKind) return humanizedFailureReason(run, t) ?? `${failureKindLabel(run.failureKind, t)} · ${t("tasks.run.retryPossible")}`;
  return live.summary || (run.resultStatus ? `${run.resultStatus} · ${t("tasks.run.retryPossible")}` : t("tasks.run.checkDetails"));
}

function runStatusLabel(run: AgentRunSummary): string {
  return deriveRunLiveState(run).label;
}

function runnerModelLabel(run: AgentRunSummary): string | null {
  return run.model ?? run.provider ?? null;
}

function runTone(run: AgentRunSummary): "running" | "queued" | "attention" | "done" {
  return deriveRunLiveState(run).tone;
}

function failureKindLabel(kind: string, t: ReturnType<typeof useI18n>["t"]): string {
  if (kind === "needs_inspection") return t("tasks.failure.needsInspection");
  if (kind === "blocking_gate") return t("tasks.failure.blockingGate");
  if (kind === "diff_mismatch") return t("tasks.failure.diffMismatch");
  if (kind === "schema_invalid") return t("tasks.failure.schemaInvalid");
  if (kind === "timeout") return t("tasks.failure.timeout");
  if (kind === "exit_failed") return t("tasks.failure.exitFailed");
  if (kind === "canceled") return t("tasks.failure.canceled");
  return kind;
}

function humanizedFailureReason(run: AgentRunSummary, t: ReturnType<typeof useI18n>["t"]): string | null {
  if (!run.failureReason) return null;
  if (run.failureKind === "needs_inspection") {
    return t("tasks.failure.needsInspectionReason");
  }
  if (run.failureKind === "blocking_gate") {
    return t("tasks.failure.blockingGateReason");
  }
  return run.failureReason;
}

function taskCardAriaLabel(
  task: TaskSummary,
  activeRun: AgentRunSummary | null,
  flowLabel: string,
  t: ReturnType<typeof useI18n>["t"],
): string {
  const parts = [`${task.title}`, `${t("tasks.card.currentStage")} ${t(STATUS_MESSAGE_KEYS[task.status])}`];
  if (activeRun) {
    const live = deriveRunLiveState(activeRun);
    const model = runnerModelLabel(activeRun);
    parts.push(`${roleLabel(activeRun.roleId)}${model ? ` ${model}` : ""} ${live.label}`);
  } else {
    parts.push(`${t("tasks.card.nextAction")} ${flowLabel}`);
  }
  return parts.join(". ");
}

function columnToneForTasks(
  tasks: TaskSummary[],
  taskRuns: Record<string, AgentRunSummary[]>,
): "attention" | "active" | "idle" {
  if (tasks.some((task) => isVisibleTaskAttention(task, taskRuns[task.id] ?? []))) {
    return "attention";
  }
  if (tasks.some((task) => (taskRuns[task.id] ?? []).some(isRunActiveState))) {
    return "active";
  }
  return "idle";
}

function focusStatusForBoard(
  tasks: TaskSummary[],
  taskRuns: Record<string, AgentRunSummary[]>,
  selectedTaskId: string | null,
): TaskStatus | null {
  const selectedTask = selectedTaskId ? tasks.find((task) => task.id === selectedTaskId) : null;
  if (selectedTask) return selectedTask.status;

  const attentionTask = tasks.find((task) => isVisibleTaskAttention(task, taskRuns[task.id] ?? []));
  if (attentionTask) return attentionTask.status;

  const activeTask = tasks.find((task) => (taskRuns[task.id] ?? []).some(isRunActiveState));
  return activeTask?.status ?? null;
}

function isVisibleTaskAttention(task: TaskSummary, runs: AgentRunSummary[]): boolean {
  if (task.status === "Blocked") return true;
  const visibleRun = selectVisibleRun(runs);
  return visibleRun ? isRunAttentionState(visibleRun) : false;
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
