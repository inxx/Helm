import assert from "node:assert/strict";
import test from "node:test";
import { terminalPanesForProject } from "./terminalPanes.ts";
import type { TerminalPtySummary } from "./types";

test("terminalPanesForProject restores existing PTY ids", () => {
  const panes = terminalPanesForProject("active-project", "/repo", [
    session({ terminalId: "pty-1", projectId: "other-project", cwd: "/repo", running: true }),
    session({ terminalId: "pty-2", cwd: "/repo/apps/web", running: false, exitCode: 0 }),
  ]);

  assert.deepEqual(
    panes.map((pane) => ({
      id: pane.id,
      projectId: pane.projectId,
      cwd: pane.cwd,
      running: pane.running,
      exitCode: pane.exitCode,
    })),
    [
      { id: "pty-1", projectId: "other-project", cwd: "/repo", running: true, exitCode: null },
      { id: "pty-2", projectId: "project", cwd: "/repo/apps/web", running: false, exitCode: 0 },
    ],
  );
});

test("terminalPanesForProject creates one idle pane when no PTY exists", () => {
  const [pane] = terminalPanesForProject("project", "/repo", []);

  assert.equal(pane.projectId, "project");
  assert.equal(pane.cwd, "/repo");
  assert.equal(pane.nodeBinPath, null);
  assert.equal(pane.running, false);
});

function session(overrides: Partial<TerminalPtySummary>): TerminalPtySummary {
  return {
    terminalId: "pty",
    projectId: "project",
    cwd: "/repo",
    nodeBinPath: null,
    cols: 120,
    rows: 30,
    running: true,
    exitCode: null,
    seq: 1,
    createdAt: "2026-06-18T00:00:00.000Z",
    updatedAt: "2026-06-18T00:00:00.000Z",
    ...overrides,
  };
}
