import { open } from "@tauri-apps/plugin-dialog";
import { GitBranch, ListChecks, Settings, SquareTerminal } from "lucide-react";
import { useMemo, useState } from "react";
import { AppShell } from "./components/AppShell";
import { StatusBar } from "./components/StatusBar";
import { api } from "./lib/api";
import type { CommandError, ProjectSnapshot, TaskSummary } from "./lib/types";
import { GitScreen } from "./screens/GitScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { TasksScreen } from "./screens/TasksScreen";
import { TerminalScreen } from "./screens/TerminalScreen";

type Screen = "tasks" | "git" | "terminal" | "settings";

const navItems = [
  { id: "tasks" as const, label: "태스크", icon: ListChecks },
  { id: "git" as const, label: "깃", icon: GitBranch },
  { id: "terminal" as const, label: "터미널", icon: SquareTerminal },
  { id: "settings" as const, label: "설정", icon: Settings },
];

export function App() {
  const [screen, setScreen] = useState<Screen>("tasks");
  const [snapshot, setSnapshot] = useState<ProjectSnapshot | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selectedTask = useMemo<TaskSummary | null>(() => {
    if (!snapshot || !selectedTaskId) return null;
    return snapshot.tasks.find((task) => task.id === selectedTaskId) ?? null;
  }, [selectedTaskId, snapshot]);

  async function openProject() {
    setError(null);
    setBusy(true);
    try {
      const path = await open({ directory: true, multiple: false });
      if (typeof path !== "string") return;
      const next = await api.openProject(path);
      setSnapshot(next);
      setSelectedTaskId(next.tasks[0]?.id ?? null);
      setScreen("tasks");
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
      setSnapshot(next);
      if (selectedTaskId && !next.tasks.some((task) => task.id === selectedTaskId)) {
        setSelectedTaskId(next.tasks[0]?.id ?? null);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell
      navItems={navItems}
      activeScreen={screen}
      onNavigate={setScreen}
      onOpenProject={openProject}
      projectName={snapshot?.project.name ?? null}
      busy={busy}
    >
      {snapshot ? <StatusBar snapshot={snapshot} /> : null}
      {error ? <div className="error-banner">{error}</div> : null}
      {screen === "tasks" ? (
        <TasksScreen
          snapshot={snapshot}
          selectedTask={selectedTask}
          selectedTaskId={selectedTaskId}
          onSelectTask={setSelectedTaskId}
          onOpenProject={openProject}
          onRefresh={refresh}
          onGoGit={() => setScreen("git")}
        />
      ) : null}
      {screen === "git" ? (
        <GitScreen snapshot={snapshot} onOpenProject={openProject} />
      ) : null}
      {screen === "terminal" ? <TerminalScreen snapshot={snapshot} /> : null}
      {screen === "settings" ? <SettingsScreen snapshot={snapshot} onRefresh={refresh} /> : null}
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
