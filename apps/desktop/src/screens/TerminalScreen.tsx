import { open } from "@tauri-apps/plugin-dialog";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  Cpu,
  Folder,
  FolderOpen,
  GitBranch,
  Plus,
  RotateCcw,
  SplitSquareHorizontal,
  SquareTerminal,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type {
  GitBranchSummary,
  NodeRuntimeSummary,
  ProjectSnapshot,
  TerminalDirectoryEntry,
} from "../lib/types";

interface TerminalScreenProps {
  snapshot: ProjectSnapshot | null;
  isActive: boolean;
  onOpenProject: () => void;
  onSnapshotUpdated: (snapshot: ProjectSnapshot) => void;
}

interface TerminalPaneState {
  id: string;
  cwd: string;
  nodeBinPath: string | null;
  running: boolean;
  error: string | null;
  exitCode: number | null;
}

interface TerminalPtyOutput {
  terminalId: string;
  data: string;
}

interface TerminalPtyExit {
  terminalId: string;
  exitCode: number;
}

function createPane(cwd: string, nodeBinPath: string | null): TerminalPaneState {
  return {
    id: crypto.randomUUID(),
    cwd,
    nodeBinPath,
    running: false,
    error: null,
    exitCode: null,
  };
}

export function TerminalScreen({
  snapshot,
  isActive,
  onOpenProject,
  onSnapshotUpdated,
}: TerminalScreenProps) {
  const [selectedNodeBinPath, setSelectedNodeBinPath] = useState<string | null>(null);
  const [panes, setPanes] = useState<TerminalPaneState[]>(() =>
    snapshot ? [createPane(snapshot.project.rootPath, null)] : [],
  );
  const [activePaneId, setActivePaneId] = useState<string | null>(panes[0]?.id ?? null);
  const [nodeRuntimes, setNodeRuntimes] = useState<NodeRuntimeSummary[]>([]);
  const [branches, setBranches] = useState<GitBranchSummary[]>([]);
  const [directoryEntries, setDirectoryEntries] = useState<TerminalDirectoryEntry[]>([]);
  const [controlError, setControlError] = useState<string | null>(null);
  const [branchBusy, setBranchBusy] = useState(false);
  const paneRefs = useRef(new Map<string, HTMLElement>());
  const terminalRefs = useRef(new Map<string, HTMLDivElement>());
  const xtermRefs = useRef(new Map<string, XTerm>());
  const inputDisposers = useRef(new Map<string, { dispose: () => void }>());
  const resizeObservers = useRef(new Map<string, ResizeObserver>());
  const isActiveRef = useRef(isActive);

  const selectedPaneId = activePaneId ?? panes[0]?.id ?? null;
  const activePane = panes.find((pane) => pane.id === selectedPaneId) ?? panes[0] ?? null;
  const usesSplitScroll = panes.length >= 5;

  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);

  useEffect(() => {
    if (!snapshot) return;
    const restoredNodeBinPath = loadTerminalNodeSelection(snapshot.project.id);
    setSelectedNodeBinPath(restoredNodeBinPath);
    disposeAllPanes();
    const firstPane = createPane(snapshot.project.rootPath, restoredNodeBinPath);
    setPanes([firstPane]);
    setActivePaneId(firstPane.id);
  }, [snapshot?.project.id]);

  useEffect(() => {
    let cancelled = false;

    void api
      .listNodeRuntimes()
      .then((nextRuntimes) => {
        if (!cancelled) setNodeRuntimes(nextRuntimes);
      })
      .catch((err) => {
        if (!cancelled) setControlError(errorMessage(err));
      });

    return () => {
      cancelled = true;
    };
  }, [snapshot?.project.id]);

  useEffect(() => {
    let cancelled = false;

    if (!snapshot) {
      setBranches([]);
      return;
    }

    void api
      .getLocalBranches(snapshot.project.id)
      .then((nextBranches) => {
        if (!cancelled) setBranches(nextBranches);
      })
      .catch((err) => {
        if (!cancelled) setControlError(errorMessage(err));
      });

    return () => {
      cancelled = true;
    };
  }, [snapshot]);

  useEffect(() => {
    let cancelled = false;

    if (!snapshot || !activePane) {
      setDirectoryEntries([]);
      return;
    }

    void api
      .listTerminalDirectories(snapshot.project.id, activePane.cwd)
      .then((entries) => {
        if (!cancelled) setDirectoryEntries(entries);
      })
      .catch((err) => {
        if (!cancelled) setControlError(errorMessage(err));
      });

    return () => {
      cancelled = true;
    };
  }, [activePane?.cwd, snapshot?.project.id]);

  useEffect(() => {
    let cancelled = false;
    let unlistenOutput: UnlistenFn | null = null;
    let unlistenExit: UnlistenFn | null = null;

    async function bindEvents() {
      unlistenOutput = await listen<TerminalPtyOutput>("terminal://output", (event) => {
        const terminal = xtermRefs.current.get(event.payload.terminalId);
        terminal?.write(event.payload.data);
      });
      unlistenExit = await listen<TerminalPtyExit>("terminal://exit", (event) => {
        void api.stopTerminalPty(event.payload.terminalId).catch(() => undefined);
        setPanes((current) =>
          current.map((pane) =>
            pane.id === event.payload.terminalId
              ? { ...pane, running: false, exitCode: event.payload.exitCode }
              : pane,
          ),
        );
      });

      if (cancelled) {
        unlistenOutput?.();
        unlistenExit?.();
      }
    }

    void bindEvents();
    return () => {
      cancelled = true;
      unlistenOutput?.();
      unlistenExit?.();
    };
  }, []);

  useEffect(() => {
    if (!snapshot || !isActive) return;
    for (const pane of panes) {
      ensureTerminal(pane);
    }
  }, [panes, snapshot?.project.id, isActive]);

  useEffect(() => {
    if (!isActive) return;
    requestAnimationFrame(() => {
      for (const pane of panes) {
        resizePane(pane.id);
      }
      if (selectedPaneId) {
        xtermRefs.current.get(selectedPaneId)?.focus();
      }
    });
  }, [isActive, panes.length, selectedPaneId]);

  useEffect(() => {
    if (!isActive || !selectedPaneId) return;
    paneRefs.current.get(selectedPaneId)?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
      inline: "start",
    });
    xtermRefs.current.get(selectedPaneId)?.focus();
  }, [selectedPaneId, panes.length, isActive]);

  useEffect(() => {
    return () => disposeAllPanes();
  }, []);

  function setPaneRef(id: string, node: HTMLElement | null) {
    if (node) paneRefs.current.set(id, node);
    else paneRefs.current.delete(id);
  }

  function setTerminalRef(id: string, node: HTMLDivElement | null) {
    if (node) terminalRefs.current.set(id, node);
    else terminalRefs.current.delete(id);
  }

  if (!snapshot) {
    return (
      <section className="empty-state">
        <h2>터미널</h2>
        <p>프로젝트를 먼저 열어주세요.</p>
        <button className="primary-button" onClick={onOpenProject} type="button">
          프로젝트 열기
        </button>
      </section>
    );
  }

  const repository = snapshot.repository;
  const activeCwd = activePane?.cwd ?? snapshot.project.rootPath;
  const directoryOptions = withCurrentDirectoryOption(directoryEntries, activeCwd);
  const selectedRuntimeMissing =
    selectedNodeBinPath !== null &&
    !nodeRuntimes.some((runtime) => runtime.binPath === selectedNodeBinPath);

  function updatePane(id: string, patch: Partial<TerminalPaneState>) {
    setPanes((current) => current.map((pane) => (pane.id === id ? { ...pane, ...patch } : pane)));
  }

  function addPane() {
    const nextPane = createPane(
      activePane?.cwd ?? snapshot?.project.rootPath ?? "",
      selectedNodeBinPath,
    );
    setPanes((current) => [...current, nextPane]);
    setActivePaneId(nextPane.id);
  }

  async function restartPane(pane: TerminalPaneState, patch: Partial<TerminalPaneState> = {}) {
    const nextPane = { ...pane, ...patch };
    disposePane(pane.id, { stopPty: true });
    updatePane(pane.id, { ...patch, running: false, error: null, exitCode: null });
    requestAnimationFrame(() => ensureTerminal(nextPane));
  }

  async function chooseNodeRuntime(nextNodeBinPath: string | null) {
    setControlError(null);
    setSelectedNodeBinPath(nextNodeBinPath);
    if (snapshot) saveTerminalNodeSelection(snapshot.project.id, nextNodeBinPath);

    if (!activePane) return;
    updatePane(activePane.id, { nodeBinPath: nextNodeBinPath });

    if (nextNodeBinPath && activePane.running) {
      void api.writeTerminalPty(activePane.id, nodeRuntimeExportCommand(nextNodeBinPath)).catch((err) => {
        updatePane(activePane.id, { error: errorMessage(err) });
      });
      return;
    }

    await restartPane(activePane, { nodeBinPath: nextNodeBinPath });
  }

  async function chooseDirectory(path: string) {
    if (!snapshot) return;
    const baseCwd = activePane?.cwd ?? snapshot.project.rootPath;
    setControlError(null);
    try {
      const resolved = await api.resolveTerminalCwd(snapshot.project.id, baseCwd, path);
      if (activePane) {
        await restartPane(activePane, { cwd: resolved });
      } else {
        const nextPane = createPane(resolved, selectedNodeBinPath);
        setPanes([nextPane]);
        setActivePaneId(nextPane.id);
      }
    } catch (err) {
      setControlError(errorMessage(err));
    }
  }

  async function browseDirectory() {
    setControlError(null);
    try {
      const path = await open({ directory: true, multiple: false });
      if (typeof path !== "string") return;
      await chooseDirectory(path);
    } catch (err) {
      setControlError(errorMessage(err));
    }
  }

  async function switchBranch(branchName: string) {
    if (!snapshot || !branchName || branchName === snapshot.repository.currentBranch) return;
    setControlError(null);
    setBranchBusy(true);
    try {
      const nextSnapshot = await api.switchGitBranch(snapshot.project.id, branchName);
      onSnapshotUpdated(nextSnapshot);
      const nextBranches = await api.getLocalBranches(snapshot.project.id);
      setBranches(nextBranches);
    } catch (err) {
      setControlError(errorMessage(err));
    } finally {
      setBranchBusy(false);
    }
  }

  function removePane(id: string) {
    const targetIndex = panes.findIndex((pane) => pane.id === id);
    disposePane(id, { stopPty: true });

    const nextPanes = panes.filter((pane) => pane.id !== id);
    setPanes(nextPanes);
    if (selectedPaneId === id) {
      setActivePaneId(nextPanes[Math.min(targetIndex, nextPanes.length - 1)]?.id ?? null);
    }
  }

  function ensureTerminal(pane: TerminalPaneState) {
    if (!snapshot || !isActiveRef.current || xtermRefs.current.has(pane.id)) return;
    const container = terminalRefs.current.get(pane.id);
    if (!container) return;

    const terminal = new XTerm({
      allowProposedApi: false,
      convertEol: true,
      cursorBlink: true,
      fontFamily:
        '"Berkeley Mono", "JetBrains Mono", "SFMono-Regular", ui-monospace, Menlo, Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.35,
      scrollback: 6000,
      theme: {
        background: "#0c0f12",
        foreground: "#dce3e0",
        cursor: "#78ffbe",
        black: "#15181c",
        red: "#ff6b6b",
        green: "#78ffbe",
        yellow: "#ffd166",
        blue: "#7aa2ff",
        magenta: "#d394ff",
        cyan: "#65d6ff",
        white: "#dce3e0",
        brightBlack: "#59636d",
        brightRed: "#ff8a8a",
        brightGreen: "#9dffd0",
        brightYellow: "#ffe08a",
        brightBlue: "#9ab8ff",
        brightMagenta: "#e0b0ff",
        brightCyan: "#8fe2ff",
        brightWhite: "#ffffff",
      },
    });

    terminal.open(container);
    xtermRefs.current.set(pane.id, terminal);
    inputDisposers.current.set(
      pane.id,
      terminal.onData((data) => {
        void api.writeTerminalPty(pane.id, data).catch((err) => {
          updatePane(pane.id, { error: errorMessage(err) });
        });
      }),
    );

    const resize = () => resizePane(pane.id);
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resizeObservers.current.set(pane.id, observer);

    const size = resize() ?? terminalSize(container);
    updatePane(pane.id, { running: true, error: null, exitCode: null });
    void api
      .startTerminalPty(snapshot.project.id, pane.id, pane.cwd, size, pane.nodeBinPath)
      .then((resolvedCwd) => {
        updatePane(pane.id, { cwd: resolvedCwd, running: true, error: null });
        terminal.focus();
      })
      .catch((err) => {
        updatePane(pane.id, { running: false, error: errorMessage(err) });
        terminal.writeln(`\r\nPTY start failed: ${errorMessage(err)}`);
      });
  }

  function resizePane(id: string): { cols: number; rows: number } | null {
    if (!isActiveRef.current) return null;
    const terminal = xtermRefs.current.get(id);
    const container = terminalRefs.current.get(id);
    if (!terminal || !container) return null;
    const rect = container.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    const size = terminalSize(container);
    terminal.resize(size.cols, size.rows);
    void api.resizeTerminalPty(id, size).catch(() => {
      // 세션 시작 전 resize가 먼저 발생할 수 있어 무시한다.
    });
    return size;
  }

  function disposePane(id: string, options: { stopPty: boolean }) {
    resizeObservers.current.get(id)?.disconnect();
    resizeObservers.current.delete(id);
    inputDisposers.current.get(id)?.dispose();
    inputDisposers.current.delete(id);
    xtermRefs.current.get(id)?.dispose();
    xtermRefs.current.delete(id);
    if (options.stopPty) {
      void api.stopTerminalPty(id).catch(() => undefined);
    }
  }

  function disposeAllPanes() {
    for (const id of xtermRefs.current.keys()) {
      disposePane(id, { stopPty: true });
    }
  }

  function renderPane(pane: TerminalPaneState, index: number) {
    return (
      <article
        className={selectedPaneId === pane.id ? "terminal-pane active" : "terminal-pane"}
        key={pane.id}
        ref={(node) => setPaneRef(pane.id, node)}
        onFocusCapture={() => setActivePaneId(pane.id)}
      >
        <header className="terminal-pane-header">
          <div className="terminal-pane-title">
            <span
              className={
                pane.running
                  ? "terminal-dot running"
                  : pane.exitCode !== null && pane.exitCode !== 0
                    ? "terminal-dot failed"
                    : "terminal-dot"
              }
              aria-hidden="true"
            />
            <strong>pane {index + 1}</strong>
            <span className="terminal-pane-path" title={pane.cwd}>
              <Folder size={12} aria-hidden="true" />
              <span>{pane.cwd}</span>
            </span>
          </div>
          <div className="terminal-pane-actions">
            <button
              className="terminal-close-pane"
              onClick={() => void restartPane(pane)}
              title="터미널 재시작"
              type="button"
              aria-label={`pane ${index + 1} 재시작`}
            >
              <RotateCcw size={13} aria-hidden="true" />
            </button>
            <button
              className="terminal-close-pane"
              onClick={() => removePane(pane.id)}
              title="터미널 닫기"
              type="button"
              aria-label={`pane ${index + 1} 닫기`}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        </header>

        <div
          className="terminal-xterm"
          ref={(node) => setTerminalRef(pane.id, node)}
          onClick={() => xtermRefs.current.get(pane.id)?.focus()}
        />

        {pane.error ? <div className="error-banner terminal-pane-error">{pane.error}</div> : null}

        <footer className="terminal-pane-status">
          <span className="terminal-status-runtime">
            <Cpu size={11} aria-hidden="true" />
            {nodeRuntimeLabel(pane.nodeBinPath, nodeRuntimes)}
          </span>
          {pane.running ? (
            <span className="ok">pty running</span>
          ) : pane.exitCode !== null ? (
            <span className={pane.exitCode === 0 ? "ok" : "failed"}>exit {pane.exitCode}</span>
          ) : (
            <span>starting</span>
          )}
        </footer>
      </article>
    );
  }

  return (
    <section className="terminal-screen">
      <div className="terminal-workbench">
        <aside className="terminal-workspaces" aria-label="터미널 워크스페이스">
          <div className="terminal-workspaces-title">
            <SquareTerminal size={15} aria-hidden="true" />
            <span>Sessions</span>
          </div>
          <nav className="terminal-tab-strip" aria-label="열린 터미널">
            {panes.map((pane, index) => (
              <div
                className={selectedPaneId === pane.id ? "terminal-session-row active" : "terminal-session-row"}
                key={pane.id}
              >
                <button
                  className="terminal-session-select"
                  onClick={() => setActivePaneId(pane.id)}
                  type="button"
                >
                  <span
                    className={
                      pane.running
                        ? "terminal-dot running"
                        : pane.exitCode !== null && pane.exitCode !== 0
                          ? "terminal-dot failed"
                          : "terminal-dot"
                    }
                    aria-hidden="true"
                  />
                  <strong>pane {index + 1}</strong>
                  <small>{shortPath(pane.cwd)}</small>
                </button>
                <button
                  className="terminal-session-remove"
                  onClick={() => removePane(pane.id)}
                  title="pane 삭제"
                  type="button"
                  aria-label={`pane ${index + 1} 삭제`}
                >
                  <X size={13} aria-hidden="true" />
                </button>
              </div>
            ))}
          </nav>
          <button className="terminal-sidebar-action" onClick={addPane} type="button">
            <Plus size={14} aria-hidden="true" />
            <span>새 pane</span>
          </button>
          <div className="terminal-workspace-state">
            <span>branch</span>
            <strong>{repository.currentBranch ?? "detached"}</strong>
            <span>changes</span>
            <strong>{repository.dirtyCount}</strong>
          </div>
        </aside>

        <div className="terminal-main">
          <div className="terminal-split-toolbar">
            <div className="terminal-toolbar-summary">
              <SplitSquareHorizontal size={15} aria-hidden="true" />
              <span>
                {panes.length} pane{panes.length === 1 ? "" : "s"}
              </span>
            </div>
            <div className="terminal-toolbar-controls">
              <label className="terminal-select-control">
                <Cpu size={14} aria-hidden="true" />
                <select
                  value={selectedNodeBinPath ?? ""}
                  onChange={(event) => void chooseNodeRuntime(event.target.value || null)}
                  title="Node runtime"
                >
                  <option value="">shell default</option>
                  {selectedRuntimeMissing ? (
                    <option value={selectedNodeBinPath ?? ""}>
                      {shortPath(selectedNodeBinPath ?? "")}
                    </option>
                  ) : null}
                  {nodeRuntimes.map((runtime) => (
                    <option key={runtime.id} value={runtime.binPath}>
                      {runtime.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="terminal-select-control cwd">
                <Folder size={14} aria-hidden="true" />
                <select
                  value={activeCwd}
                  onChange={(event) => void chooseDirectory(event.target.value)}
                  title="working directory"
                >
                  {directoryOptions.map((entry) => (
                    <option key={`${entry.kind}:${entry.path}`} value={entry.path}>
                      {entry.label}
                    </option>
                  ))}
                </select>
                <button
                  className="terminal-icon-action"
                  onClick={() => void browseDirectory()}
                  title="디렉토리 선택"
                  type="button"
                  aria-label="디렉토리 선택"
                >
                  <FolderOpen size={14} aria-hidden="true" />
                </button>
              </label>

              <label className="terminal-select-control branch">
                <GitBranch size={14} aria-hidden="true" />
                <select
                  value={repository.currentBranch ?? ""}
                  onChange={(event) => void switchBranch(event.target.value)}
                  disabled={branchBusy || branches.length === 0}
                  title="Git branch"
                >
                  {repository.currentBranch ? null : <option value="">detached</option>}
                  {branches.map((branch) => (
                    <option key={branch.branchName} value={branch.branchName}>
                      {branch.branchName}
                    </option>
                  ))}
                </select>
              </label>

              <div className="terminal-toolbar-stats" aria-label="working tree 상태">
                <span>{repository.stagedCount} staged</span>
                <span>{repository.untrackedCount} untracked</span>
              </div>
            </div>
          </div>
          {controlError ? <div className="terminal-control-error">{controlError}</div> : null}

          <div
            className={
              panes.length === 0
                ? "terminal-pane-grid empty"
                : usesSplitScroll
                  ? "terminal-pane-grid split-scroll"
                  : "terminal-pane-grid"
            }
            data-pane-count={panes.length}
          >
            {panes.length === 0 ? (
              <div className="terminal-empty">
                <p>열린 터미널이 없습니다.</p>
                <button className="terminal-add-pane" onClick={addPane} type="button">
                  <Plus size={14} aria-hidden="true" />
                  <span>터미널 추가</span>
                </button>
              </div>
            ) : (
              panes.map((pane, index) => renderPane(pane, index))
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function terminalSize(container: HTMLElement): { cols: number; rows: number } {
  const rect = container.getBoundingClientRect();
  return {
    cols: Math.max(20, Math.floor(rect.width / 7.3)),
    rows: Math.max(4, Math.floor(rect.height / 16.2)),
  };
}

function shortPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 2) return path || "/";
  return `.../${parts.slice(-2).join("/")}`;
}

function withCurrentDirectoryOption(
  entries: TerminalDirectoryEntry[],
  activeCwd: string,
): TerminalDirectoryEntry[] {
  if (entries.some((entry) => entry.path === activeCwd)) return entries;
  return [
    {
      path: activeCwd,
      label: shortPath(activeCwd),
      kind: "current",
    },
    ...entries,
  ];
}

function nodeRuntimeLabel(nodeBinPath: string | null, runtimes: NodeRuntimeSummary[]): string {
  if (!nodeBinPath) return "node shell";
  return (
    runtimes.find((runtime) => runtime.binPath === nodeBinPath)?.label ??
    `node ${shortPath(nodeBinPath)}`
  );
}

function nodeRuntimeExportCommand(nodeBinPath: string): string {
  const quotedBin = shellQuote(nodeBinPath);
  const nvmDir = nvmDirFromNodeBin(nodeBinPath);
  const nvmExport = nvmDir ? `export NVM_DIR=${shellQuote(nvmDir)}; ` : "";
  return `${nvmExport}export NVM_BIN=${quotedBin}; export PATH=${quotedBin}:$PATH; hash -r\n`;
}

function nvmDirFromNodeBin(nodeBinPath: string): string | null {
  const parts = nodeBinPath.split("/").filter(Boolean);
  const versionsIndex = parts.lastIndexOf("versions");
  if (versionsIndex <= 0 || parts[versionsIndex + 1] !== "node") return null;
  return `/${parts.slice(0, versionsIndex).join("/")}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function loadTerminalNodeSelection(projectId: string): string | null {
  try {
    return localStorage.getItem(terminalNodeSelectionKey(projectId));
  } catch {
    return null;
  }
}

function saveTerminalNodeSelection(projectId: string, nodeBinPath: string | null): void {
  try {
    const key = terminalNodeSelectionKey(projectId);
    if (nodeBinPath) localStorage.setItem(key, nodeBinPath);
    else localStorage.removeItem(key);
  } catch {
    // localStorage 실패가 터미널 시작을 막으면 안 된다.
  }
}

function terminalNodeSelectionKey(projectId: string): string {
  return `helm.terminal.nodeBinPath.${projectId}`;
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  if (error instanceof Error) return error.message;
  return "터미널 명령 실행에 실패했습니다.";
}
