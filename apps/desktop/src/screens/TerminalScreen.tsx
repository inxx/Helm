import { X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import type { ProjectSnapshot, TerminalCommandResult } from "../lib/types";

interface TerminalScreenProps {
  snapshot: ProjectSnapshot | null;
  onOpenProject: () => void;
}

type CwdMode = "project" | "worktree";

interface TerminalPaneState {
  id: string;
  cwdMode: CwdMode;
  taskId: string;
  command: string;
  running: boolean;
  error: string | null;
  history: TerminalCommandResult[];
}

function createPane(command = "pwd"): TerminalPaneState {
  return {
    id: crypto.randomUUID(),
    cwdMode: "project",
    taskId: "",
    command,
    running: false,
    error: null,
    history: [],
  };
}

export function TerminalScreen({ snapshot, onOpenProject }: TerminalScreenProps) {
  const [panes, setPanes] = useState<TerminalPaneState[]>(() => [createPane()]);
  const [activePaneId, setActivePaneId] = useState<string | null>(null);
  const paneRefs = useRef(new Map<string, HTMLElement>());

  const taskOptions = useMemo(() => snapshot?.tasks ?? [], [snapshot]);
  const usesSplitScroll = panes.length >= 5;
  const selectedPaneId = activePaneId ?? panes[0]?.id ?? null;

  useEffect(() => {
    if (!selectedPaneId) return;
    paneRefs.current.get(selectedPaneId)?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
      inline: "start",
    });
  }, [selectedPaneId, panes.length]);

  function setPaneRef(id: string, node: HTMLElement | null) {
    if (node) {
      paneRefs.current.set(id, node);
    } else {
      paneRefs.current.delete(id);
    }
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

  const projectRootPath = snapshot.project.rootPath;

  function updatePane(id: string, patch: Partial<TerminalPaneState>) {
    setPanes((current) => current.map((pane) => (pane.id === id ? { ...pane, ...patch } : pane)));
  }

  function addPane() {
    const nextPane = createPane(panes.at(-1)?.command ?? "pwd");
    setPanes((current) => [...current, nextPane]);
    setActivePaneId(nextPane.id);
  }

  function removePane(id: string) {
    const targetIndex = panes.findIndex((pane) => pane.id === id);
    const targetPane = panes[targetIndex];
    if (!targetPane || targetPane.running) return;

    const nextPanes = panes.filter((pane) => pane.id !== id);
    setPanes(nextPanes);
    if (selectedPaneId === id) {
      setActivePaneId(nextPanes[Math.min(targetIndex, nextPanes.length - 1)]?.id ?? null);
    }
  }

  function selectPane(id: string) {
    setActivePaneId(id);
  }

  async function runCommand(pane: TerminalPaneState) {
    if (!snapshot) return;
    updatePane(pane.id, { running: true, error: null });
    try {
      const result = await api.runTerminalCommand(
        snapshot.project.id,
        pane.cwdMode,
        pane.cwdMode === "worktree" ? pane.taskId || null : null,
        pane.command,
      );
      setPanes((current) =>
        current.map((item) =>
          item.id === pane.id
            ? { ...item, history: [result, ...item.history], running: false, error: null }
            : item,
        ),
      );
    } catch (err) {
      updatePane(pane.id, { running: false, error: errorMessage(err) });
    }
  }

  function renderPane(pane: TerminalPaneState, index: number) {
    const worktreeTaskMissing = pane.cwdMode === "worktree" && !pane.taskId;
    const commandMissing = !pane.command.trim();
    return (
      <article
        className={selectedPaneId === pane.id ? "terminal-pane active" : "terminal-pane"}
        key={pane.id}
        ref={(node) => setPaneRef(pane.id, node)}
        onFocusCapture={() => selectPane(pane.id)}
      >
        <header className="terminal-pane-header">
          <strong>pane {index + 1}</strong>
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
        <div className="terminal-controls">
          <label>
            <span>cwd</span>
            <select
              value={pane.cwdMode}
              onChange={(event) =>
                updatePane(pane.id, {
                  cwdMode: event.target.value as CwdMode,
                  taskId: event.target.value === "project" ? "" : pane.taskId,
                })
              }
            >
              <option value="project">프로젝트 root</option>
              <option value="worktree">태스크 worktree</option>
            </select>
          </label>
          {pane.cwdMode === "worktree" ? (
            <label>
              <span>task</span>
              <select
                value={pane.taskId}
                onChange={(event) => updatePane(pane.id, { taskId: event.target.value })}
              >
                <option value="">태스크 선택</option>
                {taskOptions.map((task) => (
                  <option key={task.id} value={task.id}>
                    {task.title}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label aria-hidden>
              <span>cwd path</span>
              <input value={projectRootPath} readOnly />
            </label>
          )}
          <label className="terminal-command">
            <span>command</span>
            <input
              value={pane.command}
              onChange={(event) => updatePane(pane.id, { command: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !pane.running && !worktreeTaskMissing && !commandMissing) {
                  void runCommand(pane);
                }
              }}
            />
          </label>
          <button
            disabled={pane.running || worktreeTaskMissing || commandMissing}
            onClick={() => runCommand(pane)}
            type="button"
          >
            {pane.running ? "실행 중" : "실행"}
          </button>
        </div>

        <div className="terminal-output-list">
          {pane.error ? <div className="error-banner">{pane.error}</div> : null}
          {worktreeTaskMissing ? <div className="error-banner">태스크 worktree를 선택해주세요.</div> : null}
          {pane.history.length === 0 ? (
            <p className="muted">아직 실행한 명령이 없습니다. 명령을 입력하고 Enter 키를 누르세요.</p>
          ) : null}
          {pane.history.map((item, outputIndex) => (
            <article className="terminal-output" key={`${item.command}-${item.cwd}-${outputIndex}`}>
              <header>
                <strong>$ {item.command}</strong>
                <span>
                  exit {item.exitCode}
                  {item.timedOut ? " · timeout" : ""}
                </span>
              </header>
              <p>{item.cwd}</p>
              {item.stdout ? <pre>{item.stdout}</pre> : null}
              {item.stderr ? <pre className="stderr-output">{item.stderr}</pre> : null}
            </article>
          ))}
        </div>
      </article>
    );
  }

  return (
    <section className="terminal-screen">
      <header className="terminal-header">
        <div>
          <h2>터미널</h2>
          <p>프로젝트 root와 태스크 worktree 명령을 pane별로 나눠 실행합니다.</p>
        </div>
        <button className="terminal-add-pane" onClick={addPane} type="button">
          pane 추가
        </button>
      </header>

      {panes.length > 0 ? (
        <nav className="terminal-tab-strip" aria-label="열린 터미널">
          {panes.map((pane, index) => (
            <button
              className={selectedPaneId === pane.id ? "active" : ""}
              key={pane.id}
              onClick={() => selectPane(pane.id)}
              type="button"
            >
              <span className={pane.running ? "running" : ""} aria-hidden="true" />
              <strong>pane {index + 1}</strong>
              <small>{pane.cwdMode === "worktree" ? "worktree" : "root"}</small>
            </button>
          ))}
        </nav>
      ) : null}

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
              터미널 추가
            </button>
          </div>
        ) : (
          panes.map((pane, index) => renderPane(pane, index))
        )}
      </div>
    </section>
  );
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  if (error instanceof Error) return error.message;
  return "터미널 명령 실행에 실패했습니다.";
}
