import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runCliWithContext } from "../src/cli.ts";
import { runCommand } from "../src/core/process.ts";
import {
  createSession,
  createSessionStore,
  getSessionStore,
  readSession,
  saveSession,
} from "../src/session/store.ts";
import type { GitSnapshot } from "../src/workspace/git.ts";

describe("pr command", () => {
  it("prints a PR dry-run for a committed session", () => {
    const repoPath = createGitRepo();

    try {
      const sessionId = saveTestSession(repoPath);
      const result = runCliWithContext(
        ["pr", sessionId, "--dry-run", "--base", "develop", "--title", "테스트 PR"],
        { cwd: repoPath },
      );

      assert.equal(result.code, 0);
      assert.match(result.stdout ?? "", /PR dry-run/);
      assert.match(result.stdout ?? "", /Branch: feature\/test/);
      assert.match(result.stdout ?? "", /Base: develop/);
      assert.match(result.stdout ?? "", /Title: 테스트 PR/);
      assert.match(result.stdout ?? "", /git push -u origin feature\/test/);
      assert.match(result.stdout ?? "", /gh pr create --base develop --head feature\/test/);
      assert.match(result.stdout ?? "", /--draft/);
      assert.match(result.stdout ?? "", new RegExp(`Session: \`${sessionId}\``));
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it("rejects sessions without commits", () => {
    const repoPath = createGitRepo();

    try {
      const sessionId = saveTestSession(repoPath, { commitHash: undefined });
      const result = runCliWithContext(["pr", sessionId, "--dry-run"], { cwd: repoPath });

      assert.equal(result.code, 1);
      assert.match(result.stderr ?? "", /커밋된 세션만/);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it("rejects sessions with failed checks", () => {
    const repoPath = createGitRepo();

    try {
      const sessionId = saveTestSession(repoPath, { checkExitCode: 1 });
      const result = runCliWithContext(["pr", sessionId, "--dry-run"], { cwd: repoPath });

      assert.equal(result.code, 1);
      assert.match(result.stderr ?? "", /실패한 check/);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it("pushes the branch, creates a PR, and stores PR metadata", () => {
    const repoPath = createGitRepo();
    const remotePath = mkdtempSync(join(tmpdir(), "helm-pr-remote-"));
    const binPath = mkdtempSync(join(tmpdir(), "helm-pr-bin-"));
    const originalPath = process.env.PATH;

    try {
      writeFileSync(join(repoPath, "README.md"), "hello\n");
      runCommand("git", ["config", "user.email", "test@example.com"], { cwd: repoPath });
      runCommand("git", ["config", "user.name", "Test User"], { cwd: repoPath });
      runCommand("git", ["add", "README.md"], { cwd: repoPath });
      runCommand("git", ["commit", "-m", "테스트 커밋"], { cwd: repoPath });
      runCommand("git", ["init", "--bare"], { cwd: remotePath });
      runCommand("git", ["remote", "add", "origin", remotePath], { cwd: repoPath });

      const commitHash = runCommand("git", ["rev-parse", "--short", "HEAD"], {
        cwd: repoPath,
      }).stdout.trim();
      const sessionId = saveTestSession(repoPath, { commitHash });
      const ghPath = join(binPath, "gh");

      writeFileSync(ghPath, "#!/bin/sh\nprintf '%s\\n' 'https://github.com/test/repo/pull/1'\n");
      chmodSync(ghPath, 0o755);
      process.env.PATH = `${binPath}:${originalPath ?? ""}`;

      const result = runCliWithContext(["pr", sessionId, "--base", "main", "--title", "테스트 PR"], {
        cwd: repoPath,
      });
      const session = readSession(getSessionStore(repoPath), sessionId);

      assert.equal(result.code, 0);
      assert.match(result.stdout ?? "", /PR created/);
      assert.equal(session.prUrl, "https://github.com/test/repo/pull/1");
      assert.equal(session.prBase, "main");
      assert.equal(session.prTitle, "테스트 PR");
      assert.equal(session.prDraft, true);
    } finally {
      process.env.PATH = originalPath;
      rmSync(repoPath, { recursive: true, force: true });
      rmSync(remotePath, { recursive: true, force: true });
      rmSync(binPath, { recursive: true, force: true });
    }
  });
});

function createGitRepo(): string {
  const repoPath = mkdtempSync(join(tmpdir(), "helm-pr-command-"));

  runCommand("git", ["init"], { cwd: repoPath });
  runCommand("git", ["checkout", "-b", "feature/test"], { cwd: repoPath });

  return repoPath;
}

function saveTestSession(
  repoPath: string,
  overrides: { commitHash?: string; checkExitCode?: number } = {},
): string {
  const store = createSessionStore(repoPath);
  const session = createSession(store, snapshot(repoPath), new Date("2026-05-13T00:00:00.000Z"));

  session.status = "committed";
  session.agent = "codex";
  session.prompt = "테스트 변경사항을 정리해줘";
  session.exitCode = 0;
  session.changedFiles = ["README.md"];
  session.logPath = join(store.sessionsPath, `${session.id}.log`);
  session.diffPath = join(store.sessionsPath, `${session.id}.diff`);
  session.checkCommand = "npm run check";
  session.checkExitCode = overrides.checkExitCode ?? 0;
  session.checkLogPath = join(store.sessionsPath, `${session.id}.check.log`);

  if (overrides.commitHash !== undefined) {
    session.commitHash = overrides.commitHash;
  } else if (!("commitHash" in overrides)) {
    session.commitHash = "abc1234";
  }

  saveSession(store, session);

  return session.id;
}

function snapshot(repoPath: string): GitSnapshot {
  return {
    repoPath,
    branch: "feature/test",
    head: "abc1234",
    status: [],
    capturedAt: "2026-05-13T00:00:00.000Z",
  };
}
