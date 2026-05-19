import {
  CornerDownLeft,
  Folder,
  GitBranch,
  Plus,
  SplitSquareHorizontal,
  SquareTerminal,
  Terminal,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { ProjectSnapshot, TerminalCommandResult } from "../lib/types";

interface TerminalScreenProps {
  snapshot: ProjectSnapshot | null;
  onOpenProject: () => void;
}

interface TerminalPaneState {
  id: string;
  cwd: string;
  command: string;
  running: boolean;
  error: string | null;
  history: TerminalCommandResult[];
}

function createPane(cwd: string): TerminalPaneState {
  return {
    id: crypto.randomUUID(),
    cwd,
    command: "",
    running: false,
    error: null,
    history: [],
  };
}

export function TerminalScreen({ snapshot, onOpenProject }: TerminalScreenProps) {
  const [panes, setPanes] = useState<TerminalPaneState[]>(() =>
    snapshot ? [createPane(snapshot.project.rootPath)] : [],
  );
  const [activePaneId, setActivePaneId] = useState<string | null>(panes[0]?.id ?? null);
  const paneRefs = useRef(new Map<string, HTMLElement>());
  const outputRefs = useRef(new Map<string, HTMLDivElement>());
  const inputRefs = useRef(new Map<string, HTMLInputElement>());

  const selectedPaneId = activePaneId ?? panes[0]?.id ?? null;
  const activePane = panes.find((pane) => pane.id === selectedPaneId) ?? panes[0] ?? null;
  const usesSplitScroll = panes.length >= 5;

  useEffect(() => {
    if (!snapshot) return;
    const firstPane = createPane(snapshot.project.rootPath);
    setPanes([firstPane]);
    setActivePaneId(firstPane.id);
  }, [snapshot?.project.id]);

  useEffect(() => {
    if (!selectedPaneId) return;
    paneRefs.current.get(selectedPaneId)?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
      inline: "start",
    });
  }, [selectedPaneId, panes.length]);

  useEffect(() => {
    for (const pane of panes) {
      const output = outputRefs.current.get(pane.id);
      output?.scrollTo({ top: output.scrollHeight });
    }
  }, [panes]);

  function setPaneRef(id: string, node: HTMLElement | null) {
    if (node) paneRefs.current.set(id, node);
    else paneRefs.current.delete(id);
  }

  function setOutputRef(id: string, node: HTMLDivElement | null) {
    if (node) outputRefs.current.set(id, node);
    else outputRefs.current.delete(id);
  }

  function setInputRef(id: string, node: HTMLInputElement | null) {
    if (node) inputRefs.current.set(id, node);
    else inputRefs.current.delete(id);
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

  function updatePane(id: string, patch: Partial<TerminalPaneState>) {
    setPanes((current) => current.map((pane) => (pane.id === id ? { ...pane, ...patch } : pane)));
  }

  function addPane() {
    const nextPane = createPane(activePane?.cwd ?? snapshot?.project.rootPath ?? "");
    setPanes((current) => [...current, nextPane]);
    setActivePaneId(nextPane.id);
    requestAnimationFrame(() => inputRefs.current.get(nextPane.id)?.focus());
  }

  function removePane(id: string) {
    const target = panes.find((pane) => pane.id === id);
    if (!target || target.running) return;

    const targetIndex = panes.findIndex((pane) => pane.id === id);
    const nextPanes = panes.filter((pane) => pane.id !== id);
    setPanes(nextPanes);
    if (selectedPaneId === id) {
      setActivePaneId(nextPanes[Math.min(targetIndex, nextPanes.length - 1)]?.id ?? null);
    }
  }

  async function runCommand(pane: TerminalPaneState) {
    const nextCommand = pane.command.trim();
    if (!snapshot || !nextCommand || pane.running) return;

    updatePane(pane.id, { command: "", running: true, error: null });
    try {
      const cdTarget = parseCdTarget(nextCommand);
      if (cdTarget !== null) {
        const nextCwd = await api.resolveTerminalCwd(snapshot.project.id, pane.cwd, cdTarget);
        const result = createCdResult(pane.cwd, nextCommand, nextCwd);
        setPanes((current) =>
          current.map((item) =>
            item.id === pane.id
              ? { ...item, cwd: nextCwd, history: [...item.history, result], running: false }
              : item,
          ),
        );
      } else {
        const result = await api.runTerminalCommand(snapshot.project.id, pane.cwd, nextCommand);
        setPanes((current) =>
          current.map((item) =>
            item.id === pane.id
              ? { ...item, history: [...item.history, result], running: false }
              : item,
          ),
        );
      }
    } catch (err) {
      updatePane(pane.id, { running: false, error: errorMessage(err) });
    } finally {
      requestAnimationFrame(() => inputRefs.current.get(pane.id)?.focus());
    }
  }

  function renderPane(pane: TerminalPaneState, index: number) {
    const canRun = pane.command.trim().length > 0 && !pane.running;
    const lastResult = pane.history.at(-1) ?? null;

    return (
      <article
        className={selectedPaneId === pane.id ? "terminal-pane active" : "terminal-pane"}
        key={pane.id}
        ref={(node) => setPaneRef(pane.id, node)}
        onFocusCapture={() => setActivePaneId(pane.id)}
      >
        <header className="terminal-pane-header">
          <div>
            <span className={pane.running ? "terminal-dot running" : "terminal-dot"} aria-hidden="true" />
            <strong>pane {index + 1}</strong>
            <small>{shortPath(pane.cwd)}</small>
          </div>
          <button
            className="terminal-close-pane"
            disabled={pane.running}
            onClick={() => removePane(pane.id)}
            title="터미널 닫기"
            type="button"
            aria-label={`pane ${index + 1} 닫기`}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </header>

        <div className="terminal-cwd-bar">
          <Folder size={14} aria-hidden="true" />
          <span>{pane.cwd}</span>
        </div>

        <div
          className="terminal-console"
          ref={(node) => setOutputRef(pane.id, node)}
          onClick={() => inputRefs.current.get(pane.id)?.focus()}
        >
          {pane.history.length === 0 ? (
            <p className="terminal-console-empty">명령어를 입력하고 Enter 키를 누르세요.</p>
          ) : null}
          {pane.history.map((item, outputIndex) => (
            <article className="terminal-entry" key={`${item.command}-${outputIndex}`}>
              <div className="terminal-entry-command">
                <span>{item.cwd}</span>
                <strong>$ {item.command}</strong>
              </div>
              {item.stdout ? <pre>{item.stdout}</pre> : null}
              {item.stderr ? <pre className="stderr-output">{item.stderr}</pre> : null}
              <footer className={item.exitCode === 0 ? "ok" : "failed"}>
                exit {item.exitCode}
                {item.timedOut ? " · timeout" : ""}
              </footer>
            </article>
          ))}
          {pane.running ? (
            <div className="terminal-running">
              <span className="terminal-dot running" aria-hidden="true" />
              실행 중
            </div>
          ) : null}
        </div>

        {pane.error ? <div className="error-banner terminal-pane-error">{pane.error}</div> : null}

        <form
          className="terminal-input-row"
          onSubmit={(event) => {
            event.preventDefault();
            void runCommand(pane);
          }}
        >
          <Terminal size={15} aria-hidden="true" />
          <span>$</span>
          <input
            ref={(node) => setInputRef(pane.id, node)}
            value={pane.command}
            onChange={(event) => updatePane(pane.id, { command: event.target.value })}
            placeholder="명령어 입력"
            spellCheck={false}
          />
          <button disabled={!canRun} title="명령 실행" type="submit">
            <CornerDownLeft size={15} aria-hidden="true" />
          </button>
        </form>

        <footer className="terminal-pane-status">
          <span>{shortPath(pane.cwd)}</span>
          {lastResult ? (
            <span className={lastResult.exitCode === 0 ? "ok" : "failed"}>
              exit {lastResult.exitCode}
              {lastResult.timedOut ? " · timeout" : ""}
            </span>
          ) : (
            <span>ready</span>
          )}
        </footer>
      </article>
    );
  }

  return (
    <section className="terminal-screen">
      <header className="terminal-header">
        <div>
          <h2>터미널</h2>
          <p>{snapshot.project.name} · pane별 cwd를 유지하며 직접 명령을 실행합니다.</p>
        </div>
        <button className="terminal-add-pane" onClick={addPane} type="button">
          <Plus size={14} aria-hidden="true" />
          <span>pane 추가</span>
        </button>
      </header>

      <div className="terminal-workbench">
        <aside className="terminal-workspaces" aria-label="터미널 워크스페이스">
          <div className="terminal-workspaces-title">
            <SquareTerminal size={15} aria-hidden="true" />
            <span>Sessions</span>
          </div>
          <nav className="terminal-tab-strip" aria-label="열린 터미널">
            {panes.map((pane, index) => {
              const lastResult = pane.history.at(-1) ?? null;
              return (
                <div
                  className={
                    selectedPaneId === pane.id ? "terminal-session-row active" : "terminal-session-row"
                  }
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
                          : lastResult && lastResult.exitCode !== 0
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
                    disabled={pane.running}
                    onClick={() => removePane(pane.id)}
                    title="pane 삭제"
                    type="button"
                    aria-label={`pane ${index + 1} 삭제`}
                  >
                    <X size={13} aria-hidden="true" />
                  </button>
                </div>
              );
            })}
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
            <div>
              <SplitSquareHorizontal size={15} aria-hidden="true" />
              <span>
                {panes.length} pane{panes.length === 1 ? "" : "s"}
              </span>
            </div>
            <div>
              <span>{activePane ? shortPath(activePane.cwd) : "no pane"}</span>
              <span>{repository.stagedCount} staged</span>
              <span>{repository.untrackedCount} untracked</span>
            </div>
          </div>

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

function parseCdTarget(command: string): string | null {
  if (command === "cd") return "";
  const match = command.match(/^cd\s+(.+)$/);
  if (!match) return null;
  return stripMatchingQuotes(match[1].trim());
}

function stripMatchingQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function createCdResult(cwd: string, command: string, nextCwd: string): TerminalCommandResult {
  return {
    cwd,
    command,
    stdout: `${nextCwd}\n`,
    stderr: "",
    exitCode: 0,
    timedOut: false,
  };
}

function shortPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 2) return path || "/";
  return `.../${parts.slice(-2).join("/")}`;
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  if (error instanceof Error) return error.message;
  return "터미널 명령 실행에 실패했습니다.";
}
