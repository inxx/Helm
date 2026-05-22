import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useToast } from "./ToastProvider";
import { api } from "../lib/api";
import { runnerReadinessFor, roleLabel, type RoleId } from "../lib/runnerReadiness";
import { TASK_STATUS_LABEL, TASK_STATUS_ORDER } from "../lib/status";
import type {
  AgentRunSummary,
  GitFileStatus,
  ProjectSnapshot,
  TaskStatus,
  TaskSummary,
  TaskTimelineEntry,
  TaskWorktreeSummary,
} from "../lib/types";

type DetailTab = "overview" | "timeline" | "runs" | "git" | "artifacts";

const DETAIL_TABS: Array<{ id: DetailTab; label: string }> = [
  { id: "overview", label: "개요" },
  { id: "timeline", label: "타임라인" },
  { id: "runs", label: "실행" },
  { id: "git", label: "Git" },
  { id: "artifacts", label: "산출물" },
];

const ROLE_IDS: RoleId[] = ["planner", "coder", "plan_verifier", "code_reviewer", "tester"];

interface TaskDetailProps {
  snapshot: ProjectSnapshot;
  task: TaskSummary | null;
  onRefresh: () => Promise<void>;
  onGoGit: () => void;
  onGoSettings: () => void;
}

export function TaskDetail({ snapshot, task, onRefresh, onGoGit, onGoSettings }: TaskDetailProps) {
  const { showToast } = useToast();
  const [status, setStatus] = useState<TaskStatus>("Planned");
  const [busyAction, setBusyAction] = useState<{ key: string; label: string } | null>(null);
  const [runs, setRuns] = useState<AgentRunSummary[]>([]);
  const [timeline, setTimeline] = useState<TaskTimelineEntry[]>([]);
  const [worktree, setWorktree] = useState<TaskWorktreeSummary | null>(null);
  const [worktreeFiles, setWorktreeFiles] = useState<GitFileStatus[]>([]);
  const [artifact, setArtifact] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<DetailTab>("overview");
  const pendingPlanApproval = task
    ? snapshot.approvals.find(
        (approval) =>
          approval.entityType === "Task" &&
          approval.entityId === task.id &&
          approval.approvalType === "PlanApproval" &&
          approval.status === "Pending",
      )
    : null;
  const busy = Boolean(busyAction);

  useEffect(() => {
    setStatus(task?.status ?? "Planned");
  }, [task?.status]);

  useEffect(() => {
    setActiveTab("overview");
    setArtifact(null);
  }, [task?.id]);

  useEffect(() => {
    if (!task) {
      setRuns([]);
      setTimeline([]);
      setWorktree(null);
      setWorktreeFiles([]);
      return;
    }
    void api.listAgentRuns(snapshot.project.id, task.id).then(setRuns);
    void api.listTaskTimeline(snapshot.project.id, task.id).then(setTimeline);
    void api.getTaskWorktree(snapshot.project.id, task.id).then((nextWorktree) => {
      setWorktree(nextWorktree);
      void refreshWorktreeFiles(nextWorktree);
    });
  }, [snapshot.project.id, task?.id]);

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

  async function prepareWorktree() {
    if (!task) return;
    setBusyAction({ key: "worktree", label: "Worktree 준비 중" });
    try {
      const nextWorktree = await api.ensureTaskWorktree(snapshot.project.id, task.id);
      setWorktree(nextWorktree);
      await refreshWorktreeFiles(nextWorktree);
      await onRefresh();
      showToast({
        tone: "success",
        title: "Worktree 준비 완료",
        description: nextWorktree.branchName,
      });
    } catch (error) {
      showToast({
        tone: "error",
        title: "Worktree 준비 실패",
        description: messageFromError(error, "태스크 worktree를 준비하지 못했습니다."),
      });
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

  async function runHost(runId: string) {
    if (!task) return;
    const run = runs.find((item) => item.id === runId);
    setBusyAction({ key: `host:${runId}`, label: `${roleLabel(run?.roleId ?? "host")} host 실행 중` });
    setRuns((current) =>
      current.map((run) => (run.id === runId ? { ...run, status: "Running" } : run)),
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

  const activeRoleId = roleForTaskStatus(task.status);
  const activeRunnerReadiness = activeRoleId ? runnerReadinessFor(snapshot.settings, activeRoleId) : null;
  const activeQueuedRun = activeRoleId
    ? runs.find((run) => run.roleId === activeRoleId && run.status === "Queued") ?? null
    : null;
  const activeRetryableRun = activeRoleId
    ? runs.find((run) => run.roleId === activeRoleId && isRetryableRunStatus(run.status)) ?? null
    : null;

  return (
    <aside className="detail-panel task-console">
      <div className="task-console-summary">
        <div className="detail-header">
          <span className="status-pill">{TASK_STATUS_LABEL[task.status]}</span>
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
        <NextAction
          busy={busy}
          pendingPlanApproval={Boolean(pendingPlanApproval)}
          task={task}
          worktree={worktree}
          runnerReadiness={activeRunnerReadiness}
          queuedRun={activeQueuedRun}
          retryableRun={activeRetryableRun}
          busyAction={busyAction}
          onPrepareWorktree={prepareWorktree}
          onPrepareContext={prepareContext}
          onRunHost={runHost}
          onRetryHost={retryHost}
          onGoSettings={onGoSettings}
          onGoGit={onGoGit}
        />
      </section>

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
                          ? `${latestRun.status} · ${latestRun.resultStatus ?? "-"}`
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
            {runs.length === 0 ? <p className="muted">아직 실행 기록이 없습니다.</p> : null}
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
                      {run.status} · {run.resultStatus ?? "-"}
                    </span>
                  </div>
                  <div className="artifact-actions">
                    <button onClick={() => showArtifact(run.id, "summary.md")} type="button">summary</button>
                    <button onClick={() => showArtifact(run.id, "structured-result.json")} type="button">result</button>
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
  pendingPlanApproval: boolean;
  task: TaskSummary;
  worktree: TaskWorktreeSummary | null;
  runnerReadiness: ReturnType<typeof runnerReadinessFor> | null;
  queuedRun: AgentRunSummary | null;
  retryableRun: AgentRunSummary | null;
  busyAction: { key: string; label: string } | null;
  onPrepareWorktree: () => Promise<void>;
  onPrepareContext: (roleId: string) => Promise<void>;
  onRunHost: (runId: string) => Promise<void>;
  onRetryHost: (runId: string) => Promise<void>;
  onGoSettings: () => void;
  onGoGit: () => void;
}

function NextAction({
  busy,
  pendingPlanApproval,
  task,
  worktree,
  runnerReadiness,
  queuedRun,
  retryableRun,
  busyAction,
  onPrepareWorktree,
  onPrepareContext,
  onRunHost,
  onRetryHost,
  onGoSettings,
  onGoGit,
}: NextActionProps) {
  if (pendingPlanApproval) {
    return (
      <div className="next-action-card waiting">
        <strong>계획 승인 대기</strong>
        <p>승인이 완료되면 구현자 역할을 실행할 수 있습니다.</p>
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
        <p>현재 상태에서 자동으로 제안할 다음 액션이 없습니다.</p>
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
  if (status === "Ready") return "coder";
  if (status === "PlanVerification") return "plan_verifier";
  if (status === "CodeReview") return "code_reviewer";
  if (status === "Testing") return "tester";
  return null;
}

function isRetryableRunStatus(status: AgentRunSummary["status"]): boolean {
  return status === "Failed" || status === "TimedOut" || status === "NeedsInspection" || status === "Canceled";
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
