import type { TerminalPtySummary } from "./types";

export interface TerminalPaneState {
  id: string;
  projectId: string | null;
  cwd: string;
  nodeBinPath: string | null;
  running: boolean;
  error: string | null;
  exitCode: number | null;
}

export function createTerminalPane(
  projectId: string | null,
  cwd: string,
  nodeBinPath: string | null,
): TerminalPaneState {
  return {
    id: crypto.randomUUID(),
    projectId,
    cwd,
    nodeBinPath,
    running: false,
    error: null,
    exitCode: null,
  };
}

export function terminalPaneFromSession(session: TerminalPtySummary): TerminalPaneState {
  return {
    id: session.terminalId,
    projectId: session.projectId,
    cwd: session.cwd,
    nodeBinPath: session.nodeBinPath,
    running: session.running,
    error: null,
    exitCode: session.exitCode,
  };
}

export function terminalPanesForProject(
  projectId: string | null,
  projectRoot: string,
  sessions: TerminalPtySummary[],
): TerminalPaneState[] {
  return sessions.length > 0
    ? sessions.map(terminalPaneFromSession)
    : [createTerminalPane(projectId, projectRoot, null)];
}
