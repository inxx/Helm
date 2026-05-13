import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { runCommand } from "../src/core/process.ts";
import { runCliWithContext } from "../src/cli.ts";

const tempDir = mkdtempSync(join(tmpdir(), "helm-run-command-"));

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("run command", () => {
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
});
