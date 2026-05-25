import { Loader2, X } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { useToast } from "./ToastProvider";
import { api } from "../lib/api";
import { runnerReadinessFor, roleLabel, type RoleId } from "../lib/runnerReadiness";
import { TASK_STATUS_LABEL, TASK_STATUS_ORDER } from "../lib/status";
import type {
  AgentRunSummary,
  ApprovalSummary,
  GitFileStatus,
  ProjectSnapshot,
  RunEventSummary,
  TaskStatus,
  TaskSummary,
  TaskTimelineEntry,
  TaskWorktreeSummary,
} from "../lib/types";

type DetailTab = "overview" | "timeline" | "runs" | "git" | "artifacts";
type TaskBlockerSource = "agent_run" | "runner_check" | "worktree" | "approval" | "repair_request";
type TaskBlockerKind =
  | "timeout"
  | "launch_failed"
  | "runner_missing"
  | "auth_required"
  | "schema_invalid"
  | "gate_failed"
  | "worktree_conflict"
  | "manual_decision";
type TaskBlockerActionKind = "retry" | "prepare_repair" | "open_settings" | "open_git" | "view_events";
type EvidenceTone = "info" | "success" | "warning" | "danger";

interface TaskBlocker {
  id: string;
  source: TaskBlockerSource;
  kind: TaskBlockerKind;
  tone: "warning" | "danger" | "info";
  title: string;
  reason: string;
  nextStep: string;
  actions: TaskBlockerAction[];
}

interface TaskBlockerAction {
  kind: TaskBlockerActionKind;
  label: string;
  runId?: string;
  repairRequestId?: string;
}

interface EvidenceCard {
  id: string;
  tone: EvidenceTone;
  label: string;
  title: string;
  summary: string;
  details: string[];
  runId: string;
}

interface RepairRequestView {
  id: string;
  status: string;
  severity: string;
  summary: string;
  requiredAction: string;
  affectedFiles: string[];
  sourceRunId: string | null;
  gateResultId: string | null;
  roleId: RoleId;
  updatedAt: string | null;
}

const DETAIL_TABS: Array<{ id: DetailTab; label: string }> = [
  { id: "overview", label: "개요" },
  { id: "timeline", label: "타임라인" },
  { id: "runs", label: "실행" },
  { id: "git", label: "Git" },
  { id: "artifacts", label: "산출물" },
];

const ROLE_IDS: RoleId[] = ["planner", "coder", "plan_verifier", "code_reviewer", "tester"];
const RUN_STALE_NOTICE_MS = 5 * 60 * 1000;

interface TaskDetailProps {
  snapshot: ProjectSnapshot;
  task: TaskSummary | null;
  onRefresh: () => Promise<void>;
  onGoGit: () => void;
  onGoSettings: () => void;
  onClose: () => void;
}

export function TaskDetail({ snapshot, task, onRefresh, onGoGit, onGoSettings, onClose }: TaskDetailProps) {
  const { showToast } = useToast();
  const [status, setStatus] = useState<TaskStatus>("Planned");
  const [busyAction, setBusyAction] = useState<{ key: string; label: string } | null>(null);
  const [runs, setRuns] = useState<AgentRunSummary[]>([]);
  const [timeline, setTimeline] = useState<TaskTimelineEntry[]>([]);
  const [runEvents, setRunEvents] = useState<Record<string, RunEventSummary[]>>({});
  const [worktree, setWorktree] = useState<TaskWorktreeSummary | null>(null);
  const [worktreeError, setWorktreeError] = useState<string | null>(null);
  const [worktreeFiles, setWorktreeFiles] = useState<GitFileStatus[]>([]);
  const [artifact, setArtifact] = useState<string | null>(null);
  const [evidenceCards, setEvidenceCards] = useState<EvidenceCard[]>([]);
  const [activeTab, setActiveTab] = useState<DetailTab>("overview");
  const [detailsLoaded, setDetailsLoaded] = useState(false);
  const pendingPlanApproval = task
    ? snapshot.approvals.find(
        (approval) =>
          approval.entityType === "Task" &&
          approval.entityId === task.id &&
          approval.approvalType === "PlanApproval" &&
          approval.status === "Pending",
      ) ?? null
    : null;
  const busy = Boolean(busyAction);

  useEffect(() => {
    setStatus(task?.status ?? "Planned");
  }, [task?.status]);

  useEffect(() => {
    setActiveTab("overview");
    setArtifact(null);
    setRunEvents({});
    setEvidenceCards([]);
    setWorktreeError(null);
    setDetailsLoaded(false);
  }, [task?.id]);

  useEffect(() => {
    let disposed = false;
    if (!task) {
      setRuns([]);
      setTimeline([]);
      setWorktree(null);
      setWorktreeFiles([]);
      setDetailsLoaded(true);
      return;
    }
    setDetailsLoaded(false);
    void (async () => {
      try {
        const [nextRuns, nextTimeline, nextWorktree] = await Promise.all([
          api.listAgentRuns(snapshot.project.id, task.id),
          api.listTaskTimeline(snapshot.project.id, task.id),
          api.getTaskWorktree(snapshot.project.id, task.id),
        ]);
        if (disposed) return;
        setRuns(nextRuns);
        setTimeline(nextTimeline);
        setWorktree(nextWorktree);
        await refreshWorktreeFiles(nextWorktree);
        const recentRuns = nextRuns.slice(0, 3);
        const entries = await Promise.all(
          recentRuns.map(async (run) => [run.id, await api.listRunEvents(snapshot.project.id, run.id)] as const),
        );
        if (!disposed) setRunEvents(Object.fromEntries(entries));
      } finally {
        if (!disposed) setDetailsLoaded(true);
      }
    })();
    return () => {
      disposed = true;
    };
  }, [snapshot.project.id, task?.id]);

  useEffect(() => {
    if (!task) return;
    let disposed = false;
    const cleanups: Array<() => void> = [];

    void listen<{ projectId?: string; taskId?: string }>("agent-run://updated", async (event) => {
      if (event.payload.projectId !== snapshot.project.id || event.payload.taskId !== task.id) return;
      try {
        const [nextRuns, nextTimeline, nextWorktree] = await Promise.all([
          api.listAgentRuns(snapshot.project.id, task.id),
          api.listTaskTimeline(snapshot.project.id, task.id),
          api.getTaskWorktree(snapshot.project.id, task.id),
        ]);
        if (disposed) return;
        setRuns(nextRuns);
        setTimeline(nextTimeline);
        setWorktree(nextWorktree);
        await onRefresh();
      } catch {
        // The user can still refresh manually; event refresh is best-effort.
      }
    }).then((cleanup) => {
      if (disposed) {
        cleanup();
      } else {
        cleanups.push(cleanup);
      }
    });
    void listen<RunEventSummary>("agent-run://event", async (event) => {
      const payload = event.payload;
      if (payload.projectId !== snapshot.project.id || payload.taskId !== task.id) return;
      setRunEvents((current) => appendRunEvent(current, payload));
      if (payload.kind === "status" || payload.kind === "result" || payload.kind === "approval") {
        try {
          const [nextRuns, nextTimeline] = await Promise.all([
            api.listAgentRuns(snapshot.project.id, task.id),
            api.listTaskTimeline(snapshot.project.id, task.id),
          ]);
          if (!disposed) {
            setRuns(nextRuns);
            setTimeline(nextTimeline);
          }
        } catch {
          // Event rows still render; run summary refresh is best-effort.
        }
      }
    }).then((cleanup) => {
      if (disposed) {
        cleanup();
      } else {
        cleanups.push(cleanup);
      }
    });

    return () => {
      disposed = true;
      cleanups.forEach((cleanup) => cleanup());
    };
  }, [onRefresh, snapshot.project.id, task?.id]);

  useEffect(() => {
    let disposed = false;
    if (!task || runs.length === 0) {
      setEvidenceCards([]);
      return;
    }
    void (async () => {
      const cards = await evidenceCardsForRuns(snapshot.project.id, runs.slice(0, 6));
      if (!disposed) setEvidenceCards(cards);
    })();
    return () => {
      disposed = true;
    };
  }, [snapshot.project.id, task?.id, runs]);

  if (!task) {
    return (
      <aside className="detail-panel empty-detail">
        <h2>선택된 태스크 없음</h2>
        <p>보드에서 태스크를 선택하면 상세 정보가 표시됩니다.</p>
      </aside>
    );
  }

  async function updateStatus() {
    if (!task) return;
    if (status === task.status) {
      showToast({
        tone: "info",
        title: "상태 변경 없음",
        description: `이미 ${TASK_STATUS_LABEL[status]} 상태입니다.`,
      });
      return;
    }
    const previousStatus = task.status;
    setBusyAction({ key: "status", label: "상태 변경 중" });
    try {
      await api.updateTaskStatus(snapshot.project.id, task.id, status, "수동 상태 변경");
      await onRefresh();
      showToast({
        tone: "success",
        title: "상태 변경 완료",
        description: `${TASK_STATUS_LABEL[previousStatus]} → ${TASK_STATUS_LABEL[status]}`,
      });
    } catch (error) {
      showToast({
        tone: "error",
        title: "상태 변경 실패",
        description: messageFromError(error, "태스크 상태를 변경하지 못했습니다."),
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function runRole(roleId: string) {
    if (!task) return;
    setBusyAction({ key: `stub:${roleId}`, label: `${roleLabel(roleId)} fixture 실행 중` });
    try {
      const run = await api.runStubRole(snapshot.project.id, task.id, roleId);
      const nextRuns = await api.listAgentRuns(snapshot.project.id, task.id);
      setRuns(nextRuns);
      setTimeline(await api.listTaskTimeline(snapshot.project.id, task.id));
      await onRefresh();
      setActiveTab("artifacts");
      showToast({
        tone: "success",
        title: `${roleLabel(roleId)} 실행 완료`,
        description: run.resultStatus ? `결과 ${run.resultStatus}가 반영되었습니다.` : "태스크 상태를 갱신했습니다.",
      });
    } catch (error) {
      showToast({
        tone: "error",
        title: `${roleLabel(roleId)} 실행 실패`,
        description: messageFromError(error, "역할 실행에 실패했습니다."),
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function prepareContext(roleId: string) {
    if (!task) return;
    setBusyAction({ key: `prepare:${roleId}`, label: `${roleLabel(roleId)} context 준비 중` });
    try {
      await api.prepareRoleContext(snapshot.project.id, task.id, roleId);
      const nextRuns = await api.listAgentRuns(snapshot.project.id, task.id);
      setRuns(nextRuns);
      setTimeline(await api.listTaskTimeline(snapshot.project.id, task.id));
      await onRefresh();
      setActiveTab("runs");
      showToast({
        tone: "success",
        title: `${roleLabel(roleId)} 실행 준비 완료`,
        description: "Context Pack과 대기 실행을 만들었습니다.",
      });
    } catch (error) {
      showToast({
        tone: "error",
        title: `${roleLabel(roleId)} 실행 준비 실패`,
        description: messageFromError(error, "역할 실행 준비에 실패했습니다."),
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function prepareRepair(repairRequestId: string) {
    if (!task) return;
    setBusyAction({ key: `repair:${repairRequestId}`, label: "targeted repair 준비 중" });
    try {
      await api.prepareRepairContext(snapshot.project.id, repairRequestId);
      const nextRuns = await api.listAgentRuns(snapshot.project.id, task.id);
      setRuns(nextRuns);
      setTimeline(await api.listTaskTimeline(snapshot.project.id, task.id));
      await refreshWorktreeFiles();
      await onRefresh();
      setActiveTab("runs");
      showToast({
        tone: "success",
        title: "repair 준비 완료",
        description: "실패 gate와 affected files를 포함한 Repair Context Pack을 만들었습니다.",
      });
    } catch (error) {
      showToast({
        tone: "error",
        title: "repair 준비 실패",
        description: messageFromError(error, "targeted repair를 준비하지 못했습니다."),
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function prepareWorktree() {
    if (!task) return;
    setBusyAction({ key: "worktree", label: "Worktree 준비 중" });
    try {
      const nextWorktree = await api.ensureTaskWorktree(snapshot.project.id, task.id);
      setWorktree(nextWorktree);
      setWorktreeError(null);
      await refreshWorktreeFiles(nextWorktree);
      await onRefresh();
      showToast({
        tone: "success",
        title: "Worktree 준비 완료",
        description: nextWorktree.branchName,
      });
    } catch (error) {
      const description = messageFromError(error, "태스크 worktree를 준비하지 못했습니다.");
      showToast({
        tone: "error",
        title: "Worktree 준비 실패",
        description,
      });
      setWorktreeError(description);
    } finally {
      setBusyAction(null);
    }
  }

  async function showArtifact(runId: string, artifactName: string) {
    try {
      const content = await api.readRunArtifact(snapshot.project.id, runId, artifactName);
      setArtifact(content);
      setActiveTab("artifacts");
    } catch (error) {
      showToast({
        tone: "error",
        title: "산출물 열기 실패",
        description: messageFromError(error, "산출물을 읽지 못했습니다."),
      });
    }
  }

  async function refreshWorktreeFiles(nextWorktree: TaskWorktreeSummary | null = worktree) {
    if (!task || !nextWorktree) {
      setWorktreeFiles([]);
      return;
    }
    try {
      setWorktreeFiles(await api.getTaskWorktreeChangedFiles(snapshot.project.id, task.id));
    } catch {
      setWorktreeFiles([]);
    }
  }

  async function showRunEvents(runId: string) {
    try {
      const events = await api.listRunEvents(snapshot.project.id, runId);
      setRunEvents((current) => ({ ...current, [runId]: events }));
      setArtifact(formatRunEvents(events));
      setActiveTab("artifacts");
    } catch (error) {
      showToast({
        tone: "error",
        title: "이벤트 열기 실패",
        description: messageFromError(error, "실행 이벤트를 읽지 못했습니다."),
      });
    }
  }

  async function runHost(runId: string) {
    if (!task) return;
    const run = runs.find((item) => item.id === runId);
    setBusyAction({ key: `host:${runId}`, label: `${roleLabel(run?.roleId ?? "host")} host 실행 중` });
    setRuns((current) =>
      current.map((run) =>
        run.id === runId
          ? {
              ...run,
              status: "Running",
              lifecyclePhase: "running",
              heartbeatAt: new Date().toISOString(),
            }
          : run,
      ),
    );
    try {
      const completedRun = await api.runHostRole(snapshot.project.id, runId);
      const nextRuns = await api.listAgentRuns(snapshot.project.id, task.id);
      setRuns(nextRuns);
      setTimeline(await api.listTaskTimeline(snapshot.project.id, task.id));
      await refreshWorktreeFiles();
      await onRefresh();
      setActiveTab(completedRun.status === "Succeeded" ? "artifacts" : "timeline");
      showToast({
        tone: completedRun.status === "Succeeded" ? "success" : "info",
        title: completedRun.status === "Succeeded" ? "Host 실행 완료" : "Host 실행 점검 필요",
        description:
          completedRun.status === "Succeeded"
            ? "실행 결과와 태스크 상태를 갱신했습니다."
            : `${completedRun.status} 상태입니다. 타임라인에서 gate와 repair 근거를 확인하세요.`,
      });
    } catch (error) {
      showToast({
        tone: "error",
        title: "Host 실행 실패",
        description: messageFromError(error, "Host role 실행에 실패했습니다."),
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function retryHost(runId: string) {
    if (!task) return;
    setBusyAction({ key: `retry:${runId}`, label: "재시도 준비 중" });
    try {
      await api.retryHostRole(snapshot.project.id, runId);
      const nextRuns = await api.listAgentRuns(snapshot.project.id, task.id);
      setRuns(nextRuns);
      setTimeline(await api.listTaskTimeline(snapshot.project.id, task.id));
      await refreshWorktreeFiles();
      await onRefresh();
      setActiveTab("runs");
      showToast({
        tone: "success",
        title: "재시도 준비 완료",
        description: "실행 상태를 갱신했습니다.",
      });
    } catch (error) {
      showToast({
        tone: "error",
        title: "재시도 실패",
        description: messageFromError(error, "실행을 재시도하지 못했습니다."),
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function cancelHost(runId: string) {
    if (!task) return;
    setBusyAction({ key: `cancel:${runId}`, label: "실행 취소 중" });
    try {
      await api.cancelHostRole(snapshot.project.id, runId);
      setRuns((current) =>
        current.map((run) => (run.id === runId ? { ...run, status: "Canceled" } : run)),
      );
      setTimeline(await api.listTaskTimeline(snapshot.project.id, task.id));
      showToast({
        tone: "success",
        title: "실행 취소 완료",
        description: "실행 상태가 Canceled로 변경되었습니다.",
      });
    } catch (error) {
      showToast({
        tone: "error",
        title: "실행 취소 실패",
        description: messageFromError(error, "실행을 취소하지 못했습니다."),
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function approvePendingPlan(approval: ApprovalSummary) {
    if (!task) return;
    setBusyAction({ key: `approval:${approval.id}`, label: "계획 승인 중" });
    try {
      await api.approveApproval(snapshot.project.id, approval.id, "Task 상세에서 계획 승인");
      try {
        await api.startNextRoleRun(snapshot.project.id, task.id);
      } catch {
        // The task remains Ready; Runtime readiness and next action explain what is missing.
      }
      await onRefresh();
      setActiveTab("runs");
      showToast({
        tone: "success",
        title: "계획 승인 완료",
        description: "테스트 완료 전까지 자동 진행을 시작했습니다. Merge는 수동으로 남겨둡니다.",
      });
    } catch (error) {
      showToast({
        tone: "error",
        title: "계획 승인 실패",
        description: messageFromError(error, "계획 승인을 처리하지 못했습니다."),
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function requestPlanRevision(approval: ApprovalSummary) {
    if (!task) return;
    const reason = window.prompt("수정 요청 내용을 적어주세요.", "계획 범위와 승인 조건을 다시 다듬어주세요.");
    if (reason === null) return;
    setBusyAction({ key: `approval:${approval.id}`, label: "수정 요청 저장 중" });
    try {
      await api.rejectApproval(snapshot.project.id, approval.id, reason.trim() || "계획 수정 요청");
      await onRefresh();
      setActiveTab("timeline");
      showToast({
        tone: "info",
        title: "계획 수정 요청 저장",
        description: "Task가 Blocked로 이동했습니다. 계획을 수정한 뒤 다시 실행할 수 있습니다.",
      });
    } catch (error) {
      showToast({
        tone: "error",
        title: "수정 요청 실패",
        description: messageFromError(error, "계획 수정 요청을 저장하지 못했습니다."),
      });
    } finally {
      setBusyAction(null);
    }
  }

  const activeRoleId = roleForTaskStatus(task.status);
  const activeRunnerReadiness = activeRoleId ? runnerReadinessFor(snapshot.settings, activeRoleId) : null;
  const openRepairRequests = repairRequestsFromTimeline(timeline);
  const activeRepairRequest = openRepairRequests[0] ?? null;
  const repairRunnerReadiness = activeRepairRequest
    ? runnerReadinessFor(snapshot.settings, activeRepairRequest.roleId)
    : null;
  const repairQueuedRun = activeRepairRequest
    ? runs.find((run) => run.repairRequestId === activeRepairRequest.id && run.status === "Queued") ?? null
    : null;
  const repairRunningRun = activeRepairRequest
    ? runs.find((run) => run.repairRequestId === activeRepairRequest.id && run.status === "Running") ?? null
    : null;
  const activeQueuedRun = activeRoleId
    ? runs.find((run) => run.roleId === activeRoleId && run.status === "Queued") ?? null
    : null;
  const activeRunningRun = activeRoleId
    ? runs.find((run) => run.roleId === activeRoleId && run.status === "Running") ?? null
    : null;
  const activeRetryableRun = activeRoleId
    ? runs.find((run) => run.roleId === activeRoleId && isRetryableRunStatus(run.status)) ?? null
    : null;
  const visibleRun = runs.find((run) => run.status === "Running" || run.status === "Queued") ?? runs[0] ?? null;
  const visibleRunEvents = visibleRun ? runEvents[visibleRun.id] ?? [] : [];
  const visibleRunActivity = visibleRun ? runActivityFor(visibleRun, visibleRunEvents) : null;
  const taskBlockers = taskBlockersFor({
    activeRoleId,
    pendingPlanApproval,
    runnerReadiness: activeRunnerReadiness,
    runEvents,
    runs,
    repairRequests: openRepairRequests,
    task,
    worktree,
    worktreeError,
  });

  return (
    <aside className="detail-panel task-console">
      <div className="task-console-summary">
        <div className="detail-header">
          <div className="detail-header-row">
            <span className="status-pill">{TASK_STATUS_LABEL[task.status]}</span>
            <button
              type="button"
              className="detail-close-button"
              onClick={onClose}
              title="상세 닫기"
              aria-label="태스크 상세 닫기"
            >
              <X size={14} aria-hidden />
            </button>
          </div>
          <h2>{task.title}</h2>
        </div>
        {task.description ? <p>{task.description}</p> : <p className="muted">설명 없음</p>}
        <div className="task-status-control" aria-label="태스크 상태 변경">
          <label>
            <span>상태 변경</span>
            <select value={status} onChange={(event) => setStatus(event.target.value as TaskStatus)}>
              {TASK_STATUS_ORDER.map((nextStatus) => (
                <option key={nextStatus} value={nextStatus}>
                  {TASK_STATUS_LABEL[nextStatus]}
                </option>
              ))}
            </select>
          </label>
          <button
            className="primary-button"
            disabled={busy || status === task.status}
            onClick={updateStatus}
            type="button"
          >
            변경
          </button>
        </div>
      </div>

      {busyAction ? (
        <div className="operation-status task-operation-status" role="status">
          <Loader2 className="loading-icon" size={14} aria-hidden />
          <span>{busyAction.label}</span>
        </div>
      ) : null}

      <section className="detail-section next-action-panel">
        <h3>다음 액션</h3>
        {!detailsLoaded ? (
          <div className="next-action-card">
            <div>
              <strong>상태 확인 중</strong>
              <p>실행 기록과 worktree 상태를 불러온 뒤 가능한 액션을 표시합니다.</p>
            </div>
          </div>
        ) : (
          <NextAction
            busy={busy}
            pendingPlanApproval={pendingPlanApproval}
            task={task}
            worktree={worktree}
            runnerReadiness={activeRunnerReadiness}
            repairRequest={activeRepairRequest}
            repairRunnerReadiness={repairRunnerReadiness}
            repairQueuedRun={repairQueuedRun}
            repairRunningRun={repairRunningRun}
            queuedRun={activeQueuedRun}
            runningRun={activeRunningRun}
            retryableRun={activeRetryableRun}
            busyAction={busyAction}
            onApprovePlan={approvePendingPlan}
            onRequestPlanRevision={requestPlanRevision}
            onPrepareWorktree={prepareWorktree}
            onPrepareContext={prepareContext}
            onPrepareRepair={prepareRepair}
            onRunHost={runHost}
            onCancelHost={cancelHost}
            onRetryHost={retryHost}
            onGoSettings={onGoSettings}
            onGoGit={onGoGit}
          />
        )}
      </section>

      {detailsLoaded && taskBlockers.length > 0 ? (
        <TaskBlockerPanel
          blockers={taskBlockers}
          busy={busy}
          onGoGit={onGoGit}
          onGoSettings={onGoSettings}
          onPrepareRepair={prepareRepair}
          onRetryHost={retryHost}
          onShowRunEvents={showRunEvents}
        />
      ) : null}

      {visibleRun ? (
        <section className="detail-section run-focus-panel">
          <div className="run-focus-header">
            <div>
              <h3>현재 실행</h3>
              <p>
                {roleLabel(visibleRun.roleId)} · {runStatusSummary(visibleRun)}
              </p>
            </div>
            {visibleRun.status === "Running" ? (
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() => void cancelHost(visibleRun.id)}
                type="button"
              >
                실행 중지
              </button>
            ) : null}
          </div>
          {visibleRunActivity && visibleRunActivity.tone !== "live" ? (
            <div className={`run-liveness-card ${visibleRunActivity.tone}`}>
              <strong>{visibleRunActivity.title}</strong>
              <span>{visibleRunActivity.description}</span>
            </div>
          ) : null}
          <div className="run-document-grid">
            <RunDocumentCard
              description="runner가 읽는 md 계획/컨텍스트"
              label="참고"
              name="context-pack.md"
              onOpen={() => showArtifact(visibleRun.id, "context-pack.md")}
            />
            <RunDocumentCard
              description="runner가 작성하는 실행 요약"
              label="생성"
              name="summary.md"
              onOpen={() => showArtifact(visibleRun.id, "summary.md")}
            />
            <RunDocumentCard
              description="gate/상태 판정 JSON"
              label="생성"
              name="structured-result.json"
              onOpen={() => showArtifact(visibleRun.id, "structured-result.json")}
            />
            <RunDocumentCard
              description="실시간 stdout/stderr/status 기록"
              label="진행"
              name="events"
              onOpen={() => showRunEvents(visibleRun.id)}
            />
          </div>
          <RunEventPreview events={visibleRunEvents} />
        </section>
      ) : null}

      <nav className="task-console-tabs" role="tablist" aria-label="태스크 콘솔">
        {DETAIL_TABS.map((tab) => (
          <button
            aria-selected={activeTab === tab.id}
            className={activeTab === tab.id ? "active" : ""}
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            role="tab"
            type="button"
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {activeTab === "overview" ? (
        <div className="task-console-tab-panel">
          <section className="detail-section">
            <h3>외부 참조</h3>
            {task.externalRefs.length > 0 ? (
              <ul className="plain-list">
                {task.externalRefs.map((ref) => (
                  <li key={ref.id}>
                    <strong>{ref.refType}</strong>
                    <span>{ref.refValue}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">연결된 외부 참조 없음</p>
            )}
          </section>

          <section className="detail-section task-console-metrics">
            <h3>요약</h3>
            <div>
              <span>runs</span>
              <strong>{runs.length}</strong>
            </div>
            <div>
              <span>dirty files</span>
              <strong>{snapshot.repository.dirtyCount}</strong>
            </div>
            <div>
              <span>worktree</span>
              <strong>{worktree ? "ready" : "none"}</strong>
            </div>
          </section>
        </div>
      ) : null}

      {activeTab === "timeline" ? (
        <div className="task-console-tab-panel">
          <section className="detail-section">
            <h3>결정 타임라인</h3>
            {timeline.length === 0 ? <p className="muted">아직 기록된 실행 근거가 없습니다.</p> : null}
            <ol className="timeline-list">
              {timeline.map((entry) => (
                <li key={`${entry.entryType}-${entry.id}`} className="timeline-entry">
                  <div>
                    <strong>{timelineTitle(entry)}</strong>
                    <span>{formatTimelineDate(entry.createdAt)}</span>
                  </div>
                  {entry.summary ? <p>{entry.summary}</p> : null}
                  <small>{entry.entryType}{entry.status ? ` · ${entry.status}` : ""}</small>
                </li>
              ))}
            </ol>
          </section>
        </div>
      ) : null}

      {activeTab === "runs" ? (
        <div className="task-console-tab-panel">
          <section className="detail-section">
            <h3>역할 실행</h3>
            <ul className="role-lane-list">
              {ROLE_IDS.map((roleId) => {
                const latestRun = runs.find((run) => run.roleId === roleId);
                const isCurrentRole = activeRoleId === roleId && !pendingPlanApproval;
                const readiness = runnerReadinessFor(snapshot.settings, roleId);
                const needsRunner = isCurrentRole && !readiness.ready;
                const needsWorktree = isCurrentRole && readiness.ready && !worktree;
                const prepareBusy = busyAction?.key === `prepare:${roleId}`;
                const stubBusy = busyAction?.key === `stub:${roleId}`;
                const hostBusy = latestRun ? busyAction?.key === `host:${latestRun.id}` : false;
                const retryBusy = latestRun ? busyAction?.key === `retry:${latestRun.id}` : false;
                const cancelBusy = latestRun ? busyAction?.key === `cancel:${latestRun.id}` : false;
                const roleBusy = prepareBusy || stubBusy || hostBusy || retryBusy || cancelBusy;
                return (
                  <li
                    aria-busy={roleBusy ? true : undefined}
                    className={`${isCurrentRole ? "role-lane active" : "role-lane"}${roleBusy ? " busy" : ""}`}
                    key={roleId}
                  >
                    <div>
                      <strong>{roleLabel(roleId)}</strong>
                      <span>
                        {latestRun
                          ? runStatusSummary(latestRun)
                          : readiness.ready
                            ? readiness.label
                            : readiness.description}
                      </span>
                    </div>
                    <div className="artifact-actions">
                      {needsRunner ? (
                        <button disabled={busy} onClick={onGoSettings} type="button">
                          runner 설정
                        </button>
                      ) : null}
                      {needsWorktree ? (
                        <button
                          aria-busy={busyAction?.key === "worktree" ? true : undefined}
                          className={busyAction?.key === "worktree" ? "loading-button is-loading" : "loading-button"}
                          disabled={busy}
                          onClick={prepareWorktree}
                          type="button"
                        >
                          {busyAction?.key === "worktree" ? <Loader2 className="loading-icon" size={12} aria-hidden /> : null}
                          {busyAction?.key === "worktree" ? "준비 중..." : "worktree 준비"}
                        </button>
                      ) : null}
                      {isCurrentRole && !needsRunner && !needsWorktree && !latestRun ? (
                        <button
                          aria-busy={prepareBusy ? true : undefined}
                          className={prepareBusy ? "loading-button is-loading" : "loading-button"}
                          disabled={busy}
                          onClick={() => prepareContext(roleId)}
                          type="button"
                        >
                          {prepareBusy ? <Loader2 className="loading-icon" size={12} aria-hidden /> : null}
                          {prepareBusy ? "준비 중..." : "실행 준비"}
                        </button>
                      ) : null}
                      {latestRun?.status === "Queued" ? (
                        <>
                          <button onClick={() => showArtifact(latestRun.id, "context-pack.md")} type="button">
                            context
                          </button>
                          <button onClick={() => showRunEvents(latestRun.id)} type="button">
                            events
                          </button>
                          <button
                            aria-busy={hostBusy ? true : undefined}
                            className={hostBusy ? "loading-button is-loading" : "loading-button"}
                            disabled={busy}
                            onClick={() => runHost(latestRun.id)}
                            type="button"
                          >
                            {hostBusy ? <Loader2 className="loading-icon" size={12} aria-hidden /> : null}
                            {hostBusy ? "실행 중..." : "host 실행"}
                          </button>
                        </>
                      ) : null}
                      {latestRun?.status === "Running" ? (
                        <button
                          aria-busy={cancelBusy ? true : undefined}
                          className={cancelBusy ? "loading-button is-loading" : "loading-button"}
                          disabled={busy}
                          onClick={() => cancelHost(latestRun.id)}
                          type="button"
                        >
                          {cancelBusy ? <Loader2 className="loading-icon" size={12} aria-hidden /> : null}
                          {cancelBusy ? "취소 중..." : "cancel"}
                        </button>
                      ) : null}
                      {latestRun && latestRun.status !== "Queued" ? (
                        <button onClick={() => showRunEvents(latestRun.id)} type="button">
                          events
                        </button>
                      ) : null}
                      {latestRun && isRetryableRunStatus(latestRun.status) ? (
                        <button
                          aria-busy={retryBusy ? true : undefined}
                          className={retryBusy ? "loading-button is-loading" : "loading-button"}
                          disabled={busy}
                          onClick={() => retryHost(latestRun.id)}
                          type="button"
                        >
                          {retryBusy ? <Loader2 className="loading-icon" size={12} aria-hidden /> : null}
                          {retryBusy ? "준비 중..." : "retry"}
                        </button>
                      ) : null}
                      {!isCurrentRole && !latestRun ? <span>현재 단계 아님</span> : null}
                    </div>
                    {latestRun ? <RunEventPreview events={runEvents[latestRun.id] ?? []} /> : null}
                  </li>
                );
              })}
            </ul>
            <details className="settings-disclosure task-devtools">
              <summary>개발용 실행 도구</summary>
              <p className="muted">fixture 검증이나 context pack 재생성이 필요할 때만 사용합니다.</p>
              <div className="role-grid">
                {ROLE_IDS.map((roleId) => {
                  const prepareBusy = busyAction?.key === `prepare:${roleId}`;
                  return (
                    <button
                      aria-busy={prepareBusy ? true : undefined}
                      className={prepareBusy ? "loading-button is-loading" : "loading-button"}
                      disabled={busy}
                      key={`context-${roleId}`}
                      onClick={() => prepareContext(roleId)}
                      type="button"
                    >
                      {prepareBusy ? <Loader2 className="loading-icon" size={12} aria-hidden /> : null}
                      {prepareBusy ? `${roleLabel(roleId)} 준비 중` : `${roleLabel(roleId)} context`}
                    </button>
                  );
                })}
              </div>
              <div className="role-grid">
                {ROLE_IDS.map((roleId) => {
                  const stubBusy = busyAction?.key === `stub:${roleId}`;
                  return (
                    <button
                      aria-busy={stubBusy ? true : undefined}
                      className={stubBusy ? "loading-button is-loading" : "loading-button"}
                      disabled={busy}
                      key={`stub-${roleId}`}
                      onClick={() => runRole(roleId)}
                      type="button"
                    >
                      {stubBusy ? <Loader2 className="loading-icon" size={12} aria-hidden /> : null}
                      {stubBusy ? `${roleLabel(roleId)} 실행 중` : `${roleLabel(roleId)} stub`}
                    </button>
                  );
                })}
              </div>
            </details>
          </section>
        </div>
      ) : null}

      {activeTab === "git" ? (
        <div className="task-console-tab-panel">
          <section className="detail-section">
            <h3>Git 요약</h3>
            <p className="muted">프로젝트 변경 파일 {snapshot.repository.dirtyCount}개</p>
            <button className="secondary-button" onClick={onGoGit} type="button">
              깃에서 보기
            </button>
          </section>

          <section className="detail-section">
            <h3>Task worktree</h3>
            {worktree ? (
              <div className="worktree-box">
                <strong>{worktree.branchName}</strong>
                <span>{worktree.worktreePath}</span>
              </div>
            ) : (
              <p className="muted">아직 태스크 전용 worktree가 없습니다.</p>
            )}
            <button
              aria-busy={busyAction?.key === "worktree" ? true : undefined}
              className={busyAction?.key === "worktree" ? "secondary-button loading-button is-loading" : "secondary-button loading-button"}
              disabled={busy}
              onClick={prepareWorktree}
              type="button"
            >
              {busyAction?.key === "worktree" ? <Loader2 className="loading-icon" size={14} aria-hidden /> : null}
              {busyAction?.key === "worktree" ? "준비 중..." : "worktree 준비"}
            </button>
          </section>

          <section className="detail-section">
            <h3>Worktree 변경 파일</h3>
            {!worktree ? <p className="muted">worktree 준비 후 변경 파일을 확인할 수 있습니다.</p> : null}
            {worktree && worktreeFiles.length === 0 ? <p className="muted">변경 파일 없음</p> : null}
            {worktreeFiles.length > 0 ? (
              <ul className="plain-list">
                {worktreeFiles.map((file) => (
                  <li key={`${file.status}-${file.path}`}>
                    <strong>{file.status}</strong>
                    <span>{file.path}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        </div>
      ) : null}

      {activeTab === "artifacts" ? (
        <div className="task-console-tab-panel">
          <section className="detail-section">
            <h3>실행 기록</h3>
            {runs.length === 0 ? (
              <p className="muted">아직 실행된 기록이 없습니다. 실행을 시작하면 이곳에 진행 상황이 표시됩니다.</p>
            ) : null}
            {evidenceCards.length > 0 ? (
              <ul className="evidence-card-list" aria-label="실행 evidence">
                {evidenceCards.map((card) => (
                  <li className={`evidence-card ${card.tone}`} key={card.id}>
                    <div>
                      <span>{card.label}</span>
                      <strong>{card.title}</strong>
                      <p>{card.summary}</p>
                    </div>
                    {card.details.length > 0 ? (
                      <ul>
                        {card.details.map((detail) => (
                          <li key={detail}>{detail}</li>
                        ))}
                      </ul>
                    ) : null}
                    <div className="artifact-actions">
                      <button onClick={() => showArtifact(card.runId, "summary.md")} type="button">summary</button>
                      <button onClick={() => showArtifact(card.runId, "structured-result.json")} type="button">result</button>
                      <button onClick={() => showRunEvents(card.runId)} type="button">events</button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}
            <ul className="run-list">
              {runs.map((run) => {
                const runBusy =
                  run.status === "Running" ||
                  busyAction?.key === `host:${run.id}` ||
                  busyAction?.key === `retry:${run.id}` ||
                  busyAction?.key === `cancel:${run.id}`;
                return (
                <li aria-busy={runBusy ? true : undefined} className={runBusy ? "busy" : undefined} key={run.id}>
                  <div>
                    <strong>{roleLabel(run.roleId)}</strong>
                    <span>
                      {runBusy ? <Loader2 className="loading-icon" size={12} aria-hidden /> : null}
                      {runStatusSummary(run)}
                    </span>
                  </div>
                  <div className="artifact-actions">
                    <button onClick={() => showArtifact(run.id, "summary.md")} type="button">summary</button>
                    <button onClick={() => showArtifact(run.id, "structured-result.json")} type="button">result</button>
                    <button onClick={() => showRunEvents(run.id)} type="button">events</button>
                    <button onClick={() => showArtifact(run.id, "stdout.log")} type="button">stdout</button>
                    <button onClick={() => showArtifact(run.id, "stderr.log")} type="button">stderr</button>
                    {run.status !== "Queued" ? (
                      <>
                        <button onClick={() => showArtifact(run.id, "changed-files.json")} type="button">files</button>
                        <button onClick={() => showArtifact(run.id, "diff.patch")} type="button">diff</button>
                      </>
                    ) : null}
                    {run.status === "Queued" ? (
                      <button onClick={() => showArtifact(run.id, "context-pack.md")} type="button">context</button>
                    ) : null}
                  </div>
                </li>
                );
              })}
            </ul>
            {artifact ? <pre className="artifact-viewer">{artifact}</pre> : null}
          </section>
        </div>
      ) : null}

    </aside>
  );
}

interface NextActionProps {
  busy: boolean;
  pendingPlanApproval: ApprovalSummary | null;
  task: TaskSummary;
  worktree: TaskWorktreeSummary | null;
  runnerReadiness: ReturnType<typeof runnerReadinessFor> | null;
  repairRequest: RepairRequestView | null;
  repairRunnerReadiness: ReturnType<typeof runnerReadinessFor> | null;
  repairQueuedRun: AgentRunSummary | null;
  repairRunningRun: AgentRunSummary | null;
  queuedRun: AgentRunSummary | null;
  runningRun: AgentRunSummary | null;
  retryableRun: AgentRunSummary | null;
  busyAction: { key: string; label: string } | null;
  onApprovePlan: (approval: ApprovalSummary) => Promise<void>;
  onRequestPlanRevision: (approval: ApprovalSummary) => Promise<void>;
  onPrepareWorktree: () => Promise<void>;
  onPrepareContext: (roleId: string) => Promise<void>;
  onPrepareRepair: (repairRequestId: string) => Promise<void>;
  onRunHost: (runId: string) => Promise<void>;
  onCancelHost: (runId: string) => Promise<void>;
  onRetryHost: (runId: string) => Promise<void>;
  onGoSettings: () => void;
  onGoGit: () => void;
}

function TaskBlockerPanel({
  blockers,
  busy,
  onGoGit,
  onGoSettings,
  onRetryHost,
  onPrepareRepair,
  onShowRunEvents,
}: {
  blockers: TaskBlocker[];
  busy: boolean;
  onGoGit: () => void;
  onGoSettings: () => void;
  onRetryHost: (runId: string) => Promise<void>;
  onPrepareRepair: (repairRequestId: string) => Promise<void>;
  onShowRunEvents: (runId: string) => Promise<void>;
}) {
  return (
    <section className="detail-section task-blocker-panel" aria-label="현재 blocker">
      <div className="task-blocker-panel-header">
        <h3>Blocker</h3>
        <span>{blockers.length}</span>
      </div>
      <ul className="task-blocker-list">
        {blockers.map((blocker) => (
          <li className={`task-blocker-card ${blocker.tone}`} key={blocker.id}>
            <div>
              <span>{blocker.source} · {blocker.kind}</span>
              <strong>{blocker.title}</strong>
              <p>{blocker.reason}</p>
              <small>{blocker.nextStep}</small>
            </div>
            <div className="artifact-actions">
              {blocker.actions.map((action) => (
                <button
                  disabled={busy}
                  key={`${blocker.id}-${action.kind}-${action.runId ?? "task"}`}
                  onClick={() => {
                    if (action.kind === "open_settings") {
                      onGoSettings();
                      return;
                    }
                    if (action.kind === "open_git") {
                      onGoGit();
                      return;
                    }
                    if (action.kind === "retry" && action.runId) {
                      void onRetryHost(action.runId);
                      return;
                    }
                    if (action.kind === "prepare_repair" && action.repairRequestId) {
                      void onPrepareRepair(action.repairRequestId);
                      return;
                    }
                    if (action.kind === "view_events" && action.runId) {
                      void onShowRunEvents(action.runId);
                    }
                  }}
                  type="button"
                >
                  {action.label}
                </button>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function NextAction({
  busy,
  pendingPlanApproval,
  task,
  worktree,
  runnerReadiness,
  repairRequest,
  repairRunnerReadiness,
  repairQueuedRun,
  repairRunningRun,
  queuedRun,
  runningRun,
  retryableRun,
  busyAction,
  onApprovePlan,
  onRequestPlanRevision,
  onPrepareWorktree,
  onPrepareContext,
  onPrepareRepair,
  onRunHost,
  onCancelHost,
  onRetryHost,
  onGoSettings,
  onGoGit,
}: NextActionProps) {
  if (pendingPlanApproval) {
    const approvalBusy = busyAction?.key === `approval:${pendingPlanApproval.id}`;
    return (
      <div className="next-action-card waiting">
        <div>
          <strong>계획 승인 대기</strong>
          <p>승인하면 구현, 검토, 테스트 완료까지 자동 진행을 시작합니다. Merge 결정은 수동으로 남습니다.</p>
        </div>
        <div className="artifact-actions">
          <button
            aria-busy={approvalBusy ? true : undefined}
            className={approvalBusy ? "primary-button loading-button is-loading" : "primary-button loading-button"}
            disabled={busy}
            onClick={() => void onApprovePlan(pendingPlanApproval)}
            type="button"
          >
            {approvalBusy ? <Loader2 className="loading-icon" size={14} aria-hidden /> : null}
            계획 승인
          </button>
          <button disabled={busy} onClick={() => void onRequestPlanRevision(pendingPlanApproval)} type="button">
            계획 수정 요청
          </button>
        </div>
      </div>
    );
  }

  if (repairRequest) {
    if (repairRunningRun) {
      const cancelBusy = busyAction?.key === `cancel:${repairRunningRun.id}`;
      return (
        <div className="next-action-card waiting">
          <div>
            <strong>Targeted repair 실행 중</strong>
            <p>{repairRequest.summary}</p>
          </div>
          <button
            aria-busy={cancelBusy ? true : undefined}
            className={cancelBusy ? "primary-button loading-button is-loading" : "primary-button loading-button"}
            disabled={busy}
            onClick={() => void onCancelHost(repairRunningRun.id)}
            type="button"
          >
            {cancelBusy ? <Loader2 className="loading-icon" size={14} aria-hidden /> : null}
            {cancelBusy ? "중지 중..." : "실행 중지"}
          </button>
        </div>
      );
    }

    if (repairQueuedRun) {
      const hostBusy = busyAction?.key === `host:${repairQueuedRun.id}`;
      return (
        <div className="next-action-card waiting">
          <div>
            <strong>Targeted repair 실행 대기</strong>
            <p>Repair Context Pack이 준비됐습니다. 이 실행은 blocker 하나와 affected files 범위로 제한됩니다.</p>
          </div>
          <button
            aria-busy={hostBusy ? true : undefined}
            className={hostBusy ? "primary-button loading-button is-loading" : "primary-button loading-button"}
            disabled={busy}
            onClick={() => void onRunHost(repairQueuedRun.id)}
            type="button"
          >
            {hostBusy ? <Loader2 className="loading-icon" size={14} aria-hidden /> : null}
            {hostBusy ? "실행 중..." : "repair 실행"}
          </button>
        </div>
      );
    }

    if (repairRunnerReadiness && !repairRunnerReadiness.ready) {
      return (
        <div className="next-action-card waiting">
          <div>
            <strong>{roleLabel(repairRequest.roleId)} repair runner 설정 필요</strong>
            <p>{repairRunnerReadiness.description}</p>
          </div>
          <button className="primary-button" disabled={busy} onClick={onGoSettings} type="button">
            설정 열기
          </button>
        </div>
      );
    }

    const worktreeBusy = busyAction?.key === "worktree";
    if (!worktree) {
      return (
        <div className="next-action-card waiting">
          <div>
            <strong>Repair worktree 준비</strong>
            <p>Targeted repair를 실행할 태스크 전용 branch와 worktree를 먼저 준비합니다.</p>
          </div>
          <button
            aria-busy={worktreeBusy ? true : undefined}
            className={worktreeBusy ? "primary-button loading-button is-loading" : "primary-button loading-button"}
            disabled={busy}
            onClick={() => void onPrepareWorktree()}
            type="button"
          >
            {worktreeBusy ? <Loader2 className="loading-icon" size={14} aria-hidden /> : null}
            {worktreeBusy ? "준비 중..." : "worktree 준비"}
          </button>
        </div>
      );
    }

    const repairBusy = busyAction?.key === `repair:${repairRequest.id}`;
    return (
      <div className="next-action-card waiting">
        <div>
          <strong>Targeted repair 필요</strong>
          <p>{repairRequest.requiredAction}</p>
        </div>
        <button
          aria-busy={repairBusy ? true : undefined}
          className={repairBusy ? "primary-button loading-button is-loading" : "primary-button loading-button"}
          disabled={busy}
          onClick={() => void onPrepareRepair(repairRequest.id)}
          type="button"
        >
          {repairBusy ? <Loader2 className="loading-icon" size={14} aria-hidden /> : null}
          {repairBusy ? "준비 중..." : "repair 준비"}
        </button>
      </div>
    );
  }

  if (task.status === "MergeWaiting") {
    return (
      <div className="next-action-card">
        <div>
          <strong>머지 준비 확인</strong>
          <p>Git 화면에서 diff, branch 상태, merge readiness를 확인합니다.</p>
        </div>
        <button className="primary-button" disabled={busy} onClick={onGoGit} type="button">
          Git에서 보기
        </button>
      </div>
    );
  }

  const action = contextActionFor(task.status);
  if (!action || !runnerReadiness) {
    return (
      <div className="next-action-card">
        <strong>대기 중</strong>
        <p>현재 상태에서 제안할 다음 액션이 없습니다.</p>
      </div>
    );
  }

  if (!runnerReadiness.ready) {
    return (
      <div className="next-action-card waiting">
        <div>
          <strong>{roleLabel(action.roleId)} runner 설정 필요</strong>
          <p>{runnerReadiness.description}</p>
        </div>
        <button className="primary-button" disabled={busy} onClick={onGoSettings} type="button">
          설정 열기
        </button>
      </div>
    );
  }

  const worktreeBusy = busyAction?.key === "worktree";

  if (!worktree) {
    return (
      <div className="next-action-card">
        <div>
          <strong>Worktree 준비</strong>
          <p>실제 role 실행을 위해 태스크 전용 branch와 worktree를 만듭니다.</p>
        </div>
        <button
          aria-busy={worktreeBusy ? true : undefined}
          className={worktreeBusy ? "primary-button loading-button is-loading" : "primary-button loading-button"}
          disabled={busy}
          onClick={() => void onPrepareWorktree()}
          type="button"
        >
          {worktreeBusy ? <Loader2 className="loading-icon" size={14} aria-hidden /> : null}
          {worktreeBusy ? "준비 중..." : "worktree 준비"}
        </button>
      </div>
    );
  }

  if (runningRun) {
    const cancelBusy = busyAction?.key === `cancel:${runningRun.id}`;
    return (
      <div className="next-action-card">
        <div>
          <strong>{roleLabel(runningRun.roleId)} 실행 중</strong>
          <p>조용해 보여도 실행은 계속 유지합니다. 완료/실패 전환은 structured result나 명시 report가 도착했을 때만 처리합니다.</p>
        </div>
        <button
          aria-busy={cancelBusy ? true : undefined}
          className={cancelBusy ? "primary-button loading-button is-loading" : "primary-button loading-button"}
          disabled={busy}
          onClick={() => void onCancelHost(runningRun.id)}
          type="button"
        >
          {cancelBusy ? <Loader2 className="loading-icon" size={14} aria-hidden /> : null}
          {cancelBusy ? "중지 중..." : "실행 중지"}
        </button>
      </div>
    );
  }

  if (queuedRun) {
    const hostBusy = busyAction?.key === `host:${queuedRun.id}`;
    return (
      <div className="next-action-card">
        <div>
          <strong>{roleLabel(action.roleId)} host 실행</strong>
          <p>준비된 Context Pack으로 host runner를 실행합니다.</p>
        </div>
        <button
          aria-busy={hostBusy ? true : undefined}
          className={hostBusy ? "primary-button loading-button is-loading" : "primary-button loading-button"}
          disabled={busy}
          onClick={() => void onRunHost(queuedRun.id)}
          type="button"
        >
          {hostBusy ? <Loader2 className="loading-icon" size={14} aria-hidden /> : null}
          {hostBusy ? "실행 중..." : "host 실행"}
        </button>
      </div>
    );
  }

  if (retryableRun) {
    return (
      <div className="next-action-card waiting">
        <div>
          <strong>{roleLabel(retryableRun.roleId)} 점검 필요</strong>
          <p>최근 실행이 {retryableRun.status} 상태입니다. 타임라인의 gate와 repair 근거를 확인한 뒤 재시도합니다.</p>
        </div>
        <button className="primary-button" disabled={busy} onClick={() => void onRetryHost(retryableRun.id)} type="button">
          retry 준비
        </button>
      </div>
    );
  }

  const prepareBusy = busyAction?.key === `prepare:${action.roleId}`;

  return (
    <div className="next-action-card">
      <div>
        <strong>{action.title}</strong>
        <p>{action.description}</p>
      </div>
      <button
        aria-busy={prepareBusy ? true : undefined}
        className={prepareBusy ? "primary-button loading-button is-loading" : "primary-button loading-button"}
        disabled={busy}
        onClick={() => void onPrepareContext(action.roleId)}
        type="button"
      >
        {prepareBusy ? <Loader2 className="loading-icon" size={14} aria-hidden /> : null}
        {prepareBusy ? "준비 중..." : action.button}
      </button>
    </div>
  );
}

function contextActionFor(status: TaskStatus): {
  roleId: RoleId;
  title: string;
  description: string;
  button: string;
} | null {
  if (status === "Planned" || status === "Blocked") {
    return {
      roleId: "planner",
      title: "계획 컨텍스트 준비",
      description: "Planner가 실행할 Context Pack을 만들고 host 실행 대기 상태로 둡니다.",
      button: "Planner 준비",
    };
  }
  if (status === "Ready") {
    return {
      roleId: "coder",
      title: "구현 컨텍스트 준비",
      description: "Coder가 실행할 Context Pack을 생성합니다.",
      button: "Coder 준비",
    };
  }
  if (status === "Coding") {
    return {
      roleId: "coder",
      title: "구현 실행",
      description: "Coder가 현재 Task 변경을 진행합니다.",
      button: "Coder 준비",
    };
  }
  if (status === "PlanVerification") {
    return {
      roleId: "plan_verifier",
      title: "계획 준수 검토",
      description: "구현 diff가 승인된 계획을 따르는지 검토합니다.",
      button: "계획 검토 준비",
    };
  }
  if (status === "CodeReview") {
    return {
      roleId: "code_reviewer",
      title: "코드 리뷰",
      description: "변경 코드의 위험과 품질 이슈를 검토합니다.",
      button: "리뷰 준비",
    };
  }
  if (status === "Testing") {
    return {
      roleId: "tester",
      title: "테스트 검증",
      description: "설정된 테스트 역할로 변경사항을 검증합니다.",
      button: "테스트 준비",
    };
  }
  return null;
}

function roleForTaskStatus(status: TaskStatus): RoleId | null {
  if (status === "Planned" || status === "Blocked") return "planner";
  if (status === "Ready" || status === "Coding") return "coder";
  if (status === "PlanVerification") return "plan_verifier";
  if (status === "CodeReview") return "code_reviewer";
  if (status === "Testing") return "tester";
  return null;
}

function isRetryableRunStatus(status: AgentRunSummary["status"]): boolean {
  return status === "Failed" || status === "TimedOut" || status === "NeedsInspection" || status === "Canceled";
}

function runStatusSummary(run: AgentRunSummary): string {
  const parts = [run.status];
  if (run.lifecyclePhase) parts.push(run.lifecyclePhase);
  if (run.failureKind) parts.push(run.failureKind);
  else if (run.resultStatus) parts.push(run.resultStatus);
  return parts.join(" · ");
}

function repairRequestsFromTimeline(timeline: TaskTimelineEntry[]): RepairRequestView[] {
  return timeline
    .filter((entry) => entry.entryType === "repair_request")
    .map(repairRequestFromTimelineEntry)
    .filter((repair): repair is RepairRequestView => Boolean(repair))
    .filter((repair) => repair.status === "Open");
}

function repairRequestFromTimelineEntry(entry: TaskTimelineEntry): RepairRequestView | null {
  const metadata: Record<string, unknown> = isRecord(entry.metadata) ? entry.metadata : {};
  const status = stringValue(metadata.status) ?? entry.status ?? "Open";
  const affectedFilesValue = metadata.affectedFiles;
  const affectedFiles = Array.isArray(affectedFilesValue)
    ? affectedFilesValue.filter((item): item is string => typeof item === "string")
    : [];
  const sourceRunId = stringValue(metadata.runId);
  const gateResultId = stringValue(metadata.gateResultId);
  return {
    id: entry.id,
    status,
    severity: stringValue(metadata.severity) ?? "error",
    summary: stringValue(metadata.summary) ?? entry.summary ?? "blocking gate를 해결해야 합니다.",
    requiredAction: stringValue(metadata.requiredAction) ?? "실패 gate의 affected files만 수정한 뒤 재검증합니다.",
    affectedFiles,
    sourceRunId,
    gateResultId,
    roleId: "coder",
    updatedAt: stringValue(metadata.updatedAt),
  };
}

function taskBlockersFor({
  activeRoleId,
  pendingPlanApproval,
  runnerReadiness,
  runEvents,
  runs,
  repairRequests,
  task,
  worktree,
  worktreeError,
}: {
  activeRoleId: RoleId | null;
  pendingPlanApproval: ApprovalSummary | null;
  runnerReadiness: ReturnType<typeof runnerReadinessFor> | null;
  runEvents: Record<string, RunEventSummary[]>;
  runs: AgentRunSummary[];
  repairRequests: RepairRequestView[];
  task: TaskSummary;
  worktree: TaskWorktreeSummary | null;
  worktreeError: string | null;
}): TaskBlocker[] {
  const blockers: TaskBlocker[] = [];

  if (activeRoleId && !pendingPlanApproval && runnerReadiness && !runnerReadiness.ready) {
    blockers.push({
      id: `runner:${activeRoleId}`,
      source: "runner_check",
      kind: runnerReadiness.description.includes("인증") ? "auth_required" : "runner_missing",
      tone: "warning",
      title: `${roleLabel(activeRoleId)} runner 설정 필요`,
      reason: runnerReadiness.description,
      nextStep: "설정 화면에서 연결을 배정하거나 Runner Template을 다시 적용한 뒤 실행을 이어갑니다.",
      actions: [{ kind: "open_settings", label: "설정 열기" }],
    });
  }

  if (!worktree && worktreeError) {
    blockers.push(worktreeErrorBlocker(worktreeError));
  }

  for (const repairRequest of repairRequests.slice(0, 2)) {
    blockers.push({
      id: `repair:${repairRequest.id}`,
      source: "repair_request",
      kind: "gate_failed",
      tone: repairRequest.severity === "error" ? "danger" : "warning",
      title: "Targeted repair 필요",
      reason: repairRequest.summary,
      nextStep: repairRequest.requiredAction,
      actions: [
        { kind: "prepare_repair", label: "repair 준비", repairRequestId: repairRequest.id },
        ...(repairRequest.sourceRunId
          ? [{ kind: "view_events" as const, label: "source events", runId: repairRequest.sourceRunId }]
          : []),
      ],
    });
  }

  const blockedRoles = new Set<string>();
  for (const run of runs) {
    if (!isRetryableRunStatus(run.status) || blockedRoles.has(run.roleId)) continue;
    const blocker = blockerForRun(run, runEvents[run.id] ?? []);
    if (blocker.kind === "worktree_conflict" && blockers.some((item) => item.kind === "worktree_conflict")) {
      continue;
    }
    blockers.push(blocker);
    blockedRoles.add(run.roleId);
  }

  if (task.status === "Blocked" && blockers.length === 0) {
    blockers.push({
      id: `task:${task.id}:blocked`,
      source: "approval",
      kind: "manual_decision",
      tone: "warning",
      title: "사용자 결정 필요",
      reason: task.statusReason ?? "Task가 Blocked 상태입니다.",
      nextStep: "타임라인에서 차단 사유를 확인하고 상태를 되돌리거나 계획을 수정합니다.",
      actions: [],
    });
  }

  return blockers.slice(0, 4);
}

function worktreeErrorBlocker(message: string): TaskBlocker {
  return {
    id: "worktree:last-error",
    source: "worktree",
    kind: hasWorktreeConflict(message) ? "worktree_conflict" : "launch_failed",
    tone: "danger",
    title: hasWorktreeConflict(message) ? "Worktree 경로 충돌" : "Worktree 준비 실패",
    reason: message,
    nextStep: hasWorktreeConflict(message)
      ? "이미 만들어진 작업 디렉터리를 정리하거나 Settings의 worktreeRoot를 다른 위치로 바꾼 뒤 다시 준비합니다."
      : "Git 상태와 worktree 설정을 확인한 뒤 다시 준비합니다.",
    actions: [
      { kind: "open_settings", label: "설정 열기" },
      { kind: "open_git", label: "Git 보기" },
    ],
  };
}

function blockerForRun(run: AgentRunSummary, events: RunEventSummary[]): TaskBlocker {
  const evidence = evidenceFromRun(run, events);
  const baseActions: TaskBlockerAction[] = [
    { kind: "retry", label: "retry 준비", runId: run.id },
    { kind: "view_events", label: "events", runId: run.id },
  ];

  if (run.status === "TimedOut") {
    return {
      id: `run:${run.id}:timeout`,
      source: "agent_run",
      kind: "timeout",
      tone: "danger",
      title: `${roleLabel(run.roleId)} 시간 초과`,
      reason: evidence || `${roleLabel(run.roleId)} 실행이 제한 시간을 넘겨 TimedOut으로 종료됐습니다.`,
      nextStep: "마지막 이벤트와 Context Pack을 확인한 뒤 retry 준비로 새 실행을 만듭니다.",
      actions: baseActions,
    };
  }

  if (hasWorktreeConflict(evidence)) {
    return {
      id: `run:${run.id}:worktree`,
      source: "worktree",
      kind: "worktree_conflict",
      tone: "danger",
      title: "Worktree 경로 충돌",
      reason: evidence,
      nextStep: "중복된 worktree 경로를 정리하거나 Settings의 worktreeRoot를 바꾼 뒤 다시 시도합니다.",
      actions: [
        { kind: "open_settings", label: "설정 열기" },
        { kind: "open_git", label: "Git 보기" },
        { kind: "view_events", label: "events", runId: run.id },
      ],
    };
  }

  if (hasAuthProblem(evidence)) {
    return {
      id: `run:${run.id}:auth`,
      source: "runner_check",
      kind: "auth_required",
      tone: "warning",
      title: `${roleLabel(run.roleId)} 인증 필요`,
      reason: evidence,
      nextStep: "CLI 로그인, 토큰, provider 설정을 확인한 뒤 retry 준비로 이어갑니다.",
      actions: [
        { kind: "open_settings", label: "설정 열기" },
        { kind: "view_events", label: "events", runId: run.id },
      ],
    };
  }

  if (run.status === "NeedsInspection" && hasSchemaProblem(evidence)) {
    return {
      id: `run:${run.id}:schema`,
      source: "agent_run",
      kind: "schema_invalid",
      tone: "warning",
      title: "결과 스키마 점검 필요",
      reason: evidence,
      nextStep: "structured-result.json 형식을 확인하고 runner 출력이 Helm 계약을 지키도록 수정합니다.",
      actions: baseActions,
    };
  }

  if (run.status === "NeedsInspection") {
    return {
      id: `run:${run.id}:gate`,
      source: "agent_run",
      kind: "gate_failed",
      tone: "warning",
      title: `${roleLabel(run.roleId)} gate 점검 필요`,
      reason: evidence || "실행은 끝났지만 pass로 닫히지 않아 NeedsInspection 상태입니다.",
      nextStep: "summary와 gate 근거를 확인한 뒤 retry 준비 또는 계획 수정으로 이어갑니다.",
      actions: baseActions,
    };
  }

  if (run.status === "Canceled") {
    return {
      id: `run:${run.id}:canceled`,
      source: "agent_run",
      kind: "manual_decision",
      tone: "info",
      title: `${roleLabel(run.roleId)} 실행 취소됨`,
      reason: evidence || "사용자 요청이나 외부 중단으로 실행이 Canceled 상태입니다.",
      nextStep: "다시 진행하려면 retry 준비를 눌러 실행 상태를 갱신합니다.",
      actions: baseActions,
    };
  }

  return {
    id: `run:${run.id}:failed`,
    source: "agent_run",
    kind: "launch_failed",
    tone: "danger",
    title: `${roleLabel(run.roleId)} 실행 실패`,
    reason: evidence || "Host runner가 실패 상태로 종료됐습니다.",
    nextStep: "stderr/events에서 실패 원인을 확인한 뒤 runner 설정이나 Context Pack을 수정합니다.",
    actions: baseActions,
  };
}

function evidenceFromRun(run: AgentRunSummary, events: RunEventSummary[]): string {
  const event = [...events]
    .reverse()
    .find((item) => item.message.trim() && item.kind !== "status");
  if (event) return compactEventMessage(event.message);
  if (run.failureReason) return compactEventMessage(run.failureReason);
  if (run.failureKind) return run.failureKind;
  if (run.resultStatus) return `structured result status: ${run.resultStatus}`;
  return "";
}

function hasWorktreeConflict(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("worktree") && (message.includes("이미 존재") || lower.includes("already exists") || lower.includes("path exists"));
}

function hasAuthProblem(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("auth") ||
    lower.includes("login") ||
    lower.includes("unauthorized") ||
    lower.includes("api key") ||
    message.includes("로그인") ||
    message.includes("인증") ||
    message.includes("토큰")
  );
}

function hasSchemaProblem(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("schema") ||
    lower.includes("structured-result") ||
    lower.includes("structured result") ||
    message.includes("스키마")
  );
}

function runActivityFor(run: AgentRunSummary, events: RunEventSummary[]): {
  tone: "live" | "quiet" | "queued" | "done";
  title: string;
  description: string;
} {
  const latestEvent = events.length > 0 ? events[events.length - 1] : null;
  const anchor = latestEvent?.createdAt ?? run.heartbeatAt ?? run.startedAt ?? run.updatedAt ?? run.createdAt;
  const ageMs = ageFromNow(anchor);
  const ageLabel = formatRelativeAge(anchor);

  if (run.status === "Queued") {
    return {
      tone: "queued",
      title: "Worker queue 대기",
      description: `Context Pack은 준비됐고 실행 순서를 기다립니다. 마지막 상태 변경은 ${ageLabel}입니다.`,
    };
  }

  if (run.status === "Running") {
    if (!latestEvent) {
      return {
        tone: "quiet",
        title: "실행 이벤트 대기",
        description: "PTY 실행은 시작됐지만 아직 기록된 이벤트가 없습니다. 완료 여부는 report가 올 때까지 추정하지 않습니다.",
      };
    }

    if (ageMs > RUN_STALE_NOTICE_MS) {
      return {
        tone: "quiet",
        title: "조용하지만 실행 중",
        description: `마지막 이벤트는 ${ageLabel}입니다. Hive 방식처럼 프로세스 활동만으로 완료를 추정하지 않고, structured result/report를 기다립니다.`,
      };
    }

    return {
      tone: "live",
      title: "실행 신호 수신 중",
      description: `마지막 이벤트는 ${ageLabel}입니다. 결과 report가 오면 다음 gate로 이동합니다.`,
    };
  }

  return {
    tone: "done",
    title: "명시 report로 종료",
    description: run.finishedAt
      ? `실행은 ${formatRelativeAge(run.finishedAt)}에 종료됐습니다. 상태 전환은 저장된 result를 기준으로 처리했습니다.`
      : "실행이 종료됐습니다. 상세 근거는 events와 structured-result.json에서 확인할 수 있습니다.",
  };
}

function ageFromNow(value: string | null | undefined): number {
  const time = value ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(time)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Date.now() - time);
}

function formatRelativeAge(value: string | null | undefined): string {
  const time = value ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(time)) return "알 수 없음";
  const diffMs = Math.max(0, Date.now() - time);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diffMs < minute) return "방금 전";
  if (diffMs < hour) return `${Math.floor(diffMs / minute)}분 전`;
  if (diffMs < day) return `${Math.floor(diffMs / hour)}시간 전`;
  return `${Math.floor(diffMs / day)}일 전`;
}

function RunDocumentCard({
  description,
  label,
  name,
  onOpen,
}: {
  description: string;
  label: string;
  name: string;
  onOpen: () => void;
}) {
  return (
    <button className="run-document-card" onClick={onOpen} type="button">
      <span>{label}</span>
      <strong>{name}</strong>
      <small>{description}</small>
    </button>
  );
}

function RunEventPreview({ events }: { events: RunEventSummary[] }) {
  if (events.length === 0) {
    return <p className="run-event-empty">아직 기록된 이벤트가 없습니다. 실행이 시작되면 stdout/stderr/status가 여기에 쌓입니다.</p>;
  }
  return (
    <ol className="run-event-preview" aria-label="최근 실행 이벤트">
      {events.slice(-4).map((event) => (
        <li key={event.id}>
          <span>{event.kind}</span>
          <code>{compactEventMessage(event.message)}</code>
        </li>
      ))}
    </ol>
  );
}

async function evidenceCardsForRuns(projectId: string, runs: AgentRunSummary[]): Promise<EvidenceCard[]> {
  const groups = await Promise.all(runs.map((run) => evidenceCardsForRun(projectId, run)));
  return groups.flat();
}

async function evidenceCardsForRun(projectId: string, run: AgentRunSummary): Promise<EvidenceCard[]> {
  const [resultRaw, changedFilesRaw] = await Promise.all([
    api.readRunArtifact(projectId, run.id, "structured-result.json").catch(() => null),
    api.readRunArtifact(projectId, run.id, "changed-files.json").catch(() => null),
  ]);
  const result = parseJsonRecord(resultRaw);
  const changedFiles = parseChangedFiles(changedFilesRaw);
  const cards: EvidenceCard[] = [];
  const resultSummary = stringValue(result?.summary) ?? run.failureReason ?? run.resultStatus ?? run.status;

  cards.push({
    id: `${run.id}:summary`,
    tone: toneForRun(run),
    label: `${roleLabel(run.roleId)} · ${runStatusSummary(run)}`,
    title: "Run Summary",
    summary: compactEventMessage(resultSummary),
    details: [
      run.startedAt ? `started ${formatRelativeAge(run.startedAt)}` : "",
      run.finishedAt ? `finished ${formatRelativeAge(run.finishedAt)}` : "",
      run.attempt > 1 ? `attempt ${run.attempt}` : "",
    ].filter(Boolean),
    runId: run.id,
  });

  if (run.failureKind || run.failureReason) {
    cards.push({
      id: `${run.id}:blocker`,
      tone: "danger",
      label: "Blocker",
      title: run.failureKind ?? "실행 점검 필요",
      summary: run.failureReason ?? "상세 근거를 확인한 뒤 retry 또는 수정을 진행합니다.",
      details: [run.resultStatus ? `result ${run.resultStatus}` : "", run.lifecyclePhase ? `phase ${run.lifecyclePhase}` : ""].filter(Boolean),
      runId: run.id,
    });
  }

  const gate = isRecord(result?.gateResult) ? result.gateResult : null;
  if (gate) {
    const blocking = Boolean(gate.blocking);
    const gateStatus = stringValue(gate.status) ?? "unknown";
    const blockers = Array.isArray(gate.blockers) ? gate.blockers : [];
    cards.push({
      id: `${run.id}:gate`,
      tone: blocking || gateStatus === "fail" ? "warning" : "success",
      label: "Gate Result",
      title: stringValue(gate.gate) ?? `${roleLabel(run.roleId)} gate`,
      summary: blocking ? "blocking gate가 보고되었습니다." : `gate status: ${gateStatus}`,
      details: blockers.slice(0, 3).map((item) => {
        if (!isRecord(item)) return String(item);
        return stringValue(item.summary) ?? stringValue(item.id) ?? "blocking item";
      }),
      runId: run.id,
    });
  }

  if (changedFiles.length > 0) {
    cards.push({
      id: `${run.id}:files`,
      tone: "info",
      label: "File Changes",
      title: `${changedFiles.length} changed file${changedFiles.length === 1 ? "" : "s"}`,
      summary: changedFiles.slice(0, 3).map((file) => file.path).join(", "),
      details: changedFiles.slice(0, 5).map((file) => `${file.status} ${file.path}`),
      runId: run.id,
    });
  }

  return cards;
}

function parseJsonRecord(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseChangedFiles(raw: string | null): Array<{ path: string; status: string }> {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => {
        if (!isRecord(item)) return null;
        const path = stringValue(item.path);
        if (!path) return null;
        return { path, status: stringValue(item.status) ?? "changed" };
      })
      .filter((item): item is { path: string; status: string } => item !== null);
  } catch {
    return [];
  }
}

function toneForRun(run: AgentRunSummary): EvidenceTone {
  if (run.status === "Succeeded") return "success";
  if (isRetryableRunStatus(run.status)) return "warning";
  if (run.status === "Running" || run.status === "Queued") return "info";
  return "info";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function appendRunEvent(
  current: Record<string, RunEventSummary[]>,
  event: RunEventSummary,
): Record<string, RunEventSummary[]> {
  const events = current[event.runId] ?? [];
  if (events.some((item) => item.id === event.id || item.seq === event.seq)) {
    return current;
  }
  return {
    ...current,
    [event.runId]: [...events, event].sort((left, right) => left.seq - right.seq),
  };
}

function formatRunEvents(events: RunEventSummary[]): string {
  if (events.length === 0) return "아직 기록된 실행 이벤트가 없습니다.";
  return events
    .map((event) => {
      const timestamp = event.createdAt.replace("T", " ").replace(/\.\d+Z$/, "Z");
      return `[${event.seq}] ${timestamp} ${event.kind}\n${event.message}`;
    })
    .join("\n\n");
}

function compactEventMessage(message: string): string {
  const normalized = message.replace(/\s+/g, " ").trim();
  if (normalized.length <= 120) return normalized || "-";
  return `${normalized.slice(0, 117)}...`;
}

function messageFromError(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  if (typeof error === "string") return error;
  return fallback;
}

function timelineTitle(entry: TaskTimelineEntry): string {
  if (entry.entryType === "agent_run") return `Role run · ${entry.title}`;
  if (entry.entryType === "approval") return `Approval · ${entry.title}`;
  if (entry.entryType === "command_evidence") return "Command evidence";
  if (entry.entryType === "gate_result") return `Gate · ${entry.title}`;
  if (entry.entryType === "repair_request") return `Repair · ${entry.title}`;
  return entry.title;
}

function formatTimelineDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
