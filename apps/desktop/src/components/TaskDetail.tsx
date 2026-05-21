import { useEffect, useState } from "react";
import { useToast } from "./ToastProvider";
import { api } from "../lib/api";
import { runnerReadinessFor, roleLabel, type RoleId } from "../lib/runnerReadiness";
import { TASK_STATUS_LABEL, TASK_STATUS_ORDER } from "../lib/status";
import type {
  AgentRunSummary,
  ProjectSnapshot,
  TaskStatus,
  TaskSummary,
  TaskWorktreeSummary,
} from "../lib/types";

type DetailTab = "overview" | "runs" | "git" | "artifacts";

const DETAIL_TABS: Array<{ id: DetailTab; label: string }> = [
  { id: "overview", label: "개요" },
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
  const [busy, setBusy] = useState(false);
  const [runs, setRuns] = useState<AgentRunSummary[]>([]);
  const [worktree, setWorktree] = useState<TaskWorktreeSummary | null>(null);
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
      setWorktree(null);
      return;
    }
    void api.listAgentRuns(snapshot.project.id, task.id).then(setRuns);
    void api.getTaskWorktree(snapshot.project.id, task.id).then(setWorktree);
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
    setBusy(true);
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
      setBusy(false);
    }
  }

  async function runRole(roleId: string) {
    if (!task) return;
    setBusy(true);
    try {
      const run = await api.runStubRole(snapshot.project.id, task.id, roleId);
      const nextRuns = await api.listAgentRuns(snapshot.project.id, task.id);
      setRuns(nextRuns);
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
      setBusy(false);
    }
  }

  async function prepareContext(roleId: string) {
    if (!task) return;
    setBusy(true);
    try {
      await api.prepareRoleContext(snapshot.project.id, task.id, roleId);
      const nextRuns = await api.listAgentRuns(snapshot.project.id, task.id);
      setRuns(nextRuns);
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
      setBusy(false);
    }
  }

  async function prepareWorktree() {
    if (!task) return;
    setBusy(true);
    try {
      const nextWorktree = await api.ensureTaskWorktree(snapshot.project.id, task.id);
      setWorktree(nextWorktree);
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
      setBusy(false);
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

  async function runHost(runId: string) {
    if (!task) return;
    setBusy(true);
    setRuns((current) =>
      current.map((run) => (run.id === runId ? { ...run, status: "Running" } : run)),
    );
    try {
      await api.runHostRole(snapshot.project.id, runId);
      const nextRuns = await api.listAgentRuns(snapshot.project.id, task.id);
      setRuns(nextRuns);
      await onRefresh();
      setActiveTab("artifacts");
      showToast({
        tone: "success",
        title: "Host 실행 완료",
        description: "실행 결과와 태스크 상태를 갱신했습니다.",
      });
    } catch (error) {
      showToast({
        tone: "error",
        title: "Host 실행 실패",
        description: messageFromError(error, "Host role 실행에 실패했습니다."),
      });
    } finally {
      setBusy(false);
    }
  }

  async function retryHost(runId: string) {
    if (!task) return;
    setBusy(true);
    try {
      await api.retryHostRole(snapshot.project.id, runId);
      const nextRuns = await api.listAgentRuns(snapshot.project.id, task.id);
      setRuns(nextRuns);
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
      setBusy(false);
    }
  }

  async function cancelHost(runId: string) {
    if (!task) return;
    setBusy(true);
    try {
      await api.cancelHostRole(snapshot.project.id, runId);
      setRuns((current) =>
        current.map((run) => (run.id === runId ? { ...run, status: "Canceled" } : run)),
      );
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
      setBusy(false);
    }
  }

  const activeRoleId = roleForTaskStatus(task.status);
  const activeRunnerReadiness = activeRoleId ? runnerReadinessFor(snapshot.settings, activeRoleId) : null;
  const activeQueuedRun = activeRoleId
    ? runs.find((run) => run.roleId === activeRoleId && run.status === "Queued") ?? null
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

      <section className="detail-section next-action-panel">
        <h3>다음 액션</h3>
        <NextAction
          busy={busy}
          pendingPlanApproval={Boolean(pendingPlanApproval)}
          task={task}
          worktree={worktree}
          runnerReadiness={activeRunnerReadiness}
          queuedRun={activeQueuedRun}
          onPrepareWorktree={prepareWorktree}
          onPrepareContext={prepareContext}
          onRunHost={runHost}
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
                return (
                  <li className={isCurrentRole ? "role-lane active" : "role-lane"} key={roleId}>
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
                        <button disabled={busy} onClick={prepareWorktree} type="button">
                          worktree 준비
                        </button>
                      ) : null}
                      {isCurrentRole && !needsRunner && !needsWorktree && !latestRun ? (
                        <button
                          disabled={busy}
                          onClick={() => prepareContext(roleId)}
                          type="button"
                        >
                          실행 준비
                        </button>
                      ) : null}
                      {latestRun?.status === "Queued" ? (
                        <>
                          <button onClick={() => showArtifact(latestRun.id, "context-pack.md")} type="button">
                            context
                          </button>
                          <button disabled={busy} onClick={() => runHost(latestRun.id)} type="button">
                            host 실행
                          </button>
                        </>
                      ) : null}
                      {latestRun?.status === "Running" ? (
                        <button onClick={() => cancelHost(latestRun.id)} type="button">
                          cancel
                        </button>
                      ) : null}
                      {latestRun && ["Failed", "TimedOut", "NeedsInspection", "Canceled"].includes(latestRun.status) ? (
                        <button disabled={busy} onClick={() => retryHost(latestRun.id)} type="button">
                          retry
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
                {ROLE_IDS.map((roleId) => (
                  <button disabled={busy} key={`context-${roleId}`} onClick={() => prepareContext(roleId)} type="button">
                    {roleLabel(roleId)} context
                  </button>
                ))}
              </div>
              <div className="role-grid">
                {ROLE_IDS.map((roleId) => (
                  <button disabled={busy} key={`stub-${roleId}`} onClick={() => runRole(roleId)} type="button">
                    {roleLabel(roleId)} stub
                  </button>
                ))}
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
            <button className="secondary-button" disabled={busy} onClick={prepareWorktree} type="button">
              worktree 준비
            </button>
          </section>
        </div>
      ) : null}

      {activeTab === "artifacts" ? (
        <div className="task-console-tab-panel">
          <section className="detail-section">
            <h3>실행 기록</h3>
            {runs.length === 0 ? <p className="muted">아직 실행 기록이 없습니다.</p> : null}
            <ul className="run-list">
              {runs.map((run) => (
                <li key={run.id}>
                  <div>
                    <strong>{roleLabel(run.roleId)}</strong>
                    <span>{run.status} · {run.resultStatus ?? "-"}</span>
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
              ))}
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
  onPrepareWorktree: () => Promise<void>;
  onPrepareContext: (roleId: string) => Promise<void>;
  onRunHost: (runId: string) => Promise<void>;
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
  onPrepareWorktree,
  onPrepareContext,
  onRunHost,
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

  if (!worktree) {
    return (
      <div className="next-action-card">
        <div>
          <strong>Worktree 준비</strong>
          <p>실제 role 실행을 위해 태스크 전용 branch와 worktree를 만듭니다.</p>
        </div>
        <button className="primary-button" disabled={busy} onClick={() => void onPrepareWorktree()} type="button">
          worktree 준비
        </button>
      </div>
    );
  }

  if (queuedRun) {
    return (
      <div className="next-action-card">
        <div>
          <strong>{roleLabel(action.roleId)} host 실행</strong>
          <p>준비된 Context Pack으로 host runner를 실행합니다.</p>
        </div>
        <button className="primary-button" disabled={busy} onClick={() => void onRunHost(queuedRun.id)} type="button">
          host 실행
        </button>
      </div>
    );
  }

  return (
    <div className="next-action-card">
      <div>
        <strong>{action.title}</strong>
        <p>{action.description}</p>
      </div>
      <button
        className="primary-button"
        disabled={busy}
        onClick={() => void onPrepareContext(action.roleId)}
        type="button"
      >
        {action.button}
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

function messageFromError(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  if (typeof error === "string") return error;
  return fallback;
}
