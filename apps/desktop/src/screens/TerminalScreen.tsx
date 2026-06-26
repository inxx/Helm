import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  Bot,
  ChevronDown,
  Cpu,
  FileTerminal,
  Folder,
  FolderOpen,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  SquareTerminal,
  Trash2,
  X,
} from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { shortenPath, type RecentProject } from "../lib/recents";
import { createTerminalPane, terminalPaneFromSession, type TerminalPaneState } from "../lib/terminalPanes";
import type {
  NodeRuntimeSummary,
  ProjectSnapshot,
  TerminalDirectoryEntry,
  TerminalPtySnapshot,
  TerminalSavedScriptSummary,
} from "../lib/types";

interface TerminalScreenProps {
  snapshot: ProjectSnapshot | null;
  isActive: boolean;
  onOpenProject: () => void;
  recents: RecentProject[];
  activeProjectId: string | null;
  onSwitchProject: (projectId: string) => Promise<void>;
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

type SavedScriptAction = "terminal" | "agent";

interface SavedScriptEditorState {
  id: string | null;
  name: string;
  command: string;
  action: SavedScriptAction;
}

const MAX_TERMINAL_COMMAND_HISTORY = 200;
const MAX_TERMINAL_COMMAND_LENGTH = 500;
const MAX_SAVED_TERMINAL_SCRIPT_LENGTH = 4000;
const MAX_TERMINAL_PANE_NAME_LENGTH = 60;

export const TerminalScreen = memo(function TerminalScreen({
  snapshot,
  isActive,
  onOpenProject,
  recents,
  activeProjectId,
  onSwitchProject,
}: TerminalScreenProps) {
  const { language } = useI18n();
  const [panes, setPanes] = useState<TerminalPaneState[]>(() =>
    snapshot ? [createTerminalPane(snapshot.project.id, snapshot.project.rootPath, null)] : [],
  );
  const [activePaneId, setActivePaneId] = useState<string | null>(panes[0]?.id ?? null);
  const [nodeRuntimes, setNodeRuntimes] = useState<NodeRuntimeSummary[]>([]);
  const [controlError, setControlError] = useState<string | null>(null);
  const paneRefs = useRef(new Map<string, HTMLElement>());
  const terminalRefs = useRef(new Map<string, HTMLDivElement>());
  const xtermRefs = useRef(new Map<string, XTerm>());
  const fitAddonRefs = useRef(new Map<string, FitAddon>());
  const serializeAddonRefs = useRef(new Map<string, SerializeAddon>());
  const inputDisposers = useRef(new Map<string, { dispose: () => void }>());
  const resizeObservers = useRef(new Map<string, ResizeObserver>());
  const isActiveRef = useRef(isActive);
  const commandHistoryRef = useRef<string[]>([]);
  const inputStateRefs = useRef(new Map<string, TerminalInputState>());
  const autocompleteRefs = useRef(new Map<string, TerminalAutocompleteSuggestion>());
  const lastOutputSeqRefs = useRef(new Map<string, number>());
  const restoringPaneIds = useRef(new Set<string>());
  const panesInitialized = useRef(false);
  const pendingOutputRefs = useRef(new Map<string, TerminalPtyOutput[]>());
  const savedScriptMenuRef = useRef<HTMLElement | null>(null);
  const [autocompleteByPane, setAutocompleteByPane] = useState<
    Record<string, TerminalAutocompleteSuggestion | null>
  >({});
  const [savedScripts, setSavedScripts] = useState<TerminalSavedScriptSummary[]>([]);
  const [savedScriptsBusy, setSavedScriptsBusy] = useState(false);
  const [savedScriptMenuOpen, setSavedScriptMenuOpen] = useState(false);
  const [savedScriptEditor, setSavedScriptEditor] = useState<SavedScriptEditorState | null>(null);
  const [directoriesByPane, setDirectoriesByPane] = useState<Record<string, TerminalDirectoryEntry[]>>({});
  const [switchingProjectId, setSwitchingProjectId] = useState<string | null>(null);
  const [paneNames, setPaneNames] = useState<Record<string, string>>({});
  const [editingPaneNameId, setEditingPaneNameId] = useState<string | null>(null);
  const [paneNameDraft, setPaneNameDraft] = useState("");

  const selectedPaneId = activePaneId ?? panes[0]?.id ?? null;
  const activePane = panes.find((pane) => pane.id === selectedPaneId) ?? panes[0] ?? null;
  const usesSplitScroll = panes.length >= 5;

  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);

  useEffect(() => {
    if (!savedScriptMenuOpen) return;

    function closeOnOutsidePointerDown(event: PointerEvent) {
      const menu = savedScriptMenuRef.current;
      if (!menu || menu.contains(event.target as Node)) return;
      setSavedScriptMenuOpen(false);
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setSavedScriptMenuOpen(false);
      }
    }

    document.addEventListener("pointerdown", closeOnOutsidePointerDown);
    document.addEventListener("keydown", closeOnEscape);

    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [savedScriptMenuOpen]);

  // 활성 프로젝트 전환 시: 명령 히스토리와 빠른 명령만 다시 로드한다. pane은 프로젝트와 무관하게 유지된다.
  useEffect(() => {
    if (!snapshot) {
      setSavedScripts([]);
      return;
    }
    let cancelled = false;
    commandHistoryRef.current = loadTerminalCommandHistory(snapshot.project.id);
    setSavedScripts([]);
    setSavedScriptsBusy(true);
    void api
      .listTerminalSavedScripts(snapshot.project.id)
      .then((scripts) => {
        if (!cancelled) setSavedScripts(scripts);
      })
      .catch((err) => {
        if (!cancelled) setControlError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setSavedScriptsBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [snapshot?.project.id]);

  // pane은 모든 프로젝트에 걸쳐 한 번만 로드하고 프로젝트 전환에도 그대로 유지한다.
  useEffect(() => {
    if (!snapshot || panesInitialized.current) return;
    panesInitialized.current = true;
    setPaneNames(loadTerminalPaneNames());
    let cancelled = false;
    void api
      .listTerminalPtys()
      .then((sessions) => {
        if (cancelled) return;
        const nextPanes =
          sessions.length > 0
            ? sessions.map(terminalPaneFromSession)
            : [createTerminalPane(snapshot.project.id, snapshot.project.rootPath, null)];
        setPanes(nextPanes);
        setActivePaneId(nextPanes[0]?.id ?? null);
      })
      .catch((err) => {
        if (cancelled) return;
        setControlError(errorMessage(err));
        const firstPane = createTerminalPane(snapshot.project.id, snapshot.project.rootPath, null);
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
    return () => disposeAllPanes({ stopPty: false });
  }, []);

  function setPaneRef(id: string, node: HTMLElement | null) {
    if (node) paneRefs.current.set(id, node);
    else paneRefs.current.delete(id);
  }

  function setTerminalRef(id: string, node: HTMLDivElement | null) {
    if (node) terminalRefs.current.set(id, node);
    else terminalRefs.current.delete(id);
  }

  async function switchTerminalProject(projectId: string) {
    if (!projectId || projectId === activeProjectId || switchingProjectId) return;
    setSwitchingProjectId(projectId);
    setControlError(null);
    try {
      await onSwitchProject(projectId);
    } catch (err) {
      setControlError(errorMessage(err));
    } finally {
      setSwitchingProjectId(null);
    }
  }

  if (!snapshot) {
    return (
      <section className="empty-state">
        <h2>{language === "ko" ? "터미널" : "Terminal"}</h2>
        <p>{language === "ko" ? "최근 프로젝트를 선택하거나 새 프로젝트를 열어 통합 터미널을 시작하세요." : "Select a recent project or open a new one to start an integrated terminal."}</p>
        {recents.length > 0 ? (
          <div className="terminal-empty-recents">
            {recents.slice(0, 5).map((project) => (
              <button
                disabled={switchingProjectId === project.id}
                key={project.id}
                onClick={() => void switchTerminalProject(project.id)}
                type="button"
              >
                <strong>{project.name}</strong>
                <span>{shortenPath(project.rootPath)}</span>
              </button>
            ))}
          </div>
        ) : null}
        <button className="primary-button" onClick={onOpenProject} type="button">
          {language === "ko" ? "프로젝트 열기" : "Open project"}
        </button>
      </section>
    );
  }

  function paneProject(pane: TerminalPaneState): { name: string; rootPath: string } {
    if (snapshot && pane.projectId === snapshot.project.id) return snapshot.project;
    const recent = recents.find((candidate) => candidate.id === pane.projectId);
    if (recent) return { name: recent.name, rootPath: recent.rootPath };
    return snapshot?.project ?? { name: pane.cwd, rootPath: pane.cwd };
  }

  function updatePane(id: string, patch: Partial<TerminalPaneState>) {
    setPanes((current) => current.map((pane) => (pane.id === id ? { ...pane, ...patch } : pane)));
  }

  function addPane() {
    const nextPane = createTerminalPane(
      snapshot?.project.id ?? null,
      activePane?.cwd ?? snapshot?.project.rootPath ?? "",
      activePane?.nodeBinPath ?? null,
    );
    setPanes((current) => [...current, nextPane]);
    setActivePaneId(nextPane.id);
  }

  function beginRenamePane(pane: TerminalPaneState, index: number) {
    setActivePaneId(pane.id);
    setEditingPaneNameId(pane.id);
    setPaneNameDraft(paneNames[pane.id] ?? `pane ${index + 1}`);
  }

  function commitRenamePane(paneId: string) {
    const name = normalizeTerminalPaneName(paneNameDraft);
    const nextNames = { ...paneNames };
    if (name) nextNames[paneId] = name;
    else delete nextNames[paneId];
    setPaneNames(nextNames);
    saveTerminalPaneNames(nextNames);
    setEditingPaneNameId(null);
    setPaneNameDraft("");
  }

  function cancelRenamePane() {
    setEditingPaneNameId(null);
    setPaneNameDraft("");
  }

  async function restartPane(pane: TerminalPaneState, patch: Partial<TerminalPaneState> = {}) {
    const nextPane = { ...pane, ...patch };
    disposePane(pane.id, { stopPty: false });
    // 기존 세션을 먼저 끝내야 한다. updatePane을 먼저 하면 re-render로 ensureTerminal이 다시 돌아
    // 아직 살아있는 옛 세션 스냅샷을 재채택하고 cwd를 이전 값으로 덮어쓴다.
    try {
      await api.stopTerminalPty(pane.id);
    } catch (err) {
      updatePane(pane.id, { running: false, error: errorMessage(err) });
      return;
    }
    updatePane(pane.id, { ...patch, running: false, error: null, exitCode: null });
    requestAnimationFrame(() => ensureTerminal(nextPane));
  }

  async function chooseNodeRuntime(nextNodeBinPath: string | null) {
    setControlError(null);

    if (!activePane) return;
    updatePane(activePane.id, { nodeBinPath: nextNodeBinPath });

    await restartPane(activePane, { nodeBinPath: nextNodeBinPath });
  }

  async function loadPaneDirectories(pane: TerminalPaneState) {
    if (!snapshot) return;
    try {
      const directories = await api.listTerminalDirectories(pane.projectId ?? snapshot.project.id, pane.cwd);
      setDirectoriesByPane((current) => ({ ...current, [pane.id]: directories }));
      setControlError(null);
    } catch (err) {
      setControlError(errorMessage(err));
    }
  }

  async function choosePaneCwd(pane: TerminalPaneState, nextCwd: string) {
    if (!nextCwd || nextCwd === pane.cwd) return;
    setControlError(null);
    await restartPane(pane, { cwd: nextCwd });
  }

  function removePane(id: string) {
    const targetIndex = panes.findIndex((pane) => pane.id === id);
    disposePane(id, { stopPty: true });

    const nextPanes = panes.filter((pane) => pane.id !== id);
    setPanes(nextPanes);
    if (paneNames[id]) {
      const nextNames = { ...paneNames };
      delete nextNames[id];
      setPaneNames(nextNames);
      saveTerminalPaneNames(nextNames);
    }
    if (selectedPaneId === id) {
      setActivePaneId(nextPanes[Math.min(targetIndex, nextPanes.length - 1)]?.id ?? null);
    }
  }

  function openSavedScriptEditor(script: TerminalSavedScriptSummary | null = null) {
    setSavedScriptMenuOpen(false);
    if (script) {
      setSavedScriptEditor({
        id: script.id,
        name: script.name,
        command: script.command,
        action: savedScriptActionFromTags(script.tags),
      });
      return;
    }
    const command = savedScriptCandidateForPane(selectedPaneId);
    setSavedScriptEditor({
      id: null,
      name: command ? savedScriptNameFromCommand(command) : "",
      command,
      action: "terminal",
    });
  }

  function updateSavedScriptEditor(patch: Partial<SavedScriptEditorState>) {
    setSavedScriptEditor((current) => (current ? { ...current, ...patch } : current));
  }

  async function saveScriptFromEditor() {
    if (!snapshot) return;
    if (!savedScriptEditor) return;
    const normalizedCommand = normalizeSavedTerminalScript(savedScriptEditor.command);
    if (!normalizedCommand) {
      setControlError("저장할 스크립트가 비어 있습니다.");
      return;
    }
    if (!isSavedTerminalScriptCandidate(normalizedCommand)) {
      setControlError("비밀값처럼 보이는 내용은 저장하지 않았습니다.");
      return;
    }
    const suggestedName = savedScriptNameFromCommand(normalizedCommand);
    const normalizedName = savedScriptEditor.name.trim().slice(0, 80) || suggestedName;
    setSavedScriptsBusy(true);
    try {
      const saved = await api.saveTerminalSavedScript(snapshot.project.id, {
        id: savedScriptEditor.id,
        name: normalizedName,
        command: normalizedCommand,
        cwdMode: "active_pane",
        nodeBinPath: activePane?.nodeBinPath ?? null,
        tags: savedScriptEditor.action === "agent" ? ["action:agent_prompt"] : [],
      });
      setSavedScripts((current) => [saved, ...current.filter((script) => script.id !== saved.id)]);
      setControlError(null);
      setSavedScriptEditor(null);
      setSavedScriptMenuOpen(true);
    } catch (err) {
      setControlError(errorMessage(err));
    } finally {
      setSavedScriptsBusy(false);
    }
  }

  async function removeSavedScript(scriptId: string) {
    if (!snapshot) return;
    setSavedScriptMenuOpen(false);
    setSavedScriptsBusy(true);
    try {
      await api.deleteTerminalSavedScript(snapshot.project.id, scriptId);
      setSavedScripts((current) => current.filter((script) => script.id !== scriptId));
      setControlError(null);
    } catch (err) {
      setControlError(errorMessage(err));
    } finally {
      setSavedScriptsBusy(false);
    }
  }

  async function runSavedScript(script: TerminalSavedScriptSummary) {
    setSavedScriptMenuOpen(false);
    if (savedScriptActionFromTags(script.tags) === "agent") {
      setControlError("Agent 프롬프트는 편집만 지원합니다. 터미널 명령을 선택해 실행해주세요.");
      return;
    }
    if (!activePane) {
      setControlError("스크립트를 실행할 터미널 pane이 없습니다.");
      return;
    }
    if (isDestructiveTerminalScript(script.command)) {
      const confirmed = window.confirm(`위험할 수 있는 저장 스크립트입니다. 실행할까요?\n\n${script.command}`);
      if (!confirmed) return;
    }
    setControlError(null);
    setActivePaneId(activePane.id);
    try {
      await api.writeTerminalPty(activePane.id, `${script.command}\r`);
      if (snapshot) {
        const updated = await api.markTerminalSavedScriptUsed(snapshot.project.id, script.id);
        setSavedScripts((current) => [updated, ...current.filter((candidate) => candidate.id !== updated.id)]);
      }
      xtermRefs.current.get(activePane.id)?.focus();
    } catch (err) {
      setControlError(errorMessage(err));
    }
  }

  function savedScriptCandidateForPane(paneId: string | null): string {
    if (paneId) {
      const inputState = inputStateRefs.current.get(paneId);
      const currentInput = inputState?.tracking ? normalizeSavedTerminalScript(inputState.value) : "";
      if (currentInput) return currentInput;
    }
    return commandHistoryRef.current[0] ?? "";
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
        '"JetBrains Mono", "SFMono-Regular", ui-monospace, Menlo, Consolas, monospace',
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

    const fitAddon = new FitAddon();
    const serializeAddon = new SerializeAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(serializeAddon);

    try {
      const unicode11Addon = new Unicode11Addon();
      terminal.loadAddon(unicode11Addon);
      terminal.unicode.activeVersion = "11";
    } catch {
      // Unicode11 is an enhancement; the terminal should still open without it.
    }

    try {
      terminal.loadAddon(new WebLinksAddon());
    } catch {
      // Web links are optional and should never prevent PTY startup.
    }

    terminal.open(container);
    xtermRefs.current.set(pane.id, terminal);
    fitAddonRefs.current.set(pane.id, fitAddon);
    serializeAddonRefs.current.set(pane.id, serializeAddon);
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
        pane.projectId ?? snapshot.project.id,
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
      terminal.write(snapshot.history, () => {
        terminal.scrollToBottom();
      });
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
    const terminal = xtermRefs.current.get(output.terminalId);
    terminal?.write(output.data, () => {
      terminal.scrollToBottom();
    });
    lastOutputSeqRefs.current.set(output.terminalId, output.seq);
  }

  function resizePane(id: string): { cols: number; rows: number } | null {
    if (!isActiveRef.current) return null;
    const terminal = xtermRefs.current.get(id);
    const container = terminalRefs.current.get(id);
    if (!terminal || !container) return null;
    const rect = container.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    const fitAddon = fitAddonRefs.current.get(id);
    let size = terminalSize(container);
    if (fitAddon) {
      try {
        fitAddon.fit();
        size = { cols: terminal.cols, rows: terminal.rows };
      } catch {
        terminal.resize(size.cols, size.rows);
      }
    } else {
      terminal.resize(size.cols, size.rows);
    }
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
    fitAddonRefs.current.delete(id);
    serializeAddonRefs.current.delete(id);
    lastOutputSeqRefs.current.delete(id);
    restoringPaneIds.current.delete(id);
    pendingOutputRefs.current.delete(id);
    inputStateRefs.current.delete(id);
    setDirectoriesByPane((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
    setPaneAutocomplete(id, null);
    if (options.stopPty) {
      void api.stopTerminalPty(id).catch(() => undefined);
    }
  }

  function disposeAllPanes(options: { stopPty: boolean }) {
    for (const id of xtermRefs.current.keys()) {
      disposePane(id, options);
    }
  }

  function renderPane(pane: TerminalPaneState, index: number) {
    const autocomplete = autocompleteByPane[pane.id] ?? null;
    const cwdOptions = cwdOptionsForPane(pane, directoriesByPane[pane.id] ?? []);
    const isSelected = selectedPaneId === pane.id;
    const paneOwner = paneProject(pane);
    const paneRuntimeMissing =
      pane.nodeBinPath !== null &&
      !nodeRuntimes.some((runtime) => runtime.binPath === pane.nodeBinPath);
    return (
      <article
        className={isSelected ? "terminal-pane active" : "terminal-pane"}
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
            <span className="terminal-pane-project" title={paneOwner.rootPath}>
              {paneOwner.name}
            </span>
            <button
              className="terminal-project-folder-button"
              onClick={onOpenProject}
              title={language === "ko" ? "프로젝트 폴더 선택" : "Choose project folder"}
              type="button"
            >
              <FolderOpen size={12} aria-hidden="true" />
              <span>{shortenPath(paneOwner.rootPath)}</span>
            </button>
            <label className="terminal-pane-path" title={pane.cwd}>
              <Folder size={12} aria-hidden="true" />
              <span>{language === "ko" ? "작업 폴더" : "Working folder"}</span>
              <select
                onChange={(event) => void choosePaneCwd(pane, event.target.value)}
                onFocus={() => void loadPaneDirectories(pane)}
                onMouseDown={() => void loadPaneDirectories(pane)}
                value={pane.cwd}
                aria-label={language === "ko" ? `pane ${index + 1} 작업 폴더` : `pane ${index + 1} working folder`}
              >
                {cwdOptions.map((directory) => (
                  <option key={directory.path} value={directory.path}>
                    {directory.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="terminal-pane-actions">
            <button
              className="terminal-close-pane"
              onClick={() => void restartPane(pane)}
              title={language === "ko" ? "터미널 재시작" : "Restart terminal"}
              type="button"
              aria-label={language === "ko" ? `pane ${index + 1} 재시작` : `Restart pane ${index + 1}`}
            >
              <RotateCcw size={13} aria-hidden="true" />
            </button>
            <button
              className="terminal-close-pane"
              onClick={() => removePane(pane.id)}
              title={language === "ko" ? "터미널 닫기" : "Close terminal"}
              type="button"
              aria-label={language === "ko" ? `pane ${index + 1} 닫기` : `Close pane ${index + 1}`}
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
          {isSelected ? (
            <div className="terminal-pane-controls">
              <section className="terminal-scripts" ref={savedScriptMenuRef} aria-label={language === "ko" ? "빠른 명령" : "Quick commands"}>
                <button
                  className="terminal-quick-command-trigger"
                  onClick={() => setSavedScriptMenuOpen((open) => !open)}
                  type="button"
                  aria-expanded={savedScriptMenuOpen}
                >
                  <Play size={13} aria-hidden="true" />
                  <span>{savedScripts[0]?.name ?? (language === "ko" ? "빠른 명령" : "Quick commands")}</span>
                  <ChevronDown size={13} aria-hidden="true" />
                </button>
                {savedScriptMenuOpen ? (
                  <div className="terminal-quick-command-popover">
                    {savedScriptsBusy && savedScripts.length === 0 ? (
                      <p>{language === "ko" ? "저장된 명령을 불러오는 중입니다." : "Loading saved commands."}</p>
                    ) : savedScripts.length === 0 ? (
                      <p>{language === "ko" ? "자주 쓰는 명령을 추가하세요." : "Add commands you use often."}</p>
                    ) : (
                      <ul>
                        {savedScripts.map((script) => {
                          const action = savedScriptActionFromTags(script.tags);
                          return (
                            <li key={script.id}>
                              <button
                                className="terminal-script-run"
                                onClick={() => void runSavedScript(script)}
                                title={script.command}
                                type="button"
                              >
                                {action === "agent" ? (
                                  <Bot size={13} aria-hidden="true" />
                                ) : (
                                  <Play size={13} aria-hidden="true" />
                                )}
                                <span>
                                  <strong>{script.name}</strong>
                                  <small>{singleLineScriptPreview(script.command)}</small>
                                </span>
                              </button>
                              <div className="terminal-script-actions">
                                <button
                                  onClick={() => openSavedScriptEditor(script)}
                                  title={language === "ko" ? "빠른 명령 편집" : "Edit quick command"}
                                  type="button"
                                  aria-label={language === "ko" ? `${script.name} 편집` : `Edit ${script.name}`}
                                >
                                  <Pencil size={13} aria-hidden="true" />
                                </button>
                                <button
                                  onClick={() => void removeSavedScript(script.id)}
                                  title={language === "ko" ? "빠른 명령 삭제" : "Delete quick command"}
                                  type="button"
                                  aria-label={language === "ko" ? `${script.name} 삭제` : `Delete ${script.name}`}
                                >
                                  <Trash2 size={13} aria-hidden="true" />
                                </button>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                    <button
                      className="terminal-script-add"
                      onClick={() => openSavedScriptEditor()}
                      type="button"
                    >
                      <Plus size={15} aria-hidden="true" />
                      <span>{language === "ko" ? "명령 추가" : "Add command"}</span>
                    </button>
                  </div>
                ) : null}
              </section>

              <label className="terminal-select-control">
                <Cpu size={14} aria-hidden="true" />
                <select
                  value={pane.nodeBinPath ?? ""}
                  onChange={(event) => void chooseNodeRuntime(event.target.value || null)}
                  title={language === "ko" ? "이 pane의 Node runtime" : "Node runtime for this pane"}
                >
                  <option value="">shell default</option>
                  {paneRuntimeMissing ? (
                    <option value={pane.nodeBinPath ?? ""}>{shortPath(pane.nodeBinPath ?? "")}</option>
                  ) : null}
                  {nodeRuntimes.map((runtime) => (
                    <option key={runtime.id} value={runtime.binPath}>
                      {runtime.label}
                    </option>
                  ))}
                </select>
              </label>

            </div>
          ) : (
            <span className="terminal-status-runtime">
              <Cpu size={11} aria-hidden="true" />
              {nodeRuntimeLabel(pane.nodeBinPath, nodeRuntimes)}
            </span>
          )}
          {autocomplete ? (
            <span className="terminal-autocomplete-chip" title={language === "ko" ? "Tab으로 완성" : "Complete with Tab"}>
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
        <aside className="terminal-workspaces" aria-label={language === "ko" ? "터미널 워크스페이스" : "Terminal workspaces"}>
          <div className="terminal-workspaces-title">
            <SquareTerminal size={15} aria-hidden="true" />
            <span>Sessions</span>
          </div>
          <nav className="terminal-tab-strip" aria-label={language === "ko" ? "열린 터미널" : "Open terminals"}>
            {panes.map((pane, index) => (
              <div
                className={selectedPaneId === pane.id ? "terminal-session-row active" : "terminal-session-row"}
                key={pane.id}
              >
                {editingPaneNameId === pane.id ? (
                  <form
                    className="terminal-session-edit"
                    onSubmit={(event) => {
                      event.preventDefault();
                      commitRenamePane(pane.id);
                    }}
                  >
                    <input
                      autoFocus
                      maxLength={MAX_TERMINAL_PANE_NAME_LENGTH}
                      onBlur={() => commitRenamePane(pane.id)}
                      onChange={(event) => setPaneNameDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          event.preventDefault();
                          cancelRenamePane();
                        }
                      }}
                      value={paneNameDraft}
                      aria-label={language === "ko" ? `pane ${index + 1} 이름` : `Pane ${index + 1} name`}
                    />
                    <small>{shortPath(pane.cwd)}</small>
                  </form>
                ) : (
                  <button
                    className="terminal-session-select"
                    onClick={() => setActivePaneId(pane.id)}
                    onDoubleClick={() => beginRenamePane(pane, index)}
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
                    <strong>{paneNames[pane.id] ?? `pane ${index + 1}`}</strong>
                    <small>{shortPath(pane.cwd)}</small>
                  </button>
                )}
                <button
                  className="terminal-session-rename"
                  onClick={() => beginRenamePane(pane, index)}
                  title={language === "ko" ? "pane 이름 변경" : "Rename pane"}
                  type="button"
                  aria-label={language === "ko" ? `pane ${index + 1} 이름 변경` : `Rename pane ${index + 1}`}
                >
                  <Pencil size={12} aria-hidden="true" />
                </button>
                <button
                  className="terminal-session-remove"
                  onClick={() => removePane(pane.id)}
                  title={language === "ko" ? "pane 삭제" : "Remove pane"}
                  type="button"
                  aria-label={language === "ko" ? `pane ${index + 1} 삭제` : `Remove pane ${index + 1}`}
                >
                  <X size={13} aria-hidden="true" />
                </button>
              </div>
            ))}
          </nav>
          <button className="terminal-sidebar-action" onClick={addPane} type="button">
            <Plus size={14} aria-hidden="true" />
            <span>{language === "ko" ? "새 pane" : "New pane"}</span>
          </button>
        </aside>

        <div className="terminal-main">
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
                <p>{language === "ko" ? "열린 터미널이 없습니다." : "No open terminals."}</p>
                <button className="terminal-add-pane" onClick={addPane} type="button">
                  <Plus size={14} aria-hidden="true" />
                  <span>{language === "ko" ? "터미널 추가" : "Add terminal"}</span>
                </button>
              </div>
            ) : (
              panes.map((pane, index) => renderPane(pane, index))
            )}
          </div>
        </div>
      </div>
      {savedScriptEditor ? (
        <div className="terminal-command-dialog-backdrop" role="presentation">
          <form
            className="terminal-command-dialog"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setSavedScriptEditor(null);
              }
              if (event.key === "Enter" && event.metaKey) {
                event.preventDefault();
                void saveScriptFromEditor();
              }
            }}
            onSubmit={(event) => {
              event.preventDefault();
              void saveScriptFromEditor();
            }}
          >
            <header>
              <h2>{language === "ko" ? "빠른 명령 편집" : "Edit quick command"}</h2>
              <p>{language === "ko" ? "빠른 액세스를 위해 terminal 명령이나 agent 프롬프트를 저장하세요." : "Save terminal commands or agent prompts for quick access."}</p>
            </header>

            <label className="terminal-command-field">
              <span>{language === "ko" ? "상표" : "Label"}</span>
              <input
                autoFocus
                value={savedScriptEditor.name}
                onChange={(event) => updateSavedScriptEditor({ name: event.target.value })}
                maxLength={80}
              />
            </label>

            <div className="terminal-command-field">
              <span>{language === "ko" ? "행동" : "Action"}</span>
              <div className="terminal-command-segmented" role="tablist" aria-label={language === "ko" ? "빠른 명령 행동" : "Quick command action"}>
                <button
                  className={savedScriptEditor.action === "terminal" ? "active" : ""}
                  onClick={() => updateSavedScriptEditor({ action: "terminal" })}
                  type="button"
                  role="tab"
                  aria-selected={savedScriptEditor.action === "terminal"}
                >
                  <FileTerminal size={15} aria-hidden="true" />
                  {language === "ko" ? "Terminal 명령" : "Terminal command"}
                </button>
                <button
                  className={savedScriptEditor.action === "agent" ? "active" : ""}
                  onClick={() => updateSavedScriptEditor({ action: "agent" })}
                  type="button"
                  role="tab"
                  aria-selected={savedScriptEditor.action === "agent"}
                >
                  <Bot size={15} aria-hidden="true" />
                  {language === "ko" ? "Agent 프롬프트" : "Agent prompt"}
                </button>
              </div>
            </div>

            <label className="terminal-command-field">
              <span>{savedScriptEditor.action === "terminal" ? (language === "ko" ? "명령 텍스트" : "Command text") : (language === "ko" ? "프롬프트" : "Prompt")}</span>
              <textarea
                value={savedScriptEditor.command}
                onChange={(event) => updateSavedScriptEditor({ command: event.target.value })}
                placeholder={
                  savedScriptEditor.action === "terminal"
                    ? "pnpm run dev:admin-bo"
                    : language === "ko" ? "agent에게 이 워크스페이스를 조사하도록 요청하세요." : "Ask an agent to inspect this workspace."
                }
                maxLength={MAX_SAVED_TERMINAL_SCRIPT_LENGTH}
              />
            </label>

            <details className="terminal-command-advanced">
              <summary>{language === "ko" ? "고급" : "Advanced"}</summary>
            </details>

            <footer>
              <button
                className="terminal-command-cancel"
                onClick={() => setSavedScriptEditor(null)}
                type="button"
              >
                {language === "ko" ? "취소" : "Cancel"}
              </button>
              <button
                className="terminal-command-save"
                disabled={
                  savedScriptsBusy ||
                  !savedScriptEditor.name.trim() ||
                  !savedScriptEditor.command.trim()
                }
                type="submit"
              >
                {language === "ko" ? "저장" : "Save"}
                <kbd>⌘ Enter</kbd>
              </button>
            </footer>
          </form>
        </div>
      ) : null}
    </section>
  );
}, areTerminalScreenPropsEqual);

function areTerminalScreenPropsEqual(previous: TerminalScreenProps, next: TerminalScreenProps): boolean {
  return (
    previous.snapshot === next.snapshot &&
    previous.isActive === next.isActive &&
    previous.recents === next.recents &&
    previous.activeProjectId === next.activeProjectId
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

function cwdOptionsForPane(
  pane: TerminalPaneState,
  directories: TerminalDirectoryEntry[],
): TerminalDirectoryEntry[] {
  return [
    { path: pane.cwd, label: shortPath(pane.cwd), kind: "current" },
    ...directories.filter((directory) => directory.path !== pane.cwd),
  ];
}

function nodeRuntimeLabel(nodeBinPath: string | null, runtimes: NodeRuntimeSummary[]): string {
  if (!nodeBinPath) return "node shell";
  return (
    runtimes.find((runtime) => runtime.binPath === nodeBinPath)?.label ??
    `node ${shortPath(nodeBinPath)}`
  );
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

function loadTerminalPaneNames(): Record<string, string> {
  try {
    const raw = localStorage.getItem(terminalPaneNamesKey());
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed)
        .map(([id, name]) => [id, normalizeTerminalPaneName(String(name))])
        .filter(([, name]) => name),
    );
  } catch {
    return {};
  }
}

function saveTerminalPaneNames(names: Record<string, string>): void {
  try {
    localStorage.setItem(terminalPaneNamesKey(), JSON.stringify(names));
  } catch {
    // pane 이름도 편의 기능이라 저장 실패가 터미널 사용을 막으면 안 된다.
  }
}

function terminalPaneNamesKey(): string {
  return "helm.terminal.paneNames";
}

function normalizeTerminalPaneName(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, MAX_TERMINAL_PANE_NAME_LENGTH);
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

function normalizeSavedTerminalScript(value: string): string {
  return value.trim().replace(/\r\n/g, "\n").slice(0, MAX_SAVED_TERMINAL_SCRIPT_LENGTH);
}

function isSavedTerminalScriptCandidate(command: string): boolean {
  return (
    command.length > 0 &&
    command.length <= MAX_SAVED_TERMINAL_SCRIPT_LENGTH &&
    !containsSensitiveShellValue(command)
  );
}

function isTerminalCommandHistoryCandidate(command: string): boolean {
  if (command.length === 0 || command.length > MAX_TERMINAL_COMMAND_LENGTH) return false;
  return !containsSensitiveShellValue(command);
}

function containsSensitiveShellValue(command: string): boolean {
  const lowerCommand = command.toLowerCase();
  return /(password|passwd|token|secret|api[-_]?key|authorization)\s*=|bearer\s+\S+/i.test(lowerCommand);
}

function isDestructiveTerminalScript(command: string): boolean {
  return /(^|\s)(rm\s+-rf|sudo\s+rm|mkfs|dd\s+if=|git\s+clean\s+-fd|docker\s+system\s+prune|kubectl\s+delete)\b/i.test(command);
}

function savedScriptNameFromCommand(command: string): string {
  const firstLine = command.split("\n").find((line) => line.trim()) ?? "script";
  return firstLine.replace(/\s+/g, " ").slice(0, 48);
}

function singleLineScriptPreview(command: string): string {
  return command.replace(/\s+/g, " ").slice(0, 90);
}

function savedScriptActionFromTags(tags: string[]): SavedScriptAction {
  return tags.includes("action:agent_prompt") ? "agent" : "terminal";
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
