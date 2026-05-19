import { CornerDownLeft, Folder, GitBranch, Terminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { ProjectSnapshot, TerminalCommandResult } from "../lib/types";

interface TerminalScreenProps {
  snapshot: ProjectSnapshot | null;
  onOpenProject: () => void;
}

export function TerminalScreen({ snapshot, onOpenProject }: TerminalScreenProps) {
  const [cwd, setCwd] = useState(() => snapshot?.project.rootPath ?? "");
  const [command, setCommand] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<TerminalCommandResult[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const outputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (snapshot) setCwd(snapshot.project.rootPath);
  }, [snapshot?.project.id]);

  useEffect(() => {
    outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight });
  }, [history.length, running]);

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
  const canRun = command.trim().length > 0 && !running;

  async function runCommand() {
    if (!snapshot || !canRun) return;
    const nextCommand = command.trim();
    setCommand("");
    setRunning(true);
    setError(null);

    try {
      const cdTarget = parseCdTarget(nextCommand);
      if (cdTarget !== null) {
        const nextCwd = await api.resolveTerminalCwd(snapshot.project.id, cwd, cdTarget);
        const result = createCdResult(cwd, nextCommand, nextCwd);
        setCwd(nextCwd);
        setHistory((current) => [...current, result]);
      } else {
        const result = await api.runTerminalCommand(snapshot.project.id, cwd, nextCommand);
        setHistory((current) => [...current, result]);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRunning(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }

  return (
    <section className="terminal-screen">
      <header className="terminal-header">
        <div>
          <h2>터미널</h2>
          <p>{snapshot.project.name} · 현재 경로에서 직접 명령을 실행합니다.</p>
        </div>
        <div className="terminal-header-state" aria-label="저장소 상태">
          <span>
            <GitBranch size={13} aria-hidden="true" />
            {repository.currentBranch ?? "detached"}
          </span>
          <span>{repository.dirtyCount === 0 ? "clean" : `${repository.dirtyCount} changed`}</span>
        </div>
      </header>

      <div className="terminal-single">
        <div className="terminal-cwd-bar">
          <Folder size={14} aria-hidden="true" />
          <span>{cwd}</span>
        </div>

        <div className="terminal-console" ref={outputRef} onClick={() => inputRef.current?.focus()}>
          {history.length === 0 ? (
            <p className="terminal-console-empty">명령어를 입력하고 Enter 키를 누르세요.</p>
          ) : null}
          {history.map((item, index) => (
            <article className="terminal-entry" key={`${item.command}-${index}`}>
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
          {running ? (
            <div className="terminal-running">
              <span className="terminal-dot running" aria-hidden="true" />
              실행 중
            </div>
          ) : null}
        </div>

        {error ? <div className="error-banner">{error}</div> : null}

        <form
          className="terminal-input-row"
          onSubmit={(event) => {
            event.preventDefault();
            void runCommand();
          }}
        >
          <Terminal size={15} aria-hidden="true" />
          <span>$</span>
          <input
            ref={inputRef}
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            placeholder="명령어 입력"
            spellCheck={false}
            autoFocus
          />
          <button disabled={!canRun} title="명령 실행" type="submit">
            <CornerDownLeft size={15} aria-hidden="true" />
          </button>
        </form>
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

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  if (error instanceof Error) return error.message;
  return "터미널 명령 실행에 실패했습니다.";
}
