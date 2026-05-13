import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { runCommand, runCommandStream } from "../src/core/process.ts";
import { runCliWithContext, runCliWithContextAsync } from "../src/cli.ts";

const tempDir = mkdtempSync(join(tmpdir(), "helm-run-command-"));

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("run command", () => {
  it("streams command stdout and stderr", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    stdout.on("data", (chunk) => stdoutChunks.push(String(chunk)));
    stderr.on("data", (chunk) => stderrChunks.push(String(chunk)));

    const result = await runCommandStream(
      process.execPath,
      ["-e", "process.stdout.write('out'); process.stderr.write('err');"],
      { cwd: tempDir, stdout, stderr },
    );

    assert.equal(result.code, 0);
    assert.equal(result.stdout, "out");
    assert.equal(result.stderr, "err");
    assert.equal(stdoutChunks.join(""), "out");
    assert.equal(stderrChunks.join(""), "err");
  });

  it("creates a dry-run session", () => {
    runCommand("git", ["init"], { cwd: tempDir });

    const result = runCliWithContext(["run", "--agent", "codex", "--dry-run", "hello"], {
      cwd: tempDir,
    });

    assert.equal(result.code, 0);
    assert.match(result.stdout ?? "", /Session:/);
    assert.match(result.stdout ?? "", /Agent: codex/);

    const status = runCliWithContext(["status"], { cwd: tempDir });

    assert.equal(status.code, 0);
    assert.match(status.stdout ?? "", /completed/);
  });

  it("prints safe commit dry-run for session files", () => {
    const repoPath = mkdtempSync(join(tmpdir(), "helm-commit-command-"));

    try {
      runCommand("git", ["init"], { cwd: repoPath });
      writeFileSync(join(repoPath, "note.txt"), "hello\n");

      const run = runCliWithContext(["run", "--agent", "codex", "--dry-run", "hello"], {
        cwd: repoPath,
      });
      const sessionId = /Session: (?<id>\S+)/.exec(run.stdout ?? "")?.groups?.id;

      assert.ok(sessionId);

      const commit = runCliWithContext(["commit", sessionId, "--dry-run", "-m", "테스트"], {
        cwd: repoPath,
      });

      assert.equal(commit.code, 0);
      assert.match(commit.stdout ?? "", /Commit dry-run/);
      assert.match(commit.stdout ?? "", /note\.txt/);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it("streams agent output through the async run path", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "helm-stream-command-"));
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const originalGeminiBin = process.env.HELM_GEMINI_BIN;

    stdout.on("data", (chunk) => stdoutChunks.push(String(chunk)));
    stderr.on("data", (chunk) => stderrChunks.push(String(chunk)));

    try {
      process.env.HELM_GEMINI_BIN = process.execPath;
      runCommand("git", ["init"], { cwd: repoPath });

      const result = await runCliWithContextAsync(
        ["run", "--agent", "gemini", "'streamed'"],
        { cwd: repoPath, stdout, stderr },
      );

      assert.equal(result.code, 0);
      assert.match(result.stdout ?? "", /Session:/);
      assert.match(stdoutChunks.join(""), /streamed/);
      assert.equal(stderrChunks.join(""), "");
    } finally {
      if (originalGeminiBin === undefined) {
        delete process.env.HELM_GEMINI_BIN;
      } else {
        process.env.HELM_GEMINI_BIN = originalGeminiBin;
      }

      rmSync(repoPath, { recursive: true, force: true });
    }
  });
});
