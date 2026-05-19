import { useMemo, useState } from "react";
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

  const taskOptions = useMemo(() => snapshot?.tasks ?? [], [snapshot]);

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

  function updatePane(id: string, patch: Partial<TerminalPaneState>) {
    setPanes((current) => current.map((pane) => (pane.id === id ? { ...pane, ...patch } : pane)));
  }

  function addPane() {
    setPanes((current) => [...current, createPane(current.at(-1)?.command ?? "pwd")]);
  }

  function removePane(id: string) {
    setPanes((current) => (current.length === 1 ? current : current.filter((pane) => pane.id !== id)));
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

      <div className={panes.length >= 4 ? "terminal-pane-grid split-scroll" : "terminal-pane-grid"}>
        {panes.map((pane, index) => {
          const worktreeTaskMissing = pane.cwdMode === "worktree" && !pane.taskId;
          const commandMissing = !pane.command.trim();
          return (
            <article className="terminal-pane" key={pane.id}>
              <header className="terminal-pane-header">
                <strong>pane {index + 1}</strong>
                <button
                  disabled={panes.length === 1 || pane.running}
                  onClick={() => removePane(pane.id)}
                  type="button"
                >
                  닫기
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
                    <input value={snapshot.project.rootPath} readOnly />
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
        })}
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
