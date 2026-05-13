import { mkdtempSync, rmSync } from "node:fs";
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
});
