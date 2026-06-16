import { listen } from "@tauri-apps/api/event";
import { AlertTriangle, GitBranch, KanbanSquare, ListChecks, RefreshCw, ShieldAlert, Table2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { TaskBoard } from "../components/TaskBoard";
import { api } from "../lib/api";
import { deriveControlTowerState } from "../lib/controlTower";
import { shortenPath } from "../lib/recents";
import { deriveRunLiveState, isRunActiveState } from "../lib/runLiveState";
import { TASK_STATUS_LABEL } from "../lib/status";
import type { AgentRunSummary, ControlTowerProjectSummary, TaskSummary } from "../lib/types";

type TowerView = "projects" | "tasks";

interface GlobalControlTowerScreenProps {
  onFocusProject: (projectId: string) => Promise<void>;
  onFocusTask: (projectId: string, taskId: string) => Promise<void>;
  onOpenProject: () => void;
}

interface ProjectView {
  source: ControlTowerProjectSummary;
  attentionRuns: AgentRunSummary[];
  activeRuns: AgentRunSummary[];
  blockedTasks: TaskSummary[];
  activeTasks: TaskSummary[];
  lastSignalAt: string | null;
  health: "attention" | "active" | "dirty" | "idle" | "unavailable";
}

export function GlobalControlTowerScreen({ onFocusProject, onFocusTask, onOpenProject }: GlobalControlTowerScreenProps) {
  const [projects, setProjects] = useState<ControlTowerProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [view, setView] = useState<TowerView>("projects");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  // 핸드오프 watcher는 외부 프로세스로 Tauri 이벤트를 발행하지 않으므로
  // 10초마다 폴링해서 DB 변경을 반영한다.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!loading) setRefreshKey((value) => value + 1);
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [loading]);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setLoadError(null);

    void api
      .listControlTowerProjects(80)
      .then((next) => {
        if (!disposed) setProjects(next);
      })
      .catch((error) => {
        if (!disposed) setLoadError(messageFromError(error, "전체 관제탑을 불러오지 못했습니다."));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });

    return () => {
      disposed = true;
    };
  }, [refreshKey]);

  useEffect(() => {
    let disposed = false;
    const cleanups: Array<() => void> = [];
    void listen("agent-run://updated", () => {
      if (!disposed) {
        setRefreshKey((value) => value + 1);
        setNow(Date.now());
      }
    }).then((cleanup) => {
      if (disposed) cleanup();
      else cleanups.push(cleanup);
    });
    void listen("agent-run://event", () => {
      if (!disposed) setNow(Date.now());
    }).then((cleanup) => {
      if (disposed) cleanup();
      else cleanups.push(cleanup);
    });
    return () => {
      disposed = true;
      cleanups.forEach((cleanup) => cleanup());
    };
  }, []);

  const views = useMemo(() => projects.map((project) => buildProjectView(project, now)), [projects, now]);
  const metrics = useMemo(() => buildGlobalMetrics(views), [views]);
  const attentionItems = useMemo(() => buildAttentionItems(views, now), [views, now]);
  const combined = useMemo(() => buildCombinedTasks(projects), [projects]);

  if (!loading && projects.length === 0) {
    return (
      <section className="empty-state">
        <h2>전체 관제탑을 준비하려면 프로젝트가 필요합니다</h2>
        <p>프로젝트를 추가하면 태스크, 실행, git 상태를 한 화면에서 모아봅니다.</p>
        <button className="primary-button" onClick={onOpenProject} type="button">
          프로젝트 추가
        </button>
      </section>
    );
  }

  return (
    <div className="global-tower-workspace">
      <div className="section-header">
        <div>
          <h2>전체 관제탑</h2>
          <p>최근 프로젝트의 태스크, 실행, git 상태를 한 화면에서 확인합니다.</p>
        </div>
        <div className="section-header-actions">
          <div className="tower-view-toggle" role="group" aria-label="화면 전환">
            <button
              aria-pressed={view === "projects"}
              className={view === "projects" ? "active" : ""}
              onClick={() => setView("projects")}
              type="button"
            >
              <Table2 size={14} />
              <span>프로젝트</span>
            </button>
            <button
              aria-pressed={view === "tasks"}
              className={view === "tasks" ? "active" : ""}
              onClick={() => setView("tasks")}
              type="button"
            >
              <KanbanSquare size={14} />
              <span>전체 태스크 {combined.tasks.length}</span>
            </button>
          </div>
          <button className="secondary-button" disabled={loading} onClick={() => setRefreshKey((value) => value + 1)} type="button">
            <RefreshCw size={14} />
            <span>{loading ? "갱신 중" : "새로고침"}</span>
          </button>
        </div>
      </div>

      <div className="global-tower-metrics" aria-label="전체 현황">
        <GlobalMetric icon={ShieldAlert} label="확인 필요" tone={metrics.attention > 0 ? "attention" : undefined} value={metrics.attention} />
        <GlobalMetric icon={ListChecks} label="진행 태스크" value={metrics.activeTasks} />
        <GlobalMetric icon={GitBranch} label="변경 파일" tone={metrics.dirtyProjects > 0 ? "dirty" : undefined} value={metrics.dirtyFiles} />
        <GlobalMetric icon={AlertTriangle} label="열기 실패" tone={metrics.unavailable > 0 ? "attention" : undefined} value={metrics.unavailable} />
      </div>

      {loadError ? <div className="error-banner compact">{loadError}</div> : null}

      <div className="global-tower-main">
        <section className="global-attention-panel" aria-label="확인 필요">
          <div className="global-panel-heading">
            <span>Attention Inbox</span>
            <strong>{attentionItems.length}</strong>
          </div>
          <div className="global-attention-list">
            {attentionItems.length > 0 ? (
              attentionItems.slice(0, 12).map((item) => (
                <button
                  className={`global-attention-card ${item.tone}`}
                  key={item.id}
                  onClick={() => onFocusProject(item.projectId)}
                  type="button"
                >
                  <span>{item.projectName}</span>
                  <strong>{item.title}</strong>
                  <small>{item.summary}</small>
                </button>
              ))
            ) : (
              <div className="global-empty-panel">지금 바로 확인할 항목이 없습니다.</div>
            )}
          </div>
        </section>

        {view === "tasks" ? (
          <section className="global-task-board-pane" aria-label="전체 태스크">
            <div className="global-panel-heading">
              <span>전체 태스크</span>
              <strong>{combined.tasks.length}</strong>
            </div>
            {combined.tasks.length > 0 ? (
              <div className="global-task-board-scroll">
                <TaskBoard
                  tasks={combined.tasks}
                  taskRuns={combined.taskRuns}
                  projectLabels={combined.projectLabels}
                  selectedTaskId={null}
                  onSelectTask={(taskId) => {
                    const projectId = taskId ? combined.taskProject[taskId] : null;
                    if (taskId && projectId) void onFocusTask(projectId, taskId);
                  }}
                />
              </div>
            ) : (
              <div className="global-empty-panel">합쳐서 볼 태스크가 아직 없습니다.</div>
            )}
          </section>
        ) : (
          <section className="global-project-table" aria-label="프로젝트별 현황">
            <div className="global-project-table-header">
              <span>프로젝트</span>
              <span>태스크</span>
              <span>실행</span>
              <span>Git</span>
              <span>마지막 신호</span>
            </div>
            <div className="global-project-rows">
              {views.map((projectView) => (
                <button
                  className={`global-project-row ${projectView.health}`}
                  key={projectView.source.recent.id}
                  onClick={() => onFocusProject(projectView.source.recent.id)}
                  type="button"
                >
                  <ProjectIdentity view={projectView} />
                  <ProjectTaskCell view={projectView} />
                  <ProjectRunCell view={projectView} />
                  <ProjectGitCell view={projectView} />
                  <span className="global-project-signal">{formatRelativeAge(projectView.lastSignalAt, now)}</span>
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function GlobalMetric({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof ShieldAlert;
  label: string;
  value: number;
  tone?: "attention" | "dirty";
}) {
  return (
    <div className={tone ? `global-metric ${tone}` : "global-metric"}>
      <Icon size={15} />
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ProjectIdentity({ view }: { view: ProjectView }) {
  return (
    <span className="global-project-name">
      <strong>{view.source.snapshot?.project.name ?? view.source.recent.name}</strong>
      <small>{shortenPath(view.source.recent.rootPath)}</small>
    </span>
  );
}

function ProjectTaskCell({ view }: { view: ProjectView }) {
  if (!view.source.snapshot) return <span className="global-project-muted">확인 불가</span>;
  const total = view.source.snapshot.taskCounts.total;
  const blocked = view.blockedTasks.length;
  return (
    <span className="global-project-stack">
      <strong>{view.activeTasks.length} 진행</strong>
      <small>{blocked > 0 ? `${blocked} 막힘 / ${total} 전체` : `${total} 전체`}</small>
    </span>
  );
}

function ProjectRunCell({ view }: { view: ProjectView }) {
  if (view.source.error && view.source.runs.length === 0) return <span className="global-project-muted">실행 확인 실패</span>;
  const topRun = view.attentionRuns[0] ?? view.activeRuns[0] ?? view.source.runs[0];
  if (!topRun) return <span className="global-project-muted">실행 없음</span>;
  const live = deriveRunLiveState(topRun);
  const model = topRun.model ?? topRun.provider;
  return (
    <span className="global-project-stack">
      <strong>{live.label}</strong>
      <small>{model ? `${roleLabel(topRun.roleId)} · ${model}` : roleLabel(topRun.roleId)}</small>
    </span>
  );
}

function ProjectGitCell({ view }: { view: ProjectView }) {
  const repository = view.source.snapshot?.repository;
  if (!repository) return <span className="global-project-muted">확인 불가</span>;
  return (
    <span className="global-project-stack">
      <strong>{repository.currentBranch ?? "detached"}</strong>
      <small>{repository.dirtyCount > 0 ? `${repository.dirtyCount} changed` : "clean"}</small>
    </span>
  );
}

function buildProjectView(source: ControlTowerProjectSummary, now: number): ProjectView {
  const tower = deriveControlTowerState(source.runs, now);
  const attentionRuns = tower.attentionRuns.map((view) => view.run);
  const activeRuns = source.runs.filter(isRunActiveState);
  const tasks = source.snapshot?.tasks ?? [];
  const blockedTasks = tasks.filter((task) => task.status === "Blocked");
  const activeTasks = tasks.filter((task) => task.status !== "Done" && task.status !== "Merged");
  const dirtyCount = source.snapshot?.repository.dirtyCount ?? 0;
  let health: ProjectView["health"] = "idle";
  if (source.error && !source.snapshot) health = "unavailable";
  else if (attentionRuns.length > 0 || blockedTasks.length > 0) health = "attention";
  else if (activeRuns.length > 0) health = "active";
  else if (dirtyCount > 0) health = "dirty";

  return {
    source,
    attentionRuns,
    activeRuns,
    blockedTasks,
    activeTasks,
    lastSignalAt: tower.lastSignalAt,
    health,
  };
}

interface CombinedTasks {
  tasks: TaskSummary[];
  taskRuns: Record<string, AgentRunSummary[]>;
  projectLabels: Record<string, string>;
  taskProject: Record<string, string>;
}

function buildCombinedTasks(projects: ControlTowerProjectSummary[]): CombinedTasks {
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

  return { tasks, taskRuns, projectLabels, taskProject };
}

function buildGlobalMetrics(views: ProjectView[]) {
  return views.reduce(
    (metrics, view) => {
      metrics.attention += view.attentionRuns.length + view.blockedTasks.length;
      metrics.activeTasks += view.activeTasks.length;
      metrics.dirtyFiles += view.source.snapshot?.repository.dirtyCount ?? 0;
      if ((view.source.snapshot?.repository.dirtyCount ?? 0) > 0) metrics.dirtyProjects += 1;
      if (view.health === "unavailable") metrics.unavailable += 1;
      return metrics;
    },
    { activeTasks: 0, attention: 0, dirtyFiles: 0, dirtyProjects: 0, unavailable: 0 },
  );
}

function buildAttentionItems(views: ProjectView[], now: number) {
  return views
    .flatMap((view) => {
      const projectName = view.source.snapshot?.project.name ?? view.source.recent.name;
      const runItems = view.attentionRuns.map((run) => {
        const live = deriveRunLiveState(run, now);
        return {
          id: `${run.id}:run`,
          projectId: view.source.recent.id,
          projectName,
          title: live.label,
          summary: `${roleLabel(run.roleId)} · ${live.summary}`,
          tone: "run",
          timestamp: timestampFor(run.latestEventAt ?? run.heartbeatAt ?? run.updatedAt ?? run.createdAt),
        };
      });
      const taskItems = view.blockedTasks.map((task) => ({
        id: `${task.id}:task`,
        projectId: view.source.recent.id,
        projectName,
        title: TASK_STATUS_LABEL[task.status],
        summary: task.title,
        tone: "task",
        timestamp: timestampFor(task.updatedAt),
      }));
      const errorItems = view.source.error
        ? [
            {
              id: `${view.source.recent.id}:error`,
              projectId: view.source.recent.id,
              projectName,
              title: "프로젝트 확인 실패",
              summary: view.source.error.message,
              tone: "error",
              timestamp: 0,
            },
          ]
        : [];
      return [...runItems, ...taskItems, ...errorItems];
    })
    .sort((left, right) => right.timestamp - left.timestamp);
}

function roleLabel(roleId: string): string {
  const labels: Record<string, string> = {
    planner: "Planner",
    coder: "Coder",
    plan_verifier: "Plan verifier",
    code_reviewer: "Code reviewer",
    tester: "Tester",
  };
  return labels[roleId] ?? roleId;
}

function timestampFor(value: string | null | undefined): number {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatRelativeAge(value: string | null | undefined, now: number): string {
  const time = Date.parse(value ?? "");
  if (!Number.isFinite(time)) return "신호 없음";
  const diffMs = Math.max(0, now - time);
  if (diffMs < 60_000) return "방금 전";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.floor(hours / 24)}일 전`;
}

function messageFromError(error: unknown, fallback: string): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return fallback;
}
