import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { FileText, GitPullRequest, MessageSquareWarning, X } from "lucide-react";
import type {
  AgentRunSummary,
  ApprovalSummary,
  GitFileStatus,
  ProjectSnapshot,
  TaskSummary,
  TaskTimelineEntry,
} from "../lib/types";
import { TaskBoard } from "../components/TaskBoard";
import { api } from "../lib/api";
import { deriveRunLiveState, isRunAttentionState, selectVisibleRun } from "../lib/runLiveState";
import { roleLabel } from "../lib/runnerReadiness";
import { TASK_STATUS_LABEL } from "../lib/status";

interface TasksScreenProps {
  snapshot: ProjectSnapshot | null;
  selectedTask: TaskSummary | null;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string | null) => void;
  onOpenProject: () => void;
  onRefresh: () => Promise<void>;
  onGoPlanning: () => void;
  onGoGit: () => void;
  onGoSettings: () => void;
}

export function TasksScreen({
  snapshot,
  selectedTask,
  selectedTaskId,
  onSelectTask,
  onOpenProject,
  onRefresh: _onRefresh,
  onGoPlanning,
  onGoGit: _onGoGit,
  onGoSettings: _onGoSettings,
}: TasksScreenProps) {
  const [taskRuns, setTaskRuns] = useState<Record<string, AgentRunSummary[]>>({});
  const [runRefreshKey, setRunRefreshKey] = useState(0);
  const taskRunKey = useMemo(
    () => snapshot?.tasks.map((task) => task.id).join(":") ?? "",
    [snapshot?.tasks],
  );

  useEffect(() => {
    if (!snapshot) return;
    let disposed = false;
    let cleanup: (() => void) | null = null;

    void listen<{ projectId?: string }>("agent-run://updated", (event) => {
      if (!disposed && event.payload.projectId === snapshot.project.id) {
        setRunRefreshKey((value) => value + 1);
      }
    }).then((unlisten) => {
      if (disposed) {
        unlisten();
      } else {
        cleanup = unlisten;
      }
    });

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [snapshot?.project.id]);

  useEffect(() => {
    let disposed = false;
    if (!snapshot || snapshot.tasks.length === 0) {
      setTaskRuns({});
      return;
    }

    void (async () => {
      const entries = await Promise.all(
        snapshot.tasks.map(async (task) => {
          try {
            return [task.id, await api.listAgentRuns(snapshot.project.id, task.id)] as const;
          } catch {
            return [task.id, []] as const;
          }
        }),
      );
      if (!disposed) setTaskRuns(Object.fromEntries(entries));
    })();

    return () => {
      disposed = true;
    };
  }, [snapshot?.project.id, taskRunKey, runRefreshKey]);

  if (!snapshot) {
    return (
      <section className="empty-state">
        <h2>프로젝트를 열어주세요</h2>
        <p>Git 저장소를 열면 Helm이 repo-local DB와 작업자 상태 화면을 준비합니다.</p>
        <button className="primary-button" onClick={onOpenProject} type="button">
          프로젝트 열기
        </button>
      </section>
    );
  }

  return (
    <div className={selectedTask ? "tasks-layout with-detail" : "tasks-layout"}>
      <section className="task-workspace">
        <div className="section-header">
          <div>
            <h2>작업자 현황</h2>
            <p>누가 무엇을 진행 중인지, 승인이나 질문 때문에 멈췄는지만 봅니다.</p>
          </div>
          <div className="section-header-actions">
            <button className="primary-button" onClick={onGoPlanning} type="button">
              계획 만들기
            </button>
          </div>
        </div>

        <TaskBoard
          tasks={snapshot.tasks}
          taskRuns={taskRuns}
          selectedTaskId={selectedTaskId}
          onSelectTask={onSelectTask}
        />
      </section>
      {selectedTask ? (
        <TaskFocusDetail
          snapshot={snapshot}
          task={selectedTask}
          runs={taskRuns[selectedTask.id] ?? []}
          onClose={() => onSelectTask(null)}
        />
      ) : null}
    </div>
  );
}

interface TaskFocusDetailProps {
  snapshot: ProjectSnapshot;
  task: TaskSummary;
  runs: AgentRunSummary[];
  onClose: () => void;
}

function TaskFocusDetail({ snapshot, task, runs, onClose }: TaskFocusDetailProps) {
  const [timeline, setTimeline] = useState<TaskTimelineEntry[]>([]);
  const [changedFiles, setChangedFiles] = useState<GitFileStatus[]>([]);
  const [detailError, setDetailError] = useState<string | null>(null);
  const visibleRun = selectVisibleRun(runs);
  const live = visibleRun ? deriveRunLiveState(visibleRun) : null;
  const pendingApprovals = snapshot.approvals.filter(
    (approval) =>
      approval.status === "Pending" &&
      ((approval.entityType === "Task" && approval.entityId === task.id) ||
        (visibleRun && approval.entityType === "AgentRun" && approval.entityId === visibleRun.id)),
  );
  const attentionItems = buildAttentionItems(task, visibleRun, pendingApprovals);
  const markdownRefs = task.externalRefs.filter(
    (ref) => ref.refType === "MarkdownPlan" || ref.refTitle?.toLowerCase().includes("markdown") || ref.refValue.endsWith(".md"),
  );

  useEffect(() => {
    let disposed = false;
    setDetailError(null);
    setTimeline([]);
    setChangedFiles([]);

    void (async () => {
      try {
        const [nextTimeline, nextFiles] = await Promise.all([
          api.listTaskTimeline(snapshot.project.id, task.id),
          api.getTaskWorktreeChangedFiles(snapshot.project.id, task.id).catch(() => []),
        ]);
        if (!disposed) {
          setTimeline(nextTimeline);
          setChangedFiles(nextFiles);
        }
      } catch (error) {
        if (!disposed) setDetailError(messageFromError(error, "상세 정보를 불러오지 못했습니다."));
      }
    })();

    return () => {
      disposed = true;
    };
  }, [snapshot.project.id, task.id]);

  const recentTimeline = timeline.slice(0, 4);

  return (
    <aside className="task-focus-detail" aria-label="작업 상세">
      <header className="task-focus-header">
        <div>
          <span>{TASK_STATUS_LABEL[task.status]}</span>
          <h3>{task.title}</h3>
        </div>
        <button className="icon-button" onClick={onClose} title="닫기" type="button">
          <X size={16} />
        </button>
      </header>

      {detailError ? <div className="error-banner compact">{detailError}</div> : null}

      <section className="focus-section">
        <div className="focus-section-title">
          <GitPullRequest size={16} />
          <h4>현재 작업</h4>
        </div>
        {visibleRun && live ? (
          <div className={`focus-run-card ${live.tone}`}>
            <span>{roleLabel(visibleRun.roleId)} · {live.label}</span>
            <strong>{live.summary}</strong>
            <small>{visibleRun.latestEventMessage ?? visibleRun.resultStatus ?? `최근 신호 ${live.ageLabel}`}</small>
          </div>
        ) : (
          <div className="focus-run-card queued">
            <span>{TASK_STATUS_LABEL[task.status]}</span>
            <strong>{task.statusReason ?? "실행 중인 작업자는 없습니다."}</strong>
            <small>{task.description ? firstLine(task.description) : "대기 중인 작업입니다."}</small>
          </div>
        )}
      </section>

      <section className="focus-section">
        <div className="focus-section-title">
          <MessageSquareWarning size={16} />
          <h4>승인/질문</h4>
        </div>
        {attentionItems.length > 0 ? (
          <ul className="focus-list">
            {attentionItems.map((item) => (
              <li key={item.id}>
                <strong>{item.title}</strong>
                <span>{item.body}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="focus-empty">지금 필요한 승인이나 질문은 없습니다.</p>
        )}
      </section>

      <section className="focus-section">
        <div className="focus-section-title">
          <FileText size={16} />
          <h4>참고 Markdown</h4>
        </div>
        {markdownRefs.length > 0 ? (
          <ul className="focus-list">
            {markdownRefs.map((ref) => (
              <li key={ref.id}>
                <strong>{ref.refTitle ?? "Markdown"}</strong>
                <span>{ref.refValue}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="focus-empty">연결된 Markdown 참조가 없습니다.</p>
        )}
      </section>

      <section className="focus-section">
        <div className="focus-section-title">
          <GitPullRequest size={16} />
          <h4>수정된 파일</h4>
        </div>
        {changedFiles.length > 0 ? (
          <ul className="focus-file-list">
            {changedFiles.map((file) => (
              <li key={`${file.status}:${file.path}`}>
                <strong>{file.status}</strong>
                <span>{file.path}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="focus-empty">Task worktree에서 감지된 변경 파일이 없습니다.</p>
        )}
      </section>

      {recentTimeline.length > 0 ? (
        <section className="focus-section">
          <h4>최근 기록</h4>
          <ul className="focus-list">
            {recentTimeline.map((entry) => (
              <li key={entry.id}>
                <strong>{entry.title}</strong>
                <span>{entry.summary ?? entry.status ?? entry.entryType}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </aside>
  );
}

function buildAttentionItems(
  task: TaskSummary,
  run: AgentRunSummary | null,
  approvals: ApprovalSummary[],
): Array<{ id: string; title: string; body: string }> {
  const items = approvals.map((approval) => ({
    id: approval.id,
    title: approval.approvalType === "PlanApproval" ? "계획 승인 필요" : "실행 승인 필요",
    body: approval.requestedReason,
  }));

  if (task.status === "Blocked") {
    items.push({
      id: `task:${task.id}:blocked`,
      title: "Task 막힘",
      body: task.statusReason ?? "작업을 계속하려면 사용자 결정이 필요합니다.",
    });
  }

  if (run && isRunAttentionState(run)) {
    const live = deriveRunLiveState(run);
    items.push({
      id: `run:${run.id}:attention`,
      title: `${roleLabel(run.roleId)} 확인 필요`,
      body: live.summary,
    });
  }

  return items;
}

function firstLine(value: string): string {
  return value.split("\n").map((line) => line.trim()).find(Boolean) ?? value;
}

function messageFromError(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  if (typeof error === "string") return error;
  return fallback;
}
