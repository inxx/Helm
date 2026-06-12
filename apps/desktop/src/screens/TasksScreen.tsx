import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { FileText, GitPullRequest, MessageSquareWarning, Trash2, X } from "lucide-react";
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
import { deriveRunLiveState, isRunActiveState, isRunAttentionState, selectVisibleRun } from "../lib/runLiveState";
import { roleLabel } from "../lib/runnerReadiness";
import { TASK_STATUS_LABEL } from "../lib/status";

interface TasksScreenProps {
  snapshot: ProjectSnapshot | null;
  selectedTask: TaskSummary | null;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string | null) => void;
  onOpenProject: () => void;
  onRefresh: () => Promise<void>;
  onGoGit: () => void;
  onGoSettings: () => void;
}

export function TasksScreen({
  snapshot,
  selectedTask,
  selectedTaskId,
  onSelectTask,
  onOpenProject,
  onRefresh,
  onGoGit: _onGoGit,
  onGoSettings: _onGoSettings,
}: TasksScreenProps) {
  const [taskRuns, setTaskRuns] = useState<Record<string, AgentRunSummary[]>>({});
  const [selectedSessionId, setSelectedSessionId] = useState<string>("all");
  const [runRefreshKey, setRunRefreshKey] = useState(0);
  const taskRunKey = useMemo(
    () => snapshot?.tasks.map((task) => task.id).join(":") ?? "",
    [snapshot?.tasks],
  );
  const sessions = useMemo(
    () => buildTaskSessions(snapshot?.tasks ?? [], taskRuns),
    [snapshot?.tasks, taskRuns],
  );
  const activeSession = sessions.find((session) => session.id === selectedSessionId) ?? sessions[0];
  const visibleTasks = activeSession
    ? snapshot?.tasks.filter((task) => activeSession.taskIds.has(task.id)) ?? []
    : snapshot?.tasks ?? [];
  const visibleTaskRuns = useMemo(() => {
    const visibleIds = new Set(visibleTasks.map((task) => task.id));
    return Object.fromEntries(
      Object.entries(taskRuns).filter(([taskId]) => visibleIds.has(taskId)),
    ) as Record<string, AgentRunSummary[]>;
  }, [taskRuns, visibleTasks]);

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

  useEffect(() => {
    setSelectedSessionId("all");
  }, [snapshot?.project.id]);

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

  const observerSummary = buildWorkspaceObserverSummary(snapshot, visibleTaskRuns, activeSession?.title ?? "전체 세션");

  return (
    <div className={selectedTask ? "tasks-layout with-detail" : "tasks-layout"}>
      <section className="task-workspace">
        <div className="section-header">
          <div>
            <h2>작업자 현황</h2>
            <p>세션별 태스크와 실행 상태만 관찰합니다.</p>
          </div>
        </div>

        <WorkspaceObserverStrip summary={observerSummary} />

        <div className="task-observer-workspace">
          <TaskSessionRail
            sessions={sessions}
            selectedSessionId={activeSession?.id ?? "all"}
            onSelectSession={(sessionId) => {
              setSelectedSessionId(sessionId);
              onSelectTask(null);
            }}
          />
          {visibleTasks.length > 0 ? (
            <TaskBoard
              tasks={visibleTasks}
              taskRuns={visibleTaskRuns}
              selectedTaskId={selectedTaskId}
              onSelectTask={onSelectTask}
            />
          ) : (
            <TaskObserverEmptyState
              project={snapshot.project.name}
              branch={snapshot.repository.currentBranch}
              dirtyCount={snapshot.repository.dirtyCount}
              sessionTitle={activeSession?.title ?? "전체 세션"}
            />
          )}
        </div>
      </section>
      {selectedTask ? (
        <TaskFocusDetail
          snapshot={snapshot}
          task={selectedTask}
          runs={taskRuns[selectedTask.id] ?? []}
          onClose={() => onSelectTask(null)}
          onDeleted={async () => {
            onSelectTask(null);
            await onRefresh();
          }}
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
  onDeleted: () => Promise<void>;
}

function TaskFocusDetail({ snapshot, task, runs, onClose, onDeleted }: TaskFocusDetailProps) {
  const [timeline, setTimeline] = useState<TaskTimelineEntry[]>([]);
  const [changedFiles, setChangedFiles] = useState<GitFileStatus[]>([]);
  const [contextManifest, setContextManifest] = useState<RunContextManifest | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const visibleRun = selectVisibleRun(runs);
  const live = visibleRun ? deriveRunLiveState(visibleRun) : null;
  const hasActiveRun = runs.some(isRunActiveState);
  const canDeleteTask = (task.status === "Done" || task.status === "Merged") && !hasActiveRun;
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
    setContextManifest(null);

    void (async () => {
      try {
        const [nextTimeline, nextFiles, manifestText] = await Promise.all([
          api.listTaskTimeline(snapshot.project.id, task.id),
          api.getTaskWorktreeChangedFiles(snapshot.project.id, task.id).catch(() => []),
          visibleRun
            ? api.readRunArtifact(snapshot.project.id, visibleRun.id, "context-manifest.json").catch(() => null)
            : Promise.resolve(null),
        ]);
        if (!disposed) {
          setTimeline(nextTimeline);
          setChangedFiles(nextFiles);
          setContextManifest(parseRunContextManifest(manifestText));
        }
      } catch (error) {
        if (!disposed) setDetailError(messageFromError(error, "상세 정보를 불러오지 못했습니다."));
      }
    })();

    return () => {
      disposed = true;
    };
  }, [snapshot.project.id, task.id, visibleRun?.id]);

  const recentTimeline = timeline.slice(0, 4);
  const observerSnapshot = buildTaskObserverSnapshot({
    changedFiles,
    live,
    markdownRefs,
    pendingApprovals,
    runs,
    snapshot,
    task,
    timeline,
    visibleRun,
  });

  async function deleteSelectedTask() {
    if (!canDeleteTask || isDeleting) return;
    const confirmed = window.confirm(
      `"${task.title}" 태스크를 Helm DB에서 삭제할까요?\n연결된 run/event/evidence도 함께 삭제됩니다.`,
    );
    if (!confirmed) return;

    setIsDeleting(true);
    setDetailError(null);
    try {
      await api.deleteTask(snapshot.project.id, task.id);
      await onDeleted();
    } catch (error) {
      setDetailError(messageFromError(error, "태스크를 삭제하지 못했습니다."));
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <aside className="task-focus-detail" aria-label="작업 상세">
      <header className="task-focus-header">
        <div>
          <span>{TASK_STATUS_LABEL[task.status]}</span>
          <h3>{task.title}</h3>
        </div>
        <div className="task-focus-actions">
          <button
            className="icon-button danger"
            disabled={!canDeleteTask || isDeleting}
            onClick={() => void deleteSelectedTask()}
            title={canDeleteTask ? "완료 태스크 삭제" : "완료된 태스크만 삭제할 수 있습니다"}
            type="button"
          >
            <Trash2 size={16} />
          </button>
          <button className="icon-button" onClick={onClose} title="닫기" type="button">
            <X size={16} />
          </button>
        </div>
      </header>

      {detailError ? <div className="error-banner compact">{detailError}</div> : null}

      <section className="observer-snapshot-panel" aria-label="Observer Snapshot">
        <div className="observer-snapshot-heading">
          <span>Observer Snapshot</span>
          <strong>{observerSnapshot.headline}</strong>
        </div>
        <div className="observer-snapshot-grid">
          {observerSnapshot.tiles.map((tile) => (
            <div className={`observer-snapshot-tile ${tile.tone ?? ""}`} key={tile.label}>
              <span>{tile.label}</span>
              <strong>{tile.value}</strong>
              <small>{tile.detail}</small>
            </div>
          ))}
        </div>
      </section>

      <RunContextManifestPanel manifest={contextManifest} />

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

interface RunContextManifest {
  referencedMarkdown: string[];
  writtenMarkdown: string[];
  writtenArtifacts: string[];
  git?: {
    before?: {
      branch?: string | null;
      head?: string | null;
      statusText?: string | null;
    };
    after?: {
      branch?: string | null;
      head?: string | null;
      statusText?: string | null;
    };
    changedFiles?: string[];
    diffPath?: string | null;
  };
}

function RunContextManifestPanel({ manifest }: { manifest: RunContextManifest | null }) {
  const referencedMarkdown = manifest?.referencedMarkdown ?? [];
  const writtenMarkdown = manifest?.writtenMarkdown ?? [];
  const writtenArtifacts = manifest?.writtenArtifacts ?? [];
  const changedFiles = manifest?.git?.changedFiles ?? [];
  const branch = manifest?.git?.after?.branch ?? manifest?.git?.before?.branch ?? "unknown";
  const head = manifest?.git?.after?.head ?? manifest?.git?.before?.head ?? null;

  return (
    <section className="focus-section run-context-panel">
      <div className="focus-section-title">
        <FileText size={16} />
        <h4>단계 산출/참조</h4>
      </div>
      {manifest ? (
        <div className="run-context-grid">
          <RunContextList title="참조 Markdown" empty="참조한 Markdown 기록 없음" items={referencedMarkdown} />
          <RunContextList title="작성 Markdown" empty="작성한 Markdown 없음" items={writtenMarkdown} />
          <RunContextList title="작성 Artifact" empty="작성 artifact 없음" items={writtenArtifacts} />
          <RunContextList title="수정 파일" empty="Git 변경 파일 없음" items={changedFiles} />
          <div className="run-context-git">
            <span>Git</span>
            <strong>{branch}</strong>
            <small>{head ? head.slice(0, 12) : "HEAD 정보 없음"}</small>
            <small>{manifest.git?.diffPath ? `diff: ${manifest.git.diffPath}` : "diff 없음"}</small>
          </div>
        </div>
      ) : (
        <p className="focus-empty">이 run에는 context-manifest.json이 아직 없습니다.</p>
      )}
    </section>
  );
}

function RunContextList({ empty, items, title }: { empty: string; items: string[]; title: string }) {
  return (
    <div className="run-context-list">
      <span>{title}</span>
      {items.length > 0 ? (
        <ul>
          {items.slice(0, 6).map((item) => (
            <li key={item}>{item}</li>
          ))}
          {items.length > 6 ? <li>+{items.length - 6} more</li> : null}
        </ul>
      ) : (
        <small>{empty}</small>
      )}
    </div>
  );
}

function parseRunContextManifest(value: string | null): RunContextManifest | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<RunContextManifest>;
    return {
      referencedMarkdown: Array.isArray(parsed.referencedMarkdown) ? parsed.referencedMarkdown.filter(isString) : [],
      writtenMarkdown: Array.isArray(parsed.writtenMarkdown) ? parsed.writtenMarkdown.filter(isString) : [],
      writtenArtifacts: Array.isArray(parsed.writtenArtifacts) ? parsed.writtenArtifacts.filter(isString) : [],
      git: parsed.git,
    };
  } catch {
    return null;
  }
}

function isString(value: unknown): value is string {
  return typeof value === "string";
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

interface WorkspaceObserverSummary {
  activeRuns: number;
  attentionRuns: number;
  pendingApprovals: number;
  dirtyFiles: number;
  sessionTitle: string;
  headline: string;
}

function WorkspaceObserverStrip({ summary }: { summary: WorkspaceObserverSummary }) {
  return (
    <section className="workspace-observer-strip" aria-label="전체 관찰 요약">
      <div className="workspace-observer-copy">
        <span>Observer</span>
        <strong>{summary.headline}</strong>
        <small>{summary.sessionTitle}</small>
      </div>
      <dl>
        <div>
          <dt>active</dt>
          <dd>{summary.activeRuns}</dd>
        </div>
        <div className={summary.attentionRuns > 0 ? "attention" : ""}>
          <dt>attention</dt>
          <dd>{summary.attentionRuns}</dd>
        </div>
        <div className={summary.pendingApprovals > 0 ? "attention" : ""}>
          <dt>approval</dt>
          <dd>{summary.pendingApprovals}</dd>
        </div>
        <div>
          <dt>dirty</dt>
          <dd>{summary.dirtyFiles}</dd>
        </div>
      </dl>
    </section>
  );
}

interface TaskSessionSummary {
  id: string;
  title: string;
  subtitle: string;
  taskIds: Set<string>;
  taskCount: number;
  activeCount: number;
  attentionCount: number;
}

function TaskSessionRail({
  onSelectSession,
  selectedSessionId,
  sessions,
}: {
  onSelectSession: (sessionId: string) => void;
  selectedSessionId: string;
  sessions: TaskSessionSummary[];
}) {
  return (
    <aside className="task-session-rail" aria-label="태스크 세션">
      <div className="task-session-rail-header">
        <span>Sessions</span>
        <strong>{sessions.length}</strong>
      </div>
      <ul>
        {sessions.map((session) => (
          <li key={session.id}>
            <button
              type="button"
              className={session.id === selectedSessionId ? "active" : ""}
              onClick={() => onSelectSession(session.id)}
            >
              <span>{session.title}</span>
              <small>{session.subtitle}</small>
              <em>
                {session.taskCount} tasks
                {session.activeCount > 0 ? ` · ${session.activeCount} active` : ""}
                {session.attentionCount > 0 ? ` · ${session.attentionCount} attention` : ""}
              </em>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}

function TaskObserverEmptyState({
  branch,
  dirtyCount,
  project,
  sessionTitle,
}: {
  branch: string | null;
  dirtyCount: number;
  project: string;
  sessionTitle: string;
}) {
  return (
    <section className="task-observer-empty" aria-label="태스크 없음">
      <div className="task-observer-empty-hero">
        <span>Observer Console</span>
        <h3>관찰할 태스크 세션이 없습니다.</h3>
        <p>Codex Desktop 또는 Hermes가 실행을 시작하고 Task를 기록하면 이 화면에 세션별로 나타납니다.</p>
      </div>
      <dl className="task-observer-empty-grid">
        <div>
          <dt>Project</dt>
          <dd>{project}</dd>
        </div>
        <div>
          <dt>Session</dt>
          <dd>{sessionTitle}</dd>
        </div>
        <div>
          <dt>Branch</dt>
          <dd>{branch ?? "unknown"}</dd>
        </div>
        <div className={dirtyCount > 0 ? "attention" : ""}>
          <dt>Dirty files</dt>
          <dd>{dirtyCount}</dd>
        </div>
      </dl>
      <div className="task-observer-empty-note">
        <strong>다음에 표시될 정보</strong>
        <span>agent 종류, run 상태, stdout/stderr 이벤트, 변경 파일, 승인 대기, 검증 결과</span>
      </div>
    </section>
  );
}

function buildWorkspaceObserverSummary(
  snapshot: ProjectSnapshot,
  taskRuns: Record<string, AgentRunSummary[]>,
  sessionTitle: string,
): WorkspaceObserverSummary {
  const runs = Object.values(taskRuns).flat();
  const activeRuns = runs.filter((run) => ["Queued", "Running"].includes(run.status)).length;
  const attentionRuns = runs.filter(isRunAttentionState).length;
  const pendingApprovals = snapshot.approvals.filter((approval) => approval.status === "Pending").length;
  const dirtyFiles = snapshot.repository.dirtyCount;
  const headline =
    activeRuns > 0
      ? `${activeRuns}개 실행 관찰 중`
      : pendingApprovals > 0
        ? `${pendingApprovals}개 승인 대기`
        : dirtyFiles > 0
          ? `${dirtyFiles}개 변경 파일 감지`
          : "대기 중인 실행 없음";

  return {
    activeRuns,
    attentionRuns,
    pendingApprovals,
    dirtyFiles,
    sessionTitle,
    headline,
  };
}

function buildTaskSessions(
  tasks: TaskSummary[],
  taskRuns: Record<string, AgentRunSummary[]>,
): TaskSessionSummary[] {
  const groups = new Map<string, { title: string; subtitle: string; tasks: TaskSummary[] }>();
  for (const task of tasks) {
    const session = sessionForTask(task);
    const group = groups.get(session.id) ?? { title: session.title, subtitle: session.subtitle, tasks: [] };
    group.tasks.push(task);
    groups.set(session.id, group);
  }

  const sessionSummaries = [...groups.entries()]
    .map(([id, group]) => {
      const taskIds = new Set(group.tasks.map((task) => task.id));
      const runs = group.tasks.flatMap((task) => taskRuns[task.id] ?? []);
      return {
        id,
        title: group.title,
        subtitle: group.subtitle,
        taskIds,
        taskCount: group.tasks.length,
        activeCount: runs.filter((run) => ["Queued", "Running"].includes(run.status)).length,
        attentionCount: runs.filter(isRunAttentionState).length,
      };
    })
    .sort((left, right) => right.taskCount - left.taskCount || left.title.localeCompare(right.title));

  return [
    {
      id: "all",
      title: "전체 세션",
      subtitle: tasks.length > 0 ? "모든 태스크" : "태스크 없음",
      taskIds: new Set(tasks.map((task) => task.id)),
      taskCount: tasks.length,
      activeCount: Object.values(taskRuns).flat().filter((run) => ["Queued", "Running"].includes(run.status)).length,
      attentionCount: Object.values(taskRuns).flat().filter(isRunAttentionState).length,
    },
    ...sessionSummaries,
  ];
}

function sessionForTask(task: TaskSummary): { id: string; title: string; subtitle: string } {
  const markdownRef = task.externalRefs.find((ref) => ref.refType === "MarkdownPlan" || ref.refValue.includes(".helm/planning/"));
  if (markdownRef) {
    const planningId = markdownRef.refValue.match(/\.helm\/planning\/([^/]+)/)?.[1];
    const title = usefulRefTitle(markdownRef.refTitle) ?? titlePrefix(task.title) ?? "계획 세션";
    return {
      id: planningId ? `planning:${planningId}` : `markdown:${markdownRef.refValue}`,
      title,
      subtitle: planningId ? `planning ${planningId.slice(0, 8)}` : markdownRef.refValue,
    };
  }
  if (task.epicId) {
    return {
      id: `epic:${task.epicId}`,
      title: "Epic 태스크",
      subtitle: task.epicId,
    };
  }
  return {
    id: "standalone",
    title: "수동 태스크",
    subtitle: "세션 연결 없음",
  };
}

function usefulRefTitle(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "Plan Document" || trimmed === "Markdown") return null;
  return trimmed;
}

function titlePrefix(title: string): string | null {
  const trimmed = title.trim();
  if (!trimmed) return null;
  const separator = trimmed.match(/[:：-]/);
  if (!separator || separator.index === undefined || separator.index < 8) return trimmed;
  return trimmed.slice(0, separator.index).trim();
}

interface TaskObserverSnapshot {
  headline: string;
  tiles: Array<{
    label: string;
    value: string;
    detail: string;
    tone?: "attention" | "running" | "done";
  }>;
}

function buildTaskObserverSnapshot({
  changedFiles,
  live,
  markdownRefs,
  pendingApprovals,
  runs,
  snapshot,
  task,
  timeline,
  visibleRun,
}: {
  changedFiles: GitFileStatus[];
  live: ReturnType<typeof deriveRunLiveState> | null;
  markdownRefs: TaskSummary["externalRefs"];
  pendingApprovals: ApprovalSummary[];
  runs: AgentRunSummary[];
  snapshot: ProjectSnapshot;
  task: TaskSummary;
  timeline: TaskTimelineEntry[];
  visibleRun: AgentRunSummary | null;
}): TaskObserverSnapshot {
  const headline = visibleRun && live
    ? `${roleLabel(visibleRun.roleId)} · ${live.label}`
    : `${TASK_STATUS_LABEL[task.status]} · 실행자 없음`;
  const activeRunCount = runs.filter((run) => ["Queued", "Running"].includes(run.status)).length;
  const latestTimeline = timeline[0]?.title ?? "기록 없음";

  return {
    headline,
    tiles: [
      {
        label: "단계",
        value: TASK_STATUS_LABEL[task.status],
        detail: live?.summary ?? task.statusReason ?? "현재 task 상태 기준",
        tone: live?.attention ? "attention" : live?.tone === "running" ? "running" : undefined,
      },
      {
        label: "환경",
        value: snapshot.project.name,
        detail: visibleRun?.artifactDir ?? snapshot.project.rootPath,
      },
      {
        label: "문서",
        value: `${markdownRefs.length} refs`,
        detail: markdownRefs[0]?.refValue ?? "연결된 Markdown 없음",
      },
      {
        label: "실행",
        value: `${runs.length} runs`,
        detail: activeRunCount > 0 ? `${activeRunCount}개 실행/대기 중` : latestTimeline,
      },
      {
        label: "파일",
        value: `${changedFiles.length} files`,
        detail: changedFiles[0]?.path ?? "Task worktree 변경 없음",
      },
      {
        label: "승인",
        value: `${pendingApprovals.length} pending`,
        detail: pendingApprovals[0]?.requestedReason ?? "대기 승인 없음",
        tone: pendingApprovals.length > 0 ? "attention" : undefined,
      },
    ],
  };
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
