import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { GitBranch, GitPullRequest, ListChecks, MessageSquare, Settings, SquareTerminal, Ticket } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { AppShell } from "./components/AppShell";
import { api } from "./lib/api";
import { I18nProvider, normalizeLanguage, translate, type AppLanguage, type MessageKey } from "./lib/i18n";
import { loadRecents, saveRecents, upsertRecent, type RecentProject } from "./lib/recents";
import type { CommandError, ProjectSnapshot } from "./lib/types";
import { GitScreen } from "./screens/GitScreen";
import { PrScreen } from "./screens/PrScreen";
import { JiraScreen } from "./screens/JiraScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { SessionsScreen } from "./screens/SessionsScreen";
import { TasksScreen } from "./screens/TasksScreen";
import { TerminalScreen } from "./screens/TerminalScreen";

type Screen = "sessions" | "tasks" | "git" | "pr" | "jira" | "terminal" | "settings";
type BootStatus = "restoring" | "ready";

const navItemDefinitions: Array<{ id: Screen; labelKey: MessageKey; icon: typeof MessageSquare }> = [
  { id: "sessions", labelKey: "nav.chat", icon: MessageSquare },
  { id: "tasks", labelKey: "nav.tasks", icon: ListChecks },
  { id: "git", labelKey: "nav.git", icon: GitBranch },
  { id: "pr", labelKey: "nav.pr", icon: GitPullRequest },
  { id: "jira", labelKey: "nav.jira", icon: Ticket },
  { id: "terminal", labelKey: "nav.terminal", icon: SquareTerminal },
  { id: "settings", labelKey: "nav.settings", icon: Settings },
];

export function App() {
  const [screen, setScreen] = useState<Screen>("sessions");
  const [snapshot, setSnapshot] = useState<ProjectSnapshot | null>(null);
  const [recents, setRecents] = useState<RecentProject[]>(() => loadRecents());
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [bootStatus, setBootStatus] = useState<BootStatus>("restoring");
  const [terminalMounted, setTerminalMounted] = useState(false);
  const [language, setLanguage] = useState<AppLanguage>("en");
  const contentScreen = useDeferredValue(screen);
  const navItems = useMemo(
    () =>
      navItemDefinitions.map((item) => ({
        id: item.id,
        label: translate(language, item.labelKey),
        icon: item.icon,
      })),
    [language],
  );

  useEffect(() => {
    let cancelled = false;

    async function restoreLastProject() {
      setBusy(true);
      try {
        const [launch, settings] = await Promise.all([api.getLaunchState(), api.getAppSettings()]);
        if (cancelled) return;

        setLanguage(normalizeLanguage(settings.language));
        setRecents(launch.recentProjects);
        saveRecents(launch.recentProjects);

        if (launch.snapshot) {
          hydrateSnapshot(launch.snapshot, "sessions");
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

  // 핸드오프 watcher는 외부 프로세스로 Tauri 이벤트 없이 DB를 직접 수정하므로
  // 10초마다 스냅샷을 폴링해 태스크/실행 상태를 최신 상태로 유지한다.
  useEffect(() => {
    if (!snapshot) return;
    const projectId = snapshot.project.id;
    const timer = window.setInterval(async () => {
      if (busy) return;
      try {
        const next = await api.getProjectSnapshot(projectId);
        applySnapshotUpdate(next);
      } catch {
        // 폴링 실패는 무시 — 다음 주기에 재시도
      }
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [snapshot?.project.id, busy]);

  function hydrateSnapshot(next: ProjectSnapshot, nextScreen: Screen = "sessions") {
    setSnapshot(next);
    setSelectedTaskId(null);
    setScreen(nextScreen);
    setError(null);
  }

  async function openProject(options: { nextScreen?: Screen } = {}) {
    setError(null);
    setBusy(true);
    try {
      const path = await open({ directory: true, multiple: false });
      if (typeof path !== "string") return;
      await openProjectPath(path, { nextScreen: options.nextScreen });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function openProjectPath(
    path: string,
    options: { preserveRecentPosition?: boolean; nextScreen?: Screen } = {},
  ) {
    const next = await api.openProject(path);
    hydrateSnapshot(next, options.nextScreen ?? "sessions");
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

  async function focusProjectTask(projectId: string, taskId: string, nextScreen: Screen = "tasks") {
    setError(null);
    setBusy(true);
    try {
      if (snapshot?.project.id === projectId) {
        setSelectedTaskId(taskId);
        setScreen(nextScreen);
        return;
      }
      const next = await api.openProjectById(projectId, { reconcileStaleRuns: true });
      setSnapshot(next);
      setSelectedTaskId(taskId);
      setScreen(nextScreen);
      setError(null);
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
        setScreen("sessions");
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

  return (
    <I18nProvider language={language}>
    <AppShell
      navItems={navItems}
      activeScreen={screen}
      onNavigate={setScreen}
    >
      {error ? <div className="error-banner">{error}</div> : null}
      {bootStatus === "restoring" ? (
        <section className="empty-state">
          <h2>{translate(language, "app.restore.title")}</h2>
          <p>{translate(language, "app.restore.description")}</p>
        </section>
      ) : (
        <>
          {contentScreen === "sessions" ? (
            <SessionsScreen
              snapshot={snapshot}
              selectedTaskId={selectedTaskId}
              onSelectTask={setSelectedTaskId}
              onOpenProject={() => void openProject()}
              recents={recents}
              activeProjectId={snapshot?.project.id ?? null}
              onSwitchProject={switchProject}
              onForgetProject={forgetProject}
              busy={busy}
              onGoTerminal={() => setScreen("terminal")}
              onGoSettings={() => setScreen("settings")}
              onRefresh={refresh}
            />
          ) : null}
          {contentScreen === "tasks" ? (
            <TasksScreen
              snapshot={snapshot}
              onOpenTaskChat={(taskId) => {
                setSelectedTaskId(taskId);
                setScreen("sessions");
              }}
              onOpenProject={openProject}
              onGoGit={() => setScreen("git")}
              onGoSettings={() => setScreen("settings")}
              onFocusProjectTask={focusProjectTask}
            />
          ) : null}
          {contentScreen === "git" ? (
            <GitScreen snapshot={snapshot} onOpenProject={() => void openProject()} />
          ) : null}
          {contentScreen === "pr" ? (
            <PrScreen snapshot={snapshot} onOpenProject={() => void openProject()} />
          ) : null}
          {contentScreen === "jira" ? (
            <JiraScreen snapshot={snapshot} onOpenProject={() => void openProject()} />
          ) : null}
          {terminalMounted ? (
            <div
              className={contentScreen === "terminal" ? "screen-host" : "screen-host inactive"}
              aria-hidden={contentScreen !== "terminal"}
            >
              <TerminalScreen
                snapshot={snapshot}
                isActive={contentScreen === "terminal"}
                onOpenProject={() => void openProject({ nextScreen: "terminal" })}
                recents={recents}
                activeProjectId={snapshot?.project.id ?? null}
                onSwitchProject={switchProject}
              />
            </div>
          ) : null}
          {contentScreen === "settings" ? (
            <SettingsScreen
              snapshot={snapshot}
              onRefresh={refresh}
              onOpenProject={() => void openProject()}
              recents={recents}
              activeProjectId={snapshot?.project.id ?? null}
              onSwitchProject={switchProject}
              onForgetProject={forgetProject}
              busy={busy}
              onLanguageChange={setLanguage}
            />
          ) : null}
        </>
      )}
    </AppShell>
    </I18nProvider>
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
