import { deriveRunLiveState, isRunActiveState, isRunAttentionState, selectVisibleRun } from "../lib/runLiveState";
import { roleLabel, type RoleId } from "../lib/runnerReadiness";
import { TASK_STATUS_LABEL } from "../lib/status";
import type { AgentRunSummary, TaskStatus, TaskSummary } from "../lib/types";

type WorkState = "active" | "attention" | "waiting" | "done";

interface WorkRow {
  id: string;
  task: TaskSummary;
  roleId: RoleId | "coordinator";
  workerLabel: string;
  state: WorkState;
  stateLabel: string;
  summary: string;
  needsDecision: boolean;
  updatedAt: string;
  run: AgentRunSummary | null;
}

interface TaskBoardProps {
  tasks: TaskSummary[];
  taskRuns?: Record<string, AgentRunSummary[]>;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string | null) => void;
}

export function TaskBoard({ tasks, taskRuns = {}, selectedTaskId, onSelectTask }: TaskBoardProps) {
  const rows = tasks.map((task) => workRowForTask(task, taskRuns[task.id] ?? [])).sort(compareWorkRows);
  const counts = rows.reduce(
    (acc, row) => {
      acc[row.state] += 1;
      return acc;
    },
    { active: 0, attention: 0, waiting: 0, done: 0 },
  );

  return (
    <section className="worker-board" aria-label="작업자 상태">
      <header className="worker-board-summary">
        <div>
          <span>작업자 상태</span>
          <strong>
            진행 {counts.active} · 확인 필요 {counts.attention} · 대기 {counts.waiting}
          </strong>
        </div>
        <small>클릭하면 진행 내용, 승인/질문, 참고 문서, 변경 파일만 확인합니다.</small>
      </header>
      {rows.length === 0 ? (
        <div className="worker-board-empty">
          <strong>현재 추적 중인 작업이 없습니다.</strong>
          <span>계획을 승인하거나 Task를 만들면 작업자별 상태가 여기에 표시됩니다.</span>
        </div>
      ) : (
        <div className="worker-row-list">
          {rows.map((row) => (
            <button
              aria-label={`${row.workerLabel}. ${row.task.title}. ${row.stateLabel}`}
              aria-pressed={row.task.id === selectedTaskId}
              className={row.task.id === selectedTaskId ? `worker-row selected ${row.state}` : `worker-row ${row.state}`}
              key={row.id}
              onClick={() => onSelectTask(row.task.id === selectedTaskId ? null : row.task.id)}
              type="button"
            >
              <div className="worker-row-main">
                <span className={`worker-state-dot ${row.state}`} />
                <div>
                  <strong>{row.workerLabel}</strong>
                  <span>{row.task.title}</span>
                </div>
              </div>
              <div className="worker-row-status">
                <strong>{row.stateLabel}</strong>
                <span>{row.summary}</span>
              </div>
              <div className="worker-row-meta">
                <span>{TASK_STATUS_LABEL[row.task.status]}</span>
                {row.needsDecision ? <strong>승인/질문 필요</strong> : <small>{relativeTime(row.updatedAt)}</small>}
              </div>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function workRowForTask(task: TaskSummary, runs: AgentRunSummary[]): WorkRow {
  const run = selectVisibleRun(runs);
  if (run) {
    const live = deriveRunLiveState(run);
    const attention = isRunAttentionState(run);
    const active = isRunActiveState(run);
    return {
      id: `${task.id}:${run.id}`,
      task,
      roleId: run.roleId as RoleId,
      workerLabel: roleLabel(run.roleId),
      state: attention ? "attention" : active ? "active" : run.status === "Succeeded" ? "done" : "waiting",
      stateLabel: live.label,
      summary: live.summary,
      needsDecision: live.attention || Boolean(run.pendingRunApprovalId),
      updatedAt: run.latestEventAt ?? run.heartbeatAt ?? run.updatedAt,
      run,
    };
  }

  return {
    id: task.id,
    task,
    roleId: roleForTaskStatus(task.status),
    workerLabel: roleLabel(roleForTaskStatus(task.status)),
    state: task.status === "Blocked" ? "attention" : terminalTaskStatus(task.status) ? "done" : "waiting",
    stateLabel: task.status === "Blocked" ? "막힘" : terminalTaskStatus(task.status) ? "완료" : "대기",
    summary: task.statusReason ?? nextWorkSummary(task.status),
    needsDecision: task.status === "Blocked",
    updatedAt: task.updatedAt,
    run: null,
  };
}

function compareWorkRows(left: WorkRow, right: WorkRow): number {
  return statePriority(left.state) - statePriority(right.state) || Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
}

function statePriority(state: WorkState): number {
  if (state === "attention") return 0;
  if (state === "active") return 1;
  if (state === "waiting") return 2;
  return 3;
}

function roleForTaskStatus(status: TaskStatus): RoleId {
  if (status === "Planned" || status === "Blocked") return "planner";
  if (status === "Ready" || status === "Coding" || status === "MergeWaiting") return "coder";
  if (status === "PlanVerification") return "plan_verifier";
  if (status === "CodeReview") return "code_reviewer";
  if (status === "Testing") return "tester";
  return "coder";
}

function terminalTaskStatus(status: TaskStatus): boolean {
  return status === "Merged" || status === "Done";
}

function nextWorkSummary(status: TaskStatus): string {
  if (status === "Planned") return "계획 승인을 기다립니다.";
  if (status === "Ready") return "구현자가 작업을 시작할 수 있습니다.";
  if (status === "Coding") return "구현 작업 상태를 확인합니다.";
  if (status === "PlanVerification") return "계획 준수 확인이 필요합니다.";
  if (status === "CodeReview") return "코드 리뷰가 필요합니다.";
  if (status === "Testing") return "테스트 검증이 필요합니다.";
  if (status === "MergeWaiting") return "머지 결정이 필요합니다.";
  return "닫힌 작업입니다.";
}

function relativeTime(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "알 수 없음";
  const diffMs = Math.max(0, Date.now() - time);
  if (diffMs < 60_000) return "방금 전";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.floor(hours / 24)}일 전`;
}
