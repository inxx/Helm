import { useEffect, useMemo, useRef } from "react";
import { epicBarrierWait, type EpicBarrierWait } from "../lib/epicBarrier";
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

// 보드 컬럼. Merged와 Done은 한 컬럼("완료")으로 합쳐 보여준다 — Merged가 사실상 완료이고
// Done은 PR 없는 폴백 종료라 사용자 관점에선 동일하다. key는 대표 상태(헤더/힌트/빈칸 문구용).
const BOARD_COLUMNS: { key: TaskStatus; statuses: TaskStatus[] }[] = [
  { key: "Planned", statuses: ["Planned"] },
  { key: "Ready", statuses: ["Ready"] },
  { key: "Coding", statuses: ["Coding"] },
  { key: "PlanVerification", statuses: ["PlanVerification"] },
  { key: "CodeReview", statuses: ["CodeReview"] },
  { key: "Testing", statuses: ["Testing"] },
  { key: "MergeWaiting", statuses: ["MergeWaiting"] },
  { key: "Done", statuses: ["Merged", "Done"] },
  { key: "Blocked", statuses: ["Blocked"] },
];

function columnKeyForStatus(status: TaskStatus): TaskStatus {
  return BOARD_COLUMNS.find((column) => column.statuses.includes(status))?.key ?? status;
}

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
    const column = boardRef.current?.querySelector<HTMLElement>(
      `[data-status="${columnKeyForStatus(focusStatus)}"]`,
    );
    column?.scrollIntoView({ block: "nearest", inline: "start" });
  }, [focusStatus]);

  return (
    <div className="task-board" data-focus-status={focusStatus ?? undefined} ref={boardRef}>
      {BOARD_COLUMNS.map((column) => {
        const status = column.key;
        const columnTasks = column.statuses.flatMap((member) => tasksByStatus[member]);
        if (column.statuses.length > 1) {
          columnTasks.sort(
            (a, b) => a.sortOrder - b.sortOrder || Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
          );
        }
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
                const activeRun = activeRunForTask(taskRuns[task.id] ?? []);
                // epic 게이트 anchor가 형제를 기다리는 중이면 idle처럼 보이는 대기를 가시화한다.
                const barrierWait = activeRun ? null : epicBarrierWait(task, tasks);
                // 합친 컬럼(완료) 안에서 Merged/Done 카드가 각자 라벨을 유지하도록 pill·flow는 task.status 기준.
                const taskStage = STATUS_STAGE[task.status];
                // 활성 run이 있으면 run 박스가 역할·상태를 보여주므로 flow 줄은 idle일 때만 쓴다.
                const flowLabel = taskStage.next;
                const flowCaption = t("tasks.card.next");
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
                      <span className={`task-stage-pill ${activeRun ? runPillTone(activeRun) : taskStage.tone}`}>
                        {activeRun ? runStatusLabel(activeRun) : taskStage.label}
                        {activeRun && runProgressSuffix(activeRun) ? ` · ${runProgressSuffix(activeRun)}` : ""}
                      </span>
                      <small>{relativeTime(task.lastTransitionAt)}</small>
                    </div>
                    {projectLabel ? <span className="task-card-project">{projectLabel}</span> : null}
                    <strong className="task-card-title">{task.title}</strong>
                    {task.description ? <span className="task-card-description">{task.description}</span> : null}
                    {barrierWait ? (
                      <div className="task-card-barrier" title={barrierWaitTitle(barrierWait)}>
                        <span>게이트 대기 · 형제 {barrierWait.blocking.length}</span>
                        <strong>{barrierWaitTitle(barrierWait)}</strong>
                      </div>
                    ) : !activeRun ? (
                      <div className="task-card-flow">
                        <span>{flowCaption}</span>
                        <strong>{flowLabel}</strong>
                      </div>
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

// 배리어를 막고 있는 형제 제목 요약. 길어지지 않게 2개까지만 보이고 나머지는 "외 N".
function barrierWaitTitle(wait: EpicBarrierWait): string {
  const names = wait.blocking.slice(0, 2).map((task) => task.title).join(", ");
  const more = wait.blocking.length > 2 ? ` 외 ${wait.blocking.length - 2}` : "";
  return `${names}${more}`;
}

function runStatusLabel(run: AgentRunSummary): string {
  return deriveRunLiveState(run).label;
}

function runnerModelLabel(run: AgentRunSummary): string | null {
  return run.model ?? run.provider ?? null;
}

// 진행률(%) 데이터가 없어, 실행 중인 run의 경과 시간 + 의미 있는 이벤트 수를 진행 신호로 보여준다.
function runProgressSuffix(run: AgentRunSummary): string | null {
  if (!isRunActiveState(run)) return null;
  const parts: string[] = [];
  const elapsed = elapsedLabel(run);
  if (elapsed) parts.push(elapsed);
  if (run.eventCount > 0) parts.push(`신호 ${run.eventCount}`);
  return parts.length ? parts.join(" · ") : null;
}

function elapsedLabel(run: AgentRunSummary): string | null {
  const start = run.startedAt ?? run.claimedAt;
  const startMs = start ? Date.parse(start) : Number.NaN;
  if (!Number.isFinite(startMs)) return null;
  const minutes = Math.floor(Math.max(0, Date.now() - startMs) / 60_000);
  if (minutes < 1) return "1분 미만";
  if (minutes < 60) return `${minutes}분`;
  return `${Math.floor(minutes / 60)}시간`;
}

// run tone을 상단 pill의 기존 톤 클래스로 매핑해 pill CSS를 그대로 재사용한다.
function runPillTone(run: AgentRunSummary): StageTone {
  const tone = deriveRunLiveState(run).tone;
  if (tone === "running") return "active";
  if (tone === "queued") return "ready";
  if (tone === "attention") return "blocked";
  return "done";
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
