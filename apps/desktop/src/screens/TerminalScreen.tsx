import { useMemo, useState } from "react";
import { api } from "../lib/api";
import type { ProjectSnapshot, TerminalCommandResult } from "../lib/types";

interface TerminalScreenProps {
  snapshot: ProjectSnapshot | null;
}

type CwdMode = "project" | "worktree";

export function TerminalScreen({ snapshot }: TerminalScreenProps) {
  const [cwdMode, setCwdMode] = useState<CwdMode>("project");
  const [taskId, setTaskId] = useState("");
  const [command, setCommand] = useState("pwd");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<TerminalCommandResult[]>([]);

  const taskOptions = useMemo(() => snapshot?.tasks ?? [], [snapshot]);

  if (!snapshot) {
    return (
      <section className="empty-state">
        <h2>터미널</h2>
        <p>프로젝트를 먼저 열어주세요.</p>
      </section>
    );
  }

  async function runCommand() {
    if (!snapshot) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.runTerminalCommand(
        snapshot.project.id,
        cwdMode,
        cwdMode === "worktree" ? taskId || null : null,
        command,
      );
      setHistory((current) => [result, ...current]);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="content-panel terminal-screen">
      <div className="terminal-header">
        <div>
          <h2>터미널</h2>
          <p className="muted">프로젝트 root 또는 태스크 worktree에서 명령을 실행합니다.</p>
        </div>
      </div>

      <div className="terminal-controls">
        <label>
          <span>CWD</span>
          <select value={cwdMode} onChange={(event) => setCwdMode(event.target.value as CwdMode)}>
            <option value="project">프로젝트 root</option>
            <option value="worktree">태스크 worktree</option>
          </select>
        </label>
        {cwdMode === "worktree" ? (
          <label>
            <span>Task</span>
            <select value={taskId} onChange={(event) => setTaskId(event.target.value)}>
              <option value="">태스크 선택</option>
              {taskOptions.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.title}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="terminal-command">
          <span>Command</span>
          <input
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !busy) {
                void runCommand();
              }
            }}
          />
        </label>
        <button disabled={busy} onClick={runCommand} type="button">
          실행
        </button>
      </div>

      {error ? <div className="error-banner">{error}</div> : null}

      <div className="terminal-output-list">
        {history.length === 0 ? <p className="muted">아직 실행한 명령이 없습니다.</p> : null}
        {history.map((item, index) => (
          <article className="terminal-output" key={`${item.command}-${item.cwd}-${index}`}>
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
