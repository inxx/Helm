import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { GitBranch, ListChecks, MessageSquare, Settings, SquareTerminal } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "./components/AppShell";
import { api } from "./lib/api";
import { I18nProvider, normalizeLanguage, translate, type AppLanguage } from "./lib/i18n";
import { loadRecents, saveRecents, upsertRecent, type RecentProject } from "./lib/recents";
import type { CommandError, ProjectSnapshot } from "./lib/types";
import { GitScreen } from "./screens/GitScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { SessionsScreen } from "./screens/SessionsScreen";
import { TasksScreen } from "./screens/TasksScreen";
import { TerminalScreen } from "./screens/TerminalScreen";

type Screen = "sessions" | "tasks" | "git" | "terminal" | "settings";
type BootStatus = "restoring" | "ready";

const navItems = [
  { id: "sessions" as const, labelKey: "nav.chat" as const, icon: MessageSquare },
  { id: "tasks" as const, labelKey: "nav.tasks" as const, icon: ListChecks },
  { id: "git" as const, labelKey: "nav.git" as const, icon: GitBranch },
  { id: "terminal" as const, labelKey: "nav.terminal" as const, icon: SquareTerminal },
  { id: "settings" as const, labelKey: "nav.settings" as const, icon: Settings },
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
  const [switchingProjectId, setSwitchingProjectId] = useState<string | null>(null);
  const [language, setLanguage] = useState<AppLanguage>("en");

  const localizedNavItems = useMemo(
    () => navItems.map((item) => ({ ...item, label: translate(language, item.labelKey) })),
    [language],
  );

  useEffect(() => {
    let cancelled = false;

    async function restoreLastProject() {
      setBusy(true);
      try {
        const launch = await api.getLaunchState();
        const settings = await api.getAppSettings().catch(() => null);
        if (cancelled) return;

        if (settings) {
          setLanguage(normalizeLanguage(settings.language));
        }
        setRecents(launch.recentProjects);
        saveRecents(launch.recentProjects);

        if (launch.snapshot) {
          hydrateSnapshot(launch.snapshot, "sessions");
        } else if (launch.restoreError) {
          setError(launch.restoreError.message);
        }
      } catch (err) {
        if (!cancelled) {
          setError(errorMessage(err, language));
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

  async function openProject() {
    setError(null);
    setBusy(true);
    try {
      const path = await open({ directory: true, multiple: false });
      if (typeof path !== "string") return;
      await openProjectPath(path);
    } catch (err) {
      setError(errorMessage(err, language));
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
    setSwitchingProjectId(projectId);
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
      setError(errorMessage(err, language));
    } finally {
      setSwitchingProjectId(null);
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
      setError(errorMessage(err, language));
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
      setError(errorMessage(err, language));
    } finally {
      setBusy(false);
    }
  }

  function applySnapshotUpdate(next: ProjectSnapshot) {
    setSnapshot(next);
  }

  const activeProjectId = switchingProjectId ?? snapshot?.project.id ?? null;

  return (
    <I18nProvider language={language}>
      <AppShell
        navItems={localizedNavItems}
        activeScreen={screen}
        onNavigate={setScreen}
        onOpenProject={openProject}
        recents={recents}
        activeProjectId={activeProjectId}
        onSwitchProject={switchProject}
        onForgetProject={forgetProject}
        busy={busy}
        hideSidebar={screen === "sessions" || screen === "tasks" || screen === "terminal" || screen === "settings"}
      >
        {error ? <div className="error-banner">{error}</div> : null}
        {bootStatus === "restoring" ? (
          <section className="empty-state">
            <h2>{translate(language, "app.restore.title")}</h2>
            <p>{translate(language, "app.restore.description")}</p>
          </section>
        ) : (
          <>
            {screen === "sessions" ? (
              <SessionsScreen
                snapshot={snapshot}
                selectedTaskId={selectedTaskId}
                onSelectTask={setSelectedTaskId}
                onOpenProject={openProject}
                recents={recents}
                activeProjectId={activeProjectId}
                onSwitchProject={switchProject}
                onForgetProject={forgetProject}
                busy={busy}
                onGoTerminal={() => setScreen("terminal")}
                onGoSettings={() => setScreen("settings")}
                onRefresh={refresh}
              />
            ) : null}
            {screen === "tasks" ? (
              <TasksScreen
                snapshot={snapshot}
                selectedTaskId={selectedTaskId}
                onSelectTask={(taskId) => {
                  setSelectedTaskId(taskId);
                }}
                onOpenProject={openProject}
                onRefresh={refresh}
                recents={recents}
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
                  recents={recents}
                  activeProjectId={activeProjectId}
                  onSwitchProject={switchProject}
                  onSnapshotUpdated={applySnapshotUpdate}
                />
              </div>
            ) : null}
            {screen === "settings" ? (
              <SettingsScreen
                snapshot={snapshot}
                onRefresh={refresh}
                onOpenProject={openProject}
                appLanguage={language}
                onAppLanguageChange={setLanguage}
              />
            ) : null}
          </>
        )}
      </AppShell>
    </I18nProvider>
  );
}

function errorMessage(error: unknown, language: AppLanguage): string {
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null && "message" in error) {
    return (error as CommandError).message;
  }
  if (error instanceof Error) return error.message;
  return translate(language, "app.error.unknown");
}
