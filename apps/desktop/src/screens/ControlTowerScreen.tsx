import { listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useState } from "react";
import { TaskDetail } from "../components/TaskDetail";
import { api } from "../lib/api";
import { deriveControlTowerState, type ControlTowerLane, type ControlTowerRunView } from "../lib/controlTower";
import { roleLabel } from "../lib/runnerReadiness";
import type { AgentRunSummary, ProjectSnapshot, RunEventSummary, TaskSummary } from "../lib/types";

interface ControlTowerScreenProps {
  snapshot: ProjectSnapshot | null;
  selectedTask: TaskSummary | null;
  onSelectTask: (taskId: string | null) => void;
  onOpenProject: () => void;
  onRefresh: () => Promise<void>;
  onGoGit: () => void;
  onGoSettings: () => void;
}

type ChangedFileCounts = Record<string, number | null>;

export function ControlTowerScreen({
  snapshot,
  selectedTask,
  onSelectTask,
  onOpenProject,
  onRefresh,
  onGoGit,
  onGoSettings,
}: ControlTowerScreenProps) {
  const [projectRuns, setProjectRuns] = useState<AgentRunSummary[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [changedFileCounts, setChangedFileCounts] = useState<ChangedFileCounts>({});
  const tasksById = useMemo(() => new Map(snapshot?.tasks.map((task) => [task.id, task]) ?? []), [snapshot?.tasks]);
  const tower = useMemo(() => deriveControlTowerState(projectRuns, now), [projectRuns, now]);
  const visibleRunIds = useMemo(() => {
    const ids = new Set<string>();
    for (const lane of tower.lanes) {
      for (const view of [...lane.activeRuns, ...lane.recentRuns]) ids.add(view.run.id);
    }
    for (const view of tower.attentionRuns) ids.add(view.run.id);
    return [...ids].sort();
  }, [tower]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let disposed = false;
    if (!snapshot) {
      setProjectRuns([]);
      setChangedFileCounts({});
      return;
    }

    void (async () => {
      try {
        setLoadError(null);
        const runs = await api.listProjectRuns(snapshot.project.id, 160);
        if (!disposed) setProjectRuns(runs);
      } catch (error) {
        if (!disposed) setLoadError(messageFromError(error, "관제탑 실행 기록을 불러오지 못했습니다."));
      }
    })();

    return () => {
      disposed = true;
    };
  }, [snapshot?.project.id, refreshKey]);

  useEffect(() => {
    if (!snapshot) return;
    let disposed = false;
    const cleanups: Array<() => void> = [];

    void listen<{ projectId?: string }>("agent-run://updated", (event) => {
      if (event.payload.projectId !== snapshot.project.id) return;
      setRefreshKey((value) => value + 1);
      setNow(Date.now());
    }).then((cleanup) => {
      if (disposed) {
        cleanup();
      } else {
        cleanups.push(cleanup);
      }
    });

    void listen<RunEventSummary>("agent-run://event", (event) => {
      const payload = event.payload;
      if (payload.projectId !== snapshot.project.id) return;
      setProjectRuns((current) => updateRunSignal(current, payload));
      setNow(Date.now());
      if (payload.kind === "status" || payload.kind === "result" || payload.kind === "approval") {
        setRefreshKey((value) => value + 1);
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
  }, [snapshot?.project.id]);

  useEffect(() => {
    let disposed = false;
    if (!snapshot || visibleRunIds.length === 0) return;
    const missingIds = visibleRunIds.filter((runId) => !(runId in changedFileCounts));
    if (missingIds.length === 0) return;

    void (async () => {
      const entries = await Promise.all(
        missingIds.map(async (runId) => {
          const raw = await api.readRunArtifact(snapshot.project.id, runId, "changed-files.json").catch(() => null);
          return [runId, parseChangedFileCount(raw)] as const;
        }),
      );
      if (!disposed) {
        setChangedFileCounts((current) => ({ ...current, ...Object.fromEntries(entries) }));
      }
    })();

    return () => {
      disposed = true;
    };
  }, [changedFileCounts, snapshot?.project.id, visibleRunIds.join(":")]);

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
    <div className={selectedTask ? "control-tower-layout with-detail" : "control-tower-layout"}>
      <section className="control-tower-workspace">
        <div className="section-header">
          <div>
            <h2>관제탑</h2>
            <p>{snapshot.project.name}</p>
          </div>
        </div>

        <CommandStatusBar
          activeRunCount={tower.activeRunCount}
          approvalPendingCount={tower.approvalPendingCount}
          lastSignalAt={tower.lastSignalAt}
          now={now}
        />

        {loadError ? <div className="error-banner compact">{loadError}</div> : null}

        {tower.attentionRuns.length > 0 ? (
          <AttentionStrip
            changedFileCounts={changedFileCounts}
            now={now}
            onOpenRun={(run) => onSelectTask(run.taskId)}
            runs={tower.attentionRuns}
            tasksById={tasksById}
          />
        ) : null}

        <div className="provider-lane-grid">
          {tower.lanes.map((lane) => (
            <ProviderLaneColumn
              changedFileCounts={changedFileCounts}
              key={lane.id}
              lane={lane}
              now={now}
              onOpenRun={(run) => onSelectTask(run.taskId)}
              tasksById={tasksById}
            />
          ))}
        </div>
      </section>

      {selectedTask ? (
        <TaskDetail
          snapshot={snapshot}
          task={selectedTask}
          onRefresh={onRefresh}
          onGoGit={onGoGit}
          onGoSettings={onGoSettings}
          onClose={() => onSelectTask(null)}
        />
      ) : null}
    </div>
  );
}

interface CommandStatusBarProps {
  approvalPendingCount: number;
  activeRunCount: number;
  lastSignalAt: string | null;
  now: number;
}

function CommandStatusBar({ approvalPendingCount, activeRunCount, lastSignalAt, now }: CommandStatusBarProps) {
  return (
    <div className="command-status-bar" aria-label="지휘 현황">
      <MetricPill label="승인 대기" value={`${approvalPendingCount}`} tone={approvalPendingCount > 0 ? "attention" : undefined} />
      <MetricPill label="실행 중" value={`${activeRunCount}`} />
      <MetricPill label="마지막 신호" value={formatRelativeAge(lastSignalAt, now)} />
    </div>
  );
}

function MetricPill({ label, value, tone }: { label: string; value: string; tone?: "attention" }) {
  return (
    <div className={tone ? `command-metric ${tone}` : "command-metric"}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

interface AttentionStripProps {
  runs: ControlTowerRunView[];
  tasksById: Map<string, TaskSummary>;
  changedFileCounts: ChangedFileCounts;
  now: number;
  onOpenRun: (run: AgentRunSummary) => void;
}

function AttentionStrip({ runs, tasksById, changedFileCounts, now, onOpenRun }: AttentionStripProps) {
  return (
    <section className="attention-run-strip" aria-label="확인 필요">
      <div className="attention-strip-heading">
        <span>확인 필요</span>
        <strong>{runs.length}</strong>
      </div>
      <div className="attention-run-list">
        {runs.map((view) => (
          <RunCard
            changedFileCount={changedFileCounts[view.run.id]}
            compact
            key={view.run.id}
            now={now}
            onOpen={() => onOpenRun(view.run)}
            task={tasksById.get(view.run.taskId) ?? null}
            view={view}
          />
        ))}
      </div>
    </section>
  );
}

interface ProviderLaneColumnProps {
  lane: ControlTowerLane;
  tasksById: Map<string, TaskSummary>;
  changedFileCounts: ChangedFileCounts;
  now: number;
  onOpenRun: (run: AgentRunSummary) => void;
}

function ProviderLaneColumn({ lane, tasksById, changedFileCounts, now, onOpenRun }: ProviderLaneColumnProps) {
  return (
    <section className="provider-lane" aria-label={`${lane.label} 레인`}>
      <header className="provider-lane-header">
        <div>
          <h3>{lane.label}</h3>
          <span>{lane.activeRuns.length > 0 ? `실행 ${lane.activeRuns.length}` : "유휴"}</span>
        </div>
      </header>

      <div className="provider-lane-section">
        {lane.activeRuns.length > 0 ? (
          lane.activeRuns.map((view) => (
            <RunCard
              changedFileCount={changedFileCounts[view.run.id]}
              key={view.run.id}
              now={now}
              onOpen={() => onOpenRun(view.run)}
              task={tasksById.get(view.run.taskId) ?? null}
              view={view}
            />
          ))
        ) : (
          <div className="lane-idle-state">유휴</div>
        )}
      </div>

      <div className="provider-lane-recent">
        <span>최근 완료</span>
        {lane.recentRuns.length > 0 ? (
          lane.recentRuns.map((view) => (
            <RunCard
              changedFileCount={changedFileCounts[view.run.id]}
              dimmed
              key={view.run.id}
              now={now}
              onOpen={() => onOpenRun(view.run)}
              task={tasksById.get(view.run.taskId) ?? null}
              view={view}
            />
          ))
        ) : (
          <small>기록 없음</small>
        )}
      </div>
    </section>
  );
}

interface RunCardProps {
  view: ControlTowerRunView;
  task: TaskSummary | null;
  changedFileCount: number | null | undefined;
  now: number;
  onOpen: () => void;
  compact?: boolean;
  dimmed?: boolean;
}

function RunCard({ view, task, changedFileCount, now, onOpen, compact = false, dimmed = false }: RunCardProps) {
  const { run, live } = view;
  const title = task?.title ?? "삭제되었거나 찾을 수 없는 태스크";
  const connectionLabel = run.connectionId ?? run.provider ?? "미분류";
  return (
    <button
      className={`control-run-card ${live.tone}${compact ? " compact" : ""}${dimmed ? " dimmed" : ""}`}
      onClick={onOpen}
      type="button"
    >
      <div className="control-run-card-topline">
        <span>{roleLabel(run.roleId)}</span>
        <span className={`live-state-chip ${live.tone}`}>{live.label}</span>
      </div>
      <strong>{title}</strong>
      <div className="control-run-card-meta">
        <span>{connectionLabel}</span>
        {run.model ? <span>{run.model}</span> : null}
      </div>
      <div className="control-run-card-footer">
        <span>{run.resultStatus ?? run.status}</span>
        <span>{formatRelativeAge(view.signalAt, now)}</span>
        <span>{changedFileLabel(changedFileCount)}</span>
      </div>
      {live.attention ? <small>{live.summary}</small> : null}
    </button>
  );
}

function updateRunSignal(runs: AgentRunSummary[], event: RunEventSummary): AgentRunSummary[] {
  return runs.map((run) =>
    run.id === event.runId
      ? {
          ...run,
          latestEventKind: event.kind,
          latestEventMessage: event.message,
          latestEventAt: event.createdAt,
          updatedAt: event.createdAt,
        }
      : run,
  );
}

function parseChangedFileCount(raw: string | null): number | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.length : null;
  } catch {
    return null;
  }
}

function changedFileLabel(count: number | null | undefined): string {
  if (typeof count === "number") return `변경 파일 ${count}`;
  if (count === null) return "변경 파일 확인 불가";
  return "변경 파일 확인 중";
}

function formatRelativeAge(value: string | null | undefined, now: number): string {
  const time = value ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(time)) return "알 수 없음";
  const diffMs = Math.max(0, now - time);
  if (diffMs < 60_000) return "방금 전";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.floor(hours / 24)}일 전`;
}

function messageFromError(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  if (typeof error === "string") return error;
  return fallback;
}
