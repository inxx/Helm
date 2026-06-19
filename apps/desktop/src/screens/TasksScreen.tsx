import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Bot, FileText, GitMerge, GitPullRequest, MessageSquareWarning, Trash2, X } from "lucide-react";
import type {
  AgentRunSummary,
  ApprovalSummary,
  ControlTowerProjectSummary,
  GitFileStatus,
  ProjectSnapshot,
  TaskSummary,
  TaskTimelineEntry,
} from "../lib/types";
import { TaskBoard } from "../components/TaskBoard";
import { api } from "../lib/api";
import { deriveRunLiveState, isRunActiveState, isRunAttentionState, selectVisibleRun } from "../lib/runLiveState";
import { roleLabel } from "../lib/runnerReadiness";
import { taskStatusLabel } from "../lib/status";
import { useI18n, type AppLanguage } from "../lib/i18n";

interface TasksScreenProps {
  snapshot: ProjectSnapshot | null;
  selectedTask: TaskSummary | null;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string | null) => void;
  onOpenProject: () => void;
  onRefresh: () => Promise<void>;
  onGoGit: () => void;
  onGoSettings: () => void;
  onFocusProjectTask: (projectId: string, taskId: string) => Promise<void>;
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
  onFocusProjectTask,
}: TasksScreenProps) {
  const { language, t } = useI18n();
  const [taskRuns, setTaskRuns] = useState<Record<string, AgentRunSummary[]>>({});
  const [towerProjects, setTowerProjects] = useState<ControlTowerProjectSummary[]>([]);
  const [towerLoadError, setTowerLoadError] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string>("all");
  const [runRefreshKey, setRunRefreshKey] = useState(0);
  const taskRunKey = useMemo(
    () => snapshot?.tasks.map((task) => task.id).join(":") ?? "",
    [snapshot?.tasks],
  );
  const combined = useMemo(() => buildCombinedTasks(towerProjects, snapshot, taskRuns), [snapshot, taskRuns, towerProjects]);
  const sessions = useMemo(() => buildTaskSessions(combined.tasks, combined.taskRuns, language), [combined, language]);
  const activeSession = sessions.find((session) => session.id === selectedSessionId) ?? sessions[0];
  const visibleTasks = activeSession
    ? combined.tasks.filter((task) => activeSession.taskIds.has(task.id)) ?? []
    : combined.tasks;
  const visibleTaskRuns = useMemo(() => {
    const visibleIds = new Set(visibleTasks.map((task) => task.id));
    return Object.fromEntries(
      Object.entries(combined.taskRuns).filter(([taskId]) => visibleIds.has(taskId)),
    ) as Record<string, AgentRunSummary[]>;
  }, [combined.taskRuns, visibleTasks]);

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

  useEffect(() => {
    let disposed = false;
    setTowerLoadError(null);
    void api
      .listControlTowerProjects(80)
      .then((projects) => {
        if (!disposed) setTowerProjects(projects);
      })
      .catch((error) => {
        if (!disposed) {
          setTowerProjects([]);
          setTowerLoadError(messageFromError(error, language === "ko" ? "통합 태스크 목록을 불러오지 못했습니다." : "Could not load the unified task list."));
        }
      });
    return () => {
      disposed = true;
    };
  }, [snapshot?.project.id, taskRunKey, runRefreshKey]);

  if (!snapshot) {
    return (
      <section className="empty-state">
        <h2>{t("tasks.emptyProject.title")}</h2>
        <p>{t("tasks.emptyProject.description")}</p>
        <button className="primary-button" onClick={onOpenProject} type="button">
          {t("tasks.openProject")}
        </button>
      </section>
    );
  }

  const observerSummary = buildWorkspaceObserverSummary(snapshot, visibleTaskRuns, activeSession?.title ?? t("tasks.board.allProjects"), t);

  return (
    <div className={selectedTask ? "tasks-layout with-detail" : "tasks-layout"}>
      <section className="task-workspace">
        <div className="section-header">
          <div>
            <h2>{t("tasks.board.title")}</h2>
            <p>{t("tasks.board.description")}</p>
          </div>
        </div>

        <WorkspaceObserverStrip summary={observerSummary} />
        {towerLoadError ? <div className="error-banner compact">{towerLoadError}</div> : null}

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
              projectLabels={combined.projectLabels}
              selectedTaskId={selectedTaskId}
              onSelectTask={(taskId) => {
                if (!taskId) {
                  onSelectTask(null);
                  return;
                }
                const projectId = combined.taskProject[taskId];
                if (projectId && projectId !== snapshot.project.id) {
                  void onFocusProjectTask(projectId, taskId);
                  return;
                }
                onSelectTask(taskId);
              }}
            />
          ) : (
            <TaskObserverEmptyState
              project={snapshot.project.name}
              branch={snapshot.repository.currentBranch}
              dirtyCount={snapshot.repository.dirtyCount}
              sessionTitle={activeSession?.title ?? (language === "ko" ? "전체 세션" : "All sessions")}
              language={language}
            />
          )}
        </div>
      </section>
      {selectedTask ? (
        <TaskFocusDetail
          snapshot={snapshot}
          task={selectedTask}
          runs={combined.taskRuns[selectedTask.id] ?? taskRuns[selectedTask.id] ?? []}
          onClose={() => onSelectTask(null)}
          onRefresh={onRefresh}
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
  onRefresh: () => Promise<void>;
  onDeleted: () => Promise<void>;
}

function TaskFocusDetail({ snapshot, task, runs, onClose, onRefresh, onDeleted }: TaskFocusDetailProps) {
  const { language } = useI18n();
  const [timeline, setTimeline] = useState<TaskTimelineEntry[]>([]);
  const [changedFiles, setChangedFiles] = useState<GitFileStatus[]>([]);
  const [contextManifest, setContextManifest] = useState<RunContextManifest | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isApproving, setIsApproving] = useState(false);
  const [approvalNotice, setApprovalNotice] = useState<string | null>(null);
  const visibleRun = selectVisibleRun(runs);
  const live = visibleRun ? deriveRunLiveState(visibleRun) : null;
  const hasActiveRun = runs.some(isRunActiveState);
  const canDeleteTask = (task.status === "Done" || task.status === "Merged") && !hasActiveRun;
  const canApproveCompletion = task.status === "MergeWaiting" && !hasActiveRun;
  const pendingApprovals = snapshot.approvals.filter(
    (approval) =>
      approval.status === "Pending" &&
      ((approval.entityType === "Task" && approval.entityId === task.id) ||
        (visibleRun && approval.entityType === "AgentRun" && approval.entityId === visibleRun.id)),
  );
  const attentionItems = buildAttentionItems(task, visibleRun, pendingApprovals, language);
  const markdownRefs = task.externalRefs.filter(
    (ref) => ref.refType === "MarkdownPlan" || ref.refTitle?.toLowerCase().includes("markdown") || ref.refValue.endsWith(".md"),
  );
  const markdownItems = buildMarkdownItems(markdownRefs, contextManifest);

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
    language,
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

  async function approveCompletion() {
    if (!canApproveCompletion || isApproving) return;
    const confirmed = window.confirm(
      `"${task.title}" 작업을 완료 승인할까요?\nworktree 변경사항을 커밋하고 origin에 push합니다.`,
    );
    if (!confirmed) return;

    setIsApproving(true);
    setDetailError(null);
    setApprovalNotice(null);
    try {
      const result = await api.approveTaskCompletionWithGit(snapshot.project.id, task.id);
      setApprovalNotice(
        `${result.branchName} 커밋 ${result.commitHash.slice(0, 12)}` +
          (result.pushed ? " · origin push 완료" : " · push 미완료"),
      );
      await onRefresh();
    } catch (error) {
      setDetailError(messageFromError(error, "작업 완료 승인에 실패했습니다."));
    } finally {
      setIsApproving(false);
    }
  }

  return (
    <aside className="task-focus-detail" aria-label="작업 상세">
      <header className="task-focus-header">
        <div>
          <span>{taskStatusLabel(task.status, language)}</span>
          <h3>{task.title}</h3>
        </div>
        <div className="task-focus-actions">
          {canApproveCompletion ? (
            <button
              className="primary-button compact"
              disabled={isApproving}
              onClick={() => void approveCompletion()}
              title="worktree 변경을 커밋하고 origin에 push합니다"
              type="button"
            >
              <GitMerge size={16} />
              {isApproving ? "승인 중…" : "완료 승인 · 커밋 push"}
            </button>
          ) : null}
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
      {approvalNotice ? <div className="success-banner compact">{approvalNotice}</div> : null}

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
          <Bot size={16} />
          <h4>실행 AI</h4>
        </div>
        {visibleRun ? (
          <div className="focus-runner-card">
            <span>{roleLabel(visibleRun.roleId, language)}</span>
            <strong>{runnerDisplayName(visibleRun)}</strong>
            <small>{runnerDetail(visibleRun)}</small>
          </div>
        ) : (
          <p className="focus-empty">아직 실행자가 배정되지 않았습니다.</p>
        )}
      </section>

      <section className="focus-section">
        <div className="focus-section-title">
          <GitPullRequest size={16} />
          <h4>현재 작업</h4>
        </div>
        {visibleRun && live ? (
          <div className={`focus-run-card ${live.tone}`}>
            <span>{roleLabel(visibleRun.roleId, language)} · {live.label}</span>
            <strong>{live.summary}</strong>
            <small>{visibleRun.latestEventMessage ?? visibleRun.resultStatus ?? (language === "ko" ? `최근 신호 ${live.ageLabel}` : `Latest signal ${live.ageLabel}`)}</small>
          </div>
        ) : (
          <div className="focus-run-card queued">
            <span>{taskStatusLabel(task.status, language)}</span>
            <strong>{task.statusReason ?? (language === "ko" ? "실행 중인 작업자는 없습니다." : "No runner is active.")}</strong>
            <small>{task.description ? firstLine(task.description) : language === "ko" ? "대기 중인 작업입니다." : "Waiting for work to start."}</small>
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
        {markdownItems.length > 0 ? (
          <ul className="focus-list">
            {markdownItems.map((item) => (
              <li key={`${item.source}:${item.path}`}>
                <strong>{item.title}</strong>
                <span>{item.path}</span>
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
  language: AppLanguage,
): Array<{ id: string; title: string; body: string }> {
  const items = approvals.map((approval) => ({
    id: approval.id,
    title: approval.approvalType === "PlanApproval"
      ? language === "ko" ? "계획 승인 필요" : "Plan approval required"
      : language === "ko" ? "실행 승인 필요" : "Execution approval required",
    body: approval.requestedReason,
  }));

  if (task.status === "Blocked") {
    items.push({
      id: `task:${task.id}:blocked`,
      title: language === "ko" ? "Task 막힘" : "Task blocked",
      body: task.statusReason ?? (language === "ko" ? "작업을 계속하려면 사용자 결정이 필요합니다." : "A user decision is required to continue."),
    });
  }

  if (run && isRunAttentionState(run)) {
    const live = deriveRunLiveState(run);
    items.push({
      id: `run:${run.id}:attention`,
      title: language === "ko" ? `${roleLabel(run.roleId, language)} 확인 필요` : `${roleLabel(run.roleId, language)} needs attention`,
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
  const { t } = useI18n();
  return (
    <section className="workspace-observer-strip" aria-label={t("tasks.observer.aria")}>
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

interface CombinedTasks {
  tasks: TaskSummary[];
  taskRuns: Record<string, AgentRunSummary[]>;
  projectLabels: Record<string, string>;
  taskProject: Record<string, string>;
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
  language,
  project,
  sessionTitle,
}: {
  branch: string | null;
  dirtyCount: number;
  language: AppLanguage;
  project: string;
  sessionTitle: string;
}) {
  return (
    <section className="task-observer-empty" aria-label={language === "ko" ? "태스크 없음" : "No tasks"}>
      <div className="task-observer-empty-hero">
        <span>Observer Console</span>
        <h3>{language === "ko" ? "관찰할 태스크 세션이 없습니다." : "No task sessions to observe."}</h3>
        <p>
          {language === "ko"
            ? "Codex Desktop 또는 Hermes가 실행을 시작하고 Task를 기록하면 이 화면에 세션별로 나타납니다."
            : "Sessions will appear here when Codex Desktop or Hermes starts a run and records tasks."}
        </p>
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
        <strong>{language === "ko" ? "다음에 표시될 정보" : "What will appear next"}</strong>
        <span>
          {language === "ko"
            ? "agent 종류, run 상태, stdout/stderr 이벤트, 변경 파일, 승인 대기, 검증 결과"
            : "agent type, run status, stdout/stderr events, changed files, approvals, verification results"}
        </span>
      </div>
    </section>
  );
}

function buildWorkspaceObserverSummary(
  snapshot: ProjectSnapshot,
  taskRuns: Record<string, AgentRunSummary[]>,
  sessionTitle: string,
  t: ReturnType<typeof useI18n>["t"],
): WorkspaceObserverSummary {
  const runs = Object.values(taskRuns).flat();
  const activeRuns = runs.filter((run) => ["Queued", "Running"].includes(run.status)).length;
  const attentionRuns = runs.filter(isRunAttentionState).length;
  const pendingApprovals = snapshot.approvals.filter((approval) => approval.status === "Pending").length;
  const dirtyFiles = snapshot.repository.dirtyCount;
  const headline =
    activeRuns > 0
      ? t("tasks.observer.activeRuns", { count: activeRuns })
      : pendingApprovals > 0
        ? t("tasks.observer.pendingApprovals", { count: pendingApprovals })
        : dirtyFiles > 0
          ? t("tasks.observer.dirtyFiles", { count: dirtyFiles })
          : t("tasks.observer.idle");

  return {
    activeRuns,
    attentionRuns,
    pendingApprovals,
    dirtyFiles,
    sessionTitle,
    headline,
  };
}

function buildCombinedTasks(
  projects: ControlTowerProjectSummary[],
  fallbackSnapshot: ProjectSnapshot | null,
  fallbackTaskRuns: Record<string, AgentRunSummary[]>,
): CombinedTasks {
  const tasks: TaskSummary[] = [];
  const taskRuns: Record<string, AgentRunSummary[]> = {};
  const projectLabels: Record<string, string> = {};
  const taskProject: Record<string, string> = {};

  for (const project of projects) {
    const snapshot = project.snapshot;
    if (!snapshot) continue;
    projectLabels[snapshot.project.id] = snapshot.project.name;
    for (const task of snapshot.tasks) {
      tasks.push(task);
      taskProject[task.id] = snapshot.project.id;
    }
    for (const run of project.runs) {
      (taskRuns[run.taskId] ??= []).push(run);
    }
  }

  if (tasks.length === 0 && fallbackSnapshot) {
    projectLabels[fallbackSnapshot.project.id] = fallbackSnapshot.project.name;
    for (const task of fallbackSnapshot.tasks) {
      tasks.push(task);
      taskProject[task.id] = fallbackSnapshot.project.id;
      taskRuns[task.id] = fallbackTaskRuns[task.id] ?? [];
    }
  }

  return { tasks, taskRuns, projectLabels, taskProject };
}

function buildTaskSessions(
  tasks: TaskSummary[],
  taskRuns: Record<string, AgentRunSummary[]>,
  language: AppLanguage,
): TaskSessionSummary[] {
  const groups = new Map<string, { title: string; subtitle: string; tasks: TaskSummary[] }>();
  for (const task of tasks) {
    const session = sessionForTask(task, language);
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
      title: language === "ko" ? "전체 세션" : "All sessions",
      subtitle: tasks.length > 0 ? (language === "ko" ? "모든 태스크" : "All tasks") : language === "ko" ? "태스크 없음" : "No tasks",
      taskIds: new Set(tasks.map((task) => task.id)),
      taskCount: tasks.length,
      activeCount: Object.values(taskRuns).flat().filter((run) => ["Queued", "Running"].includes(run.status)).length,
      attentionCount: Object.values(taskRuns).flat().filter(isRunAttentionState).length,
    },
    ...sessionSummaries,
  ];
}

function sessionForTask(task: TaskSummary, language: AppLanguage): { id: string; title: string; subtitle: string } {
  const markdownRef = task.externalRefs.find((ref) => ref.refType === "MarkdownPlan" || ref.refValue.includes(".helm/planning/"));
  if (markdownRef) {
    const planningId = markdownRef.refValue.match(/\.helm\/planning\/([^/]+)/)?.[1];
    const title = usefulRefTitle(markdownRef.refTitle) ?? titlePrefix(task.title) ?? (language === "ko" ? "계획 세션" : "Planning session");
    return {
      id: planningId ? `planning:${planningId}` : `markdown:${markdownRef.refValue}`,
      title,
      subtitle: planningId ? `planning ${planningId.slice(0, 8)}` : markdownRef.refValue,
    };
  }
  if (task.epicId) {
    return {
      id: `epic:${task.epicId}`,
      title: language === "ko" ? "Epic 태스크" : "Epic tasks",
      subtitle: task.epicId,
    };
  }
  return {
    id: "standalone",
    title: language === "ko" ? "수동 태스크" : "Manual tasks",
    subtitle: language === "ko" ? "세션 연결 없음" : "No linked session",
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
  language,
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
  language: AppLanguage;
}): TaskObserverSnapshot {
  const headline = visibleRun && live
    ? `${roleLabel(visibleRun.roleId, language)} · ${live.label}`
    : `${taskStatusLabel(task.status, language)} · ${language === "ko" ? "실행자 없음" : "No runner"}`;
  const activeRunCount = runs.filter((run) => ["Queued", "Running"].includes(run.status)).length;
  const latestTimeline = timeline[0]?.title ?? (language === "ko" ? "기록 없음" : "No history");
  const runnerName = visibleRun ? runnerDisplayName(visibleRun) : language === "ko" ? "실행자 없음" : "No runner";
  const runnerMeta = visibleRun ? runnerDetail(visibleRun) : language === "ko" ? "run 없음" : "No run";

  return {
    headline,
    tiles: [
      {
        label: language === "ko" ? "단계" : "Stage",
        value: taskStatusLabel(task.status, language),
        detail: live?.summary ?? task.statusReason ?? (language === "ko" ? "현재 task 상태 기준" : "Based on current task status"),
        tone: live?.attention ? "attention" : live?.tone === "running" ? "running" : undefined,
      },
      {
        label: language === "ko" ? "환경" : "Environment",
        value: snapshot.project.name,
        detail: visibleRun?.artifactDir ?? snapshot.project.rootPath,
      },
      {
        label: "AI",
        value: runnerName,
        detail: runnerMeta,
        tone: live?.tone === "running" ? "running" : undefined,
      },
      {
        label: language === "ko" ? "문서" : "Docs",
        value: `${markdownRefs.length} refs`,
        detail: markdownRefs[0]?.refValue ?? (language === "ko" ? "연결된 Markdown 없음" : "No linked Markdown"),
      },
      {
        label: language === "ko" ? "실행" : "Runs",
        value: `${runs.length} runs`,
        detail: activeRunCount > 0 ? (language === "ko" ? `${activeRunCount}개 실행/대기 중` : `${activeRunCount} running/queued`) : latestTimeline,
      },
      {
        label: language === "ko" ? "파일" : "Files",
        value: `${changedFiles.length} files`,
        detail: changedFiles[0]?.path ?? (language === "ko" ? "Task worktree 변경 없음" : "No task worktree changes"),
      },
      {
        label: language === "ko" ? "승인" : "Approvals",
        value: `${pendingApprovals.length} pending`,
        detail: pendingApprovals[0]?.requestedReason ?? (language === "ko" ? "대기 승인 없음" : "No pending approvals"),
        tone: pendingApprovals.length > 0 ? "attention" : undefined,
      },
    ],
  };
}

interface MarkdownItem {
  title: string;
  path: string;
  source: string;
}

function buildMarkdownItems(
  refs: TaskSummary["externalRefs"],
  manifest: RunContextManifest | null,
): MarkdownItem[] {
  const items = new Map<string, MarkdownItem>();
  for (const ref of refs) {
    items.set(ref.refValue, {
      title: ref.refTitle ?? "Markdown",
      path: ref.refValue,
      source: "task-ref",
    });
  }
  for (const path of manifest?.referencedMarkdown ?? []) {
    if (!items.has(path)) {
      items.set(path, { title: "Run 참조 Markdown", path, source: "manifest-ref" });
    }
  }
  return Array.from(items.values());
}

function runnerDisplayName(run: AgentRunSummary): string {
  return run.model ?? run.provider ?? run.connectionId ?? "알 수 없음";
}

function runnerDetail(run: AgentRunSummary): string {
  const parts = [
    run.provider ? `provider ${run.provider}` : null,
    run.model ? `model ${run.model}` : null,
    run.connectionId ? `connection ${run.connectionId}` : null,
    run.attempt > 1 ? `attempt ${run.attempt}` : null,
  ].filter(Boolean);
  return parts.join(" · ");
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
