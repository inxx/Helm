import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { Compass, GitBranch, ListChecks, Settings, SquareTerminal } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "./components/AppShell";
import { api } from "./lib/api";
import { loadRecents, saveRecents, upsertRecent, type RecentProject } from "./lib/recents";
import type { CommandError, ProjectSnapshot, TaskSummary } from "./lib/types";
import { GitScreen } from "./screens/GitScreen";
import { PlanningScreen } from "./screens/PlanningScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { TasksScreen } from "./screens/TasksScreen";
import { TerminalScreen } from "./screens/TerminalScreen";

type Screen = "planning" | "tasks" | "git" | "terminal" | "settings";
type BootStatus = "restoring" | "ready";

const navItems = [
  { id: "planning" as const, label: "계획", icon: Compass },
  { id: "tasks" as const, label: "태스크", icon: ListChecks },
  { id: "git" as const, label: "깃", icon: GitBranch },
  { id: "terminal" as const, label: "터미널", icon: SquareTerminal },
  { id: "settings" as const, label: "설정", icon: Settings },
];

export function App() {
  const [screen, setScreen] = useState<Screen>("tasks");
  const [snapshot, setSnapshot] = useState<ProjectSnapshot | null>(null);
  const [recents, setRecents] = useState<RecentProject[]>(() => loadRecents());
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [bootStatus, setBootStatus] = useState<BootStatus>("restoring");
  const [terminalMounted, setTerminalMounted] = useState(false);

  const selectedTask = useMemo<TaskSummary | null>(() => {
    if (!snapshot || !selectedTaskId) return null;
    return snapshot.tasks.find((task) => task.id === selectedTaskId) ?? null;
  }, [selectedTaskId, snapshot]);

  useEffect(() => {
    let cancelled = false;

    async function restoreLastProject() {
      setBusy(true);
      try {
        const launch = await api.getLaunchState();
        if (cancelled) return;

        setRecents(launch.recentProjects);
        saveRecents(launch.recentProjects);

        if (launch.snapshot) {
          hydrateSnapshot(launch.snapshot);
        } else if (launch.restoreError) {
          setError(launch.restoreError.message);
        }
      } catch (err) {
        if (!cancelled) {
          setError(errorMessage(err));
        }
      } finally {
        if (!cancelled) {
          setBusy(false);
          setBootStatus("ready");
        }
      }
    }

    void restoreLastProject();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!snapshot) return;
    let disposed = false;
    let cleanup: (() => void) | null = null;
    void listen<{ projectId?: string }>("agent-run://updated", async (event) => {
      if (disposed || event.payload.projectId !== snapshot.project.id) return;
      try {
        const next = await api.getProjectSnapshot(snapshot.project.id);
        if (!disposed) applySnapshotUpdate(next);
      } catch {
        // Detail panels still receive run events; global refresh is best-effort.
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
    if (screen === "terminal") {
      setTerminalMounted(true);
    }
  }, [screen]);

  function hydrateSnapshot(next: ProjectSnapshot) {
    setSnapshot(next);
    setSelectedTaskId(null);
    setScreen("tasks");
    setError(null);
  }

  async function openProject() {
    setError(null);
    setBusy(true);
    try {
      const path = await open({ directory: true, multiple: false });
      if (typeof path !== "string") return;
      await openProjectPath(path);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function openProjectPath(path: string, options: { preserveRecentPosition?: boolean } = {}) {
    const next = await api.openProject(path);
    hydrateSnapshot(next);
    const nextRecents = upsertRecent(recents, next.project, {
      preserveExistingPosition: options.preserveRecentPosition,
    });
    setRecents(nextRecents);
    saveRecents(nextRecents);
  }

  async function switchProject(projectId: string) {
    setError(null);
    setBusy(true);
    try {
      const next = await api.openProjectById(projectId, { reconcileStaleRuns: true });
      hydrateSnapshot(next);
      const nextRecents = upsertRecent(recents, next.project, {
        preserveExistingPosition: true,
      });
      setRecents(nextRecents);
      saveRecents(nextRecents);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function forgetProject(projectId: string) {
    const recent = recents.find((project) => project.id === projectId);
    if (!recent) return;
    const confirmed = window.confirm(
      `${recent.name} 프로젝트를 목록에서 삭제할까요?\n프로젝트 폴더와 .helm 데이터는 삭제하지 않습니다.`,
    );
    if (!confirmed) return;

    setError(null);
    setBusy(true);
    try {
      const launch = await api.forgetProject(projectId);
      setRecents(launch.recentProjects);
      saveRecents(launch.recentProjects);
      if (snapshot?.project.id === projectId) {
        setSnapshot(null);
        setSelectedTaskId(null);
        setScreen("tasks");
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    if (!snapshot) return;
    setBusy(true);
    try {
      const next = await api.getProjectSnapshot(snapshot.project.id);
      applySnapshotUpdate(next);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function applySnapshotUpdate(next: ProjectSnapshot) {
    setSnapshot(next);
    if (selectedTaskId && !next.tasks.some((task) => task.id === selectedTaskId)) {
      setSelectedTaskId(null);
    }
  }

  function openTask(taskId: string) {
    setSelectedTaskId(taskId);
    setScreen("tasks");
  }

  return (
    <AppShell
      navItems={navItems}
      activeScreen={screen}
      onNavigate={setScreen}
      onOpenProject={openProject}
      recents={recents}
      activeProjectId={snapshot?.project.id ?? null}
      onSwitchProject={switchProject}
      onForgetProject={forgetProject}
      busy={busy}
    >
      {error ? <div className="error-banner">{error}</div> : null}
      {bootStatus === "restoring" ? (
        <section className="empty-state">
          <h2>마지막 프로젝트 여는 중</h2>
          <p>이전에 열었던 Helm 프로젝트와 실행 상태를 확인하고 있습니다.</p>
        </section>
      ) : (
        <>
          {screen === "planning" ? (
            <PlanningScreen
              snapshot={snapshot}
              onOpenProject={openProject}
              onRefresh={refresh}
              onOpenTask={openTask}
            />
          ) : null}
          {screen === "tasks" ? (
            <TasksScreen
              snapshot={snapshot}
              selectedTask={selectedTask}
              selectedTaskId={selectedTaskId}
              onSelectTask={setSelectedTaskId}
              onOpenProject={openProject}
              onRefresh={refresh}
              onGoGit={() => setScreen("git")}
              onGoSettings={() => setScreen("settings")}
            />
          ) : null}
          {screen === "git" ? (
            <GitScreen snapshot={snapshot} onOpenProject={openProject} />
          ) : null}
          {terminalMounted ? (
            <div
              className={screen === "terminal" ? "screen-host" : "screen-host inactive"}
              aria-hidden={screen !== "terminal"}
            >
              <TerminalScreen
                snapshot={snapshot}
                isActive={screen === "terminal"}
                onOpenProject={openProject}
                onSnapshotUpdated={applySnapshotUpdate}
              />
            </div>
          ) : null}
          {screen === "settings" ? (
            <SettingsScreen snapshot={snapshot} onRefresh={refresh} onOpenProject={openProject} />
          ) : null}
        </>
      )}
    </AppShell>
  );
}

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null && "message" in error) {
    return (error as CommandError).message;
  }
  if (error instanceof Error) return error.message;
  return "알 수 없는 오류가 발생했습니다.";
}
