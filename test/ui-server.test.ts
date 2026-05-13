import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runCommand } from "../src/core/process.ts";
import { createSession, createSessionStore, saveSession } from "../src/session/store.ts";
import { createUiSnapshot } from "../src/ui/server.ts";
import type { GitSnapshot } from "../src/workspace/git.ts";

describe("ui server", () => {
  it("builds a dashboard snapshot from git status and sessions", () => {
    const repoPath = mkdtempSync(join(tmpdir(), "helm-ui-snapshot-"));

    try {
      runCommand("git", ["init"], { cwd: repoPath });
      writeFileSync(join(repoPath, "note.txt"), "hello\n");
      saveDashboardSession(repoPath);

      const snapshot = createUiSnapshot(repoPath, new Date("2026-05-13T00:00:00.000Z"));

      assert.equal(snapshot.repo.path, repoPath);
      assert.ok(snapshot.repo.dirtyCount > 0);
      assert.match(snapshot.repo.statusText, /note\.txt/);
      assert.equal(snapshot.repo.capturedAt, "2026-05-13T00:00:00.000Z");
      assert.equal(snapshot.totals.sessions, 1);
      assert.equal(snapshot.totals.completed, 1);
      assert.equal(snapshot.sessions[0].agent, "codex");
      assert.equal(snapshot.sessions[0].artifacts.logPreview, "log output\n");
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });
});

function saveDashboardSession(repoPath: string): void {
  const store = createSessionStore(repoPath);
  const session = createSession(store, snapshot(repoPath), new Date("2026-05-13T00:00:00.000Z"));
  const logPath = join(store.sessionsPath, `${session.id}.log`);

  mkdirSync(store.sessionsPath, { recursive: true });
  writeFileSync(logPath, "log output\n");

  session.status = "completed";
  session.agent = "codex";
  session.prompt = "테스트 세션을 요약해줘";
  session.command = ["codex", "exec", "테스트 세션을 요약해줘"];
  session.exitCode = 0;
  session.changedFiles = ["note.txt"];
  session.logPath = logPath;
  session.updatedAt = "2026-05-13T00:00:00.000Z";
  saveSession(store, session);
}

function snapshot(repoPath: string): GitSnapshot {
  return {
    repoPath,
    branch: "main",
    head: null,
    status: [],
    capturedAt: "2026-05-13T00:00:00.000Z",
  };
}
