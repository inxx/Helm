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
  TerminalPtySnapshot,
  TerminalPtySummary,
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
  seq: number;
}

interface TerminalPtyExit {
  terminalId: string;
  exitCode: number;
}

interface TerminalInputState {
  tracking: boolean;
  value: string;
}

interface TerminalAutocompleteSuggestion {
  command: string;
  suffix: string;
}

const MAX_TERMINAL_COMMAND_HISTORY = 200;
const MAX_TERMINAL_COMMAND_LENGTH = 500;

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

function paneFromSession(session: TerminalPtySummary): TerminalPaneState {
  return {
    id: session.terminalId,
    cwd: session.cwd,
    nodeBinPath: session.nodeBinPath,
    running: session.running,
    error: null,
    exitCode: session.exitCode,
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
  const commandHistoryRef = useRef<string[]>([]);
  const inputStateRefs = useRef(new Map<string, TerminalInputState>());
  const autocompleteRefs = useRef(new Map<string, TerminalAutocompleteSuggestion>());
  const lastOutputSeqRefs = useRef(new Map<string, number>());
  const restoringPaneIds = useRef(new Set<string>());
  const pendingOutputRefs = useRef(new Map<string, TerminalPtyOutput[]>());
  const [autocompleteByPane, setAutocompleteByPane] = useState<
    Record<string, TerminalAutocompleteSuggestion | null>
  >({});

  const selectedPaneId = activePaneId ?? panes[0]?.id ?? null;
  const activePane = panes.find((pane) => pane.id === selectedPaneId) ?? panes[0] ?? null;
  const usesSplitScroll = panes.length >= 5;

  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);

  useEffect(() => {
    if (!snapshot) {
      disposeAllPanes();
      setPanes([]);
      setActivePaneId(null);
      return;
    }
    let cancelled = false;
    const restoredNodeBinPath = loadTerminalNodeSelection(snapshot.project.id);
    commandHistoryRef.current = loadTerminalCommandHistory(snapshot.project.id);
    inputStateRefs.current.clear();
    autocompleteRefs.current.clear();
    setAutocompleteByPane({});
    setSelectedNodeBinPath(restoredNodeBinPath);
    disposeAllPanes();
    void api
      .listTerminalPtys(snapshot.project.id)
      .then((sessions) => {
        if (cancelled) return;
        const nextPanes =
          sessions.length > 0
            ? sessions.map(paneFromSession)
            : [createPane(snapshot.project.rootPath, restoredNodeBinPath)];
        setPanes(nextPanes);
        setActivePaneId(nextPanes[0]?.id ?? null);
      })
      .catch((err) => {
        if (cancelled) return;
        setControlError(errorMessage(err));
        const firstPane = createPane(snapshot.project.rootPath, restoredNodeBinPath);
        setPanes([firstPane]);
        setActivePaneId(firstPane.id);
      });
    return () => {
      cancelled = true;
    };
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
        if (restoringPaneIds.current.has(event.payload.terminalId)) {
          const pending = pendingOutputRefs.current.get(event.payload.terminalId) ?? [];
          pending.push(event.payload);
          pendingOutputRefs.current.set(event.payload.terminalId, pending);
          return;
        }
        writeTerminalOutput(event.payload);
      });
      unlistenExit = await listen<TerminalPtyExit>("terminal://exit", (event) => {
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
    disposePane(pane.id, { stopPty: false });
    updatePane(pane.id, { ...patch, running: false, error: null, exitCode: null });
    try {
      await api.stopTerminalPty(pane.id);
    } catch (err) {
      updatePane(pane.id, { running: false, error: errorMessage(err) });
      return;
    }
    requestAnimationFrame(() => ensureTerminal(nextPane));
  }

  async function chooseNodeRuntime(nextNodeBinPath: string | null) {
    setControlError(null);
    setSelectedNodeBinPath(nextNodeBinPath);
    if (snapshot) saveTerminalNodeSelection(snapshot.project.id, nextNodeBinPath);

    if (!activePane) return;
    updatePane(activePane.id, { nodeBinPath: nextNodeBinPath });

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
    restoringPaneIds.current.add(pane.id);

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
        const nextData = handleTerminalInputData(pane.id, data);
        if (!nextData) return;
        void api.writeTerminalPty(pane.id, nextData).catch((err) => {
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
    void restoreOrStartTerminal(pane, terminal, size);
  }

  async function restoreOrStartTerminal(
    pane: TerminalPaneState,
    terminal: XTerm,
    size: { cols: number; rows: number },
  ) {
    if (!snapshot) return;
    try {
      const existing = await api.getTerminalPtySnapshot(pane.id);
      if (existing) {
        restoreTerminalSnapshot(terminal, existing);
        updatePane(pane.id, {
          cwd: existing.cwd,
          nodeBinPath: existing.nodeBinPath,
          running: existing.running,
          error: null,
          exitCode: existing.exitCode,
        });
        if (existing.running) {
          await api.resizeTerminalPty(pane.id, size).catch(() => undefined);
        }
        if (isActiveRef.current) terminal.focus();
        finishTerminalRestore(pane.id);
        return;
      }

      const resolvedCwd = await api.startTerminalPty(
        snapshot.project.id,
        pane.id,
        pane.cwd,
        size,
        pane.nodeBinPath,
      );
      updatePane(pane.id, { cwd: resolvedCwd, running: true, error: null, exitCode: null });
      if (isActiveRef.current) terminal.focus();
      finishTerminalRestore(pane.id);
    } catch (err) {
      updatePane(pane.id, { running: false, error: errorMessage(err) });
      terminal.writeln(`\r\nPTY start failed: ${errorMessage(err)}`);
      finishTerminalRestore(pane.id);
    }
  }

  function restoreTerminalSnapshot(terminal: XTerm, snapshot: TerminalPtySnapshot) {
    if (snapshot.history) {
      terminal.write(snapshot.history);
    }
    lastOutputSeqRefs.current.set(snapshot.terminalId, snapshot.seq);
  }

  function finishTerminalRestore(id: string) {
    restoringPaneIds.current.delete(id);
    const pending = pendingOutputRefs.current.get(id) ?? [];
    pendingOutputRefs.current.delete(id);
    for (const output of pending) {
      writeTerminalOutput(output);
    }
  }

  function writeTerminalOutput(output: TerminalPtyOutput) {
    const lastSeq = lastOutputSeqRefs.current.get(output.terminalId) ?? 0;
    if (output.seq <= lastSeq) return;
    xtermRefs.current.get(output.terminalId)?.write(output.data);
    lastOutputSeqRefs.current.set(output.terminalId, output.seq);
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
    lastOutputSeqRefs.current.delete(id);
    restoringPaneIds.current.delete(id);
    pendingOutputRefs.current.delete(id);
    inputStateRefs.current.delete(id);
    setPaneAutocomplete(id, null);
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
    const autocomplete = autocompleteByPane[pane.id] ?? null;
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
          {autocomplete ? (
            <span className="terminal-autocomplete-chip" title="Tab으로 완성">
              <kbd>Tab</kbd>
              <strong>{autocomplete.command}</strong>
            </span>
          ) : null}
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

  function handleTerminalInputData(paneId: string, data: string): string {
    if (data === "\t") {
      const autocomplete = autocompleteRefs.current.get(paneId);
      if (!autocomplete || autocomplete.suffix.length === 0) {
        markPaneInputUnknown(paneId);
        return data;
      }
      inputStateRefs.current.set(paneId, {
        tracking: true,
        value: autocomplete.command,
      });
      refreshPaneAutocomplete(paneId, autocomplete.command, true);
      return autocomplete.suffix;
    }

    let inputState = inputStateRefs.current.get(paneId) ?? { tracking: true, value: "" };
    for (const char of data) {
      inputState = applyTerminalInputChar(paneId, inputState, char);
    }
    inputStateRefs.current.set(paneId, inputState);
    refreshPaneAutocomplete(paneId, inputState.value, inputState.tracking);
    return data;
  }

  function applyTerminalInputChar(
    paneId: string,
    inputState: TerminalInputState,
    char: string,
  ): TerminalInputState {
    if (char === "\r" || char === "\n") {
      rememberTerminalCommand(inputState);
      setPaneAutocomplete(paneId, null);
      return { tracking: true, value: "" };
    }
    if (char === "\u0003" || char === "\u0004") {
      setPaneAutocomplete(paneId, null);
      return { tracking: true, value: "" };
    }
    if (char === "\u001b") {
      setPaneAutocomplete(paneId, null);
      return { tracking: false, value: inputState.value };
    }
    if (!inputState.tracking) {
      return inputState;
    }
    if (char === "\u007f") {
      return { ...inputState, value: removeLastCodePoint(inputState.value) };
    }
    if (char === "\u0015") {
      return { ...inputState, value: "" };
    }
    if (char === "\u0017") {
      return { ...inputState, value: removePreviousShellWord(inputState.value) };
    }
    if (isPrintableTerminalInput(char)) {
      return { ...inputState, value: inputState.value + char };
    }
    return inputState;
  }

  function rememberTerminalCommand(inputState: TerminalInputState) {
    if (!snapshot || !inputState.tracking) return;
    if (inputState.value.startsWith(" ")) return;
    const command = normalizeTerminalCommand(inputState.value);
    if (!command || !isTerminalCommandHistoryCandidate(command)) return;
    const nextHistory = addTerminalCommandHistory(commandHistoryRef.current, command);
    commandHistoryRef.current = nextHistory;
    saveTerminalCommandHistory(snapshot.project.id, nextHistory);
  }

  function markPaneInputUnknown(paneId: string) {
    const inputState = inputStateRefs.current.get(paneId) ?? { tracking: true, value: "" };
    inputStateRefs.current.set(paneId, { ...inputState, tracking: false });
    setPaneAutocomplete(paneId, null);
  }

  function refreshPaneAutocomplete(paneId: string, value: string, tracking: boolean) {
    const autocomplete = tracking
      ? findTerminalAutocomplete(commandHistoryRef.current, value)
      : null;
    setPaneAutocomplete(paneId, autocomplete);
  }

  function setPaneAutocomplete(id: string, autocomplete: TerminalAutocompleteSuggestion | null) {
    const current = autocompleteRefs.current.get(id) ?? null;
    if (sameTerminalAutocomplete(current, autocomplete)) return;
    if (autocomplete) autocompleteRefs.current.set(id, autocomplete);
    else autocompleteRefs.current.delete(id);
    setAutocompleteByPane((currentByPane) => {
      if (sameTerminalAutocomplete(currentByPane[id] ?? null, autocomplete)) return currentByPane;
      return {
        ...currentByPane,
        [id]: autocomplete,
      };
    });
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

function loadTerminalCommandHistory(projectId: string): string[] {
  try {
    const raw = localStorage.getItem(terminalCommandHistoryKey(projectId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((command): command is string => typeof command === "string")
      .map(normalizeTerminalCommand)
      .filter(isTerminalCommandHistoryCandidate)
      .slice(0, MAX_TERMINAL_COMMAND_HISTORY);
  } catch {
    return [];
  }
}

function saveTerminalCommandHistory(projectId: string, history: string[]): void {
  try {
    localStorage.setItem(
      terminalCommandHistoryKey(projectId),
      JSON.stringify(history.slice(0, MAX_TERMINAL_COMMAND_HISTORY)),
    );
  } catch {
    // 명령어 히스토리는 편의 기능이라 저장 실패가 입력을 막으면 안 된다.
  }
}

function terminalCommandHistoryKey(projectId: string): string {
  return `helm.terminal.commandHistory.${projectId}`;
}

function addTerminalCommandHistory(history: string[], command: string): string[] {
  return [
    command,
    ...history.filter((candidate) => candidate.toLowerCase() !== command.toLowerCase()),
  ].slice(0, MAX_TERMINAL_COMMAND_HISTORY);
}

function findTerminalAutocomplete(
  history: string[],
  value: string,
): TerminalAutocompleteSuggestion | null {
  if (value.trim().length === 0 || value.startsWith(" ")) return null;
  const lowerValue = value.toLowerCase();
  const command = history.find(
    (candidate) =>
      candidate.length > value.length && candidate.toLowerCase().startsWith(lowerValue),
  );
  if (!command) return null;
  return {
    command,
    suffix: command.slice(value.length),
  };
}

function sameTerminalAutocomplete(
  left: TerminalAutocompleteSuggestion | null,
  right: TerminalAutocompleteSuggestion | null,
): boolean {
  return left?.command === right?.command && left?.suffix === right?.suffix;
}

function normalizeTerminalCommand(value: string): string {
  return value.trim().slice(0, MAX_TERMINAL_COMMAND_LENGTH);
}

function isTerminalCommandHistoryCandidate(command: string): boolean {
  if (command.length === 0 || command.length > MAX_TERMINAL_COMMAND_LENGTH) return false;
  const lowerCommand = command.toLowerCase();
  return !/(password|passwd|token|secret|api[-_]?key|authorization)\s*=|bearer\s+\S+/i.test(
    lowerCommand,
  );
}

function isPrintableTerminalInput(char: string): boolean {
  return char.length > 0 && !/[\u0000-\u001f\u007f]/.test(char);
}

function removeLastCodePoint(value: string): string {
  return Array.from(value).slice(0, -1).join("");
}

function removePreviousShellWord(value: string): string {
  return value.replace(/\s*\S+\s*$/, "");
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  if (error instanceof Error) return error.message;
  return "터미널 명령 실행에 실패했습니다.";
}
