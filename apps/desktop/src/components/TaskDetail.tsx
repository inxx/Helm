import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { TASK_STATUS_LABEL, TASK_STATUS_ORDER } from "../lib/status";
import type {
  AgentRunSummary,
  ProjectSnapshot,
  TaskStatus,
  TaskSummary,
  TaskWorktreeSummary,
} from "../lib/types";

interface TaskDetailProps {
  snapshot: ProjectSnapshot;
  task: TaskSummary | null;
  onRefresh: () => Promise<void>;
  onGoGit: () => void;
}

export function TaskDetail({ snapshot, task, onRefresh, onGoGit }: TaskDetailProps) {
  const [status, setStatus] = useState<TaskStatus>("Planned");
  const [busy, setBusy] = useState(false);
  const [runs, setRuns] = useState<AgentRunSummary[]>([]);
  const [worktree, setWorktree] = useState<TaskWorktreeSummary | null>(null);
  const [artifact, setArtifact] = useState<string | null>(null);

  useEffect(() => {
    if (!task) {
      setRuns([]);
      setWorktree(null);
      return;
    }
    void api.listAgentRuns(snapshot.project.id, task.id).then(setRuns);
    void api.getTaskWorktree(snapshot.project.id, task.id).then(setWorktree);
  }, [snapshot.project.id, task]);

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
    setBusy(true);
    await api.updateTaskStatus(snapshot.project.id, task.id, status, "수동 상태 변경");
    await onRefresh();
    setBusy(false);
  }

  async function runRole(roleId: string) {
    if (!task) return;
    setBusy(true);
    await api.runStubRole(snapshot.project.id, task.id, roleId);
    const nextRuns = await api.listAgentRuns(snapshot.project.id, task.id);
    setRuns(nextRuns);
    await onRefresh();
    setBusy(false);
  }

  async function prepareContext(roleId: string) {
    if (!task) return;
    setBusy(true);
    await api.prepareRoleContext(snapshot.project.id, task.id, roleId);
    const nextRuns = await api.listAgentRuns(snapshot.project.id, task.id);
    setRuns(nextRuns);
    await onRefresh();
    setBusy(false);
  }

  async function prepareWorktree() {
    if (!task) return;
    setBusy(true);
    const nextWorktree = await api.ensureTaskWorktree(snapshot.project.id, task.id);
    setWorktree(nextWorktree);
    await onRefresh();
    setBusy(false);
  }

  async function showArtifact(runId: string, artifactName: string) {
    const content = await api.readRunArtifact(snapshot.project.id, runId, artifactName);
    setArtifact(content);
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
    } finally {
      setBusy(false);
    }
  }

  async function retryHost(runId: string) {
    if (!task) return;
    setBusy(true);
    await api.retryHostRole(snapshot.project.id, runId);
    const nextRuns = await api.listAgentRuns(snapshot.project.id, task.id);
    setRuns(nextRuns);
    await onRefresh();
    setBusy(false);
  }

  async function cancelHost(runId: string) {
    if (!task) return;
    await api.cancelHostRole(snapshot.project.id, runId);
    setRuns((current) =>
      current.map((run) => (run.id === runId ? { ...run, status: "Canceled" } : run)),
    );
  }

  return (
    <aside className="detail-panel">
      <div className="detail-header">
        <span className="status-pill">{TASK_STATUS_LABEL[task.status]}</span>
        <h2>{task.title}</h2>
      </div>
      {task.description ? <p>{task.description}</p> : <p className="muted">설명 없음</p>}

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

      <section className="detail-section">
        <h3>상태 변경</h3>
        <div className="inline-form">
          <select value={status} onChange={(event) => setStatus(event.target.value as TaskStatus)}>
            {TASK_STATUS_ORDER.map((nextStatus) => (
              <option key={nextStatus} value={nextStatus}>
                {TASK_STATUS_LABEL[nextStatus]}
              </option>
            ))}
          </select>
          <button disabled={busy} onClick={updateStatus} type="button">
            변경
          </button>
        </div>
      </section>

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

      <section className="detail-section">
        <h3>Context Pack</h3>
        <div className="role-grid">
          {["planner", "coder", "plan_verifier", "code_reviewer", "tester"].map((roleId) => (
            <button disabled={busy} key={roleId} onClick={() => prepareContext(roleId)} type="button">
              {roleLabel(roleId)}
            </button>
          ))}
        </div>
      </section>

      <section className="detail-section">
        <h3>Stub role 실행</h3>
        <div className="role-grid">
          {["planner", "coder", "plan_verifier", "code_reviewer", "tester"].map((roleId) => (
            <button disabled={busy} key={roleId} onClick={() => runRole(roleId)} type="button">
              {roleLabel(roleId)}
            </button>
          ))}
        </div>
      </section>

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
                  <>
                    <button onClick={() => showArtifact(run.id, "context-pack.md")} type="button">context</button>
                    <button disabled={busy} onClick={() => runHost(run.id)} type="button">host 실행</button>
                  </>
                ) : null}
                {run.status === "Running" ? (
                  <button onClick={() => cancelHost(run.id)} type="button">cancel</button>
                ) : null}
                {["Failed", "TimedOut", "NeedsInspection", "Canceled"].includes(run.status) ? (
                  <button disabled={busy} onClick={() => retryHost(run.id)} type="button">retry</button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
        {artifact ? <pre className="artifact-viewer">{artifact}</pre> : null}
      </section>
    </aside>
  );
}

function roleLabel(roleId: string): string {
  const labels: Record<string, string> = {
    planner: "설계자",
    coder: "구현자",
    plan_verifier: "계획 검토자",
    code_reviewer: "코드 리뷰어",
    tester: "테스트 담당자",
  };
  return labels[roleId] ?? roleId;
}
