import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runCommand } from "../src/core/process.ts";
import { runCli } from "../src/cli.ts";

describe("runCli", () => {
  it("prints help by default", () => {
    const result = runCli([]);

    assert.equal(result.code, 0);
    assert.match(result.stdout ?? "", /Usage:/);
  });

  it("prints version", () => {
    const result = runCli(["version"]);

    assert.equal(result.code, 0);
    assert.match(result.stdout ?? "", /^0\.1\.0/);
  });

  it("prints planned agents", () => {
    const result = runCli(["agents"]);

    assert.equal(result.code, 0);
    assert.match(result.stdout ?? "", /codex/);
    assert.match(result.stdout ?? "", /claude/);
    assert.match(result.stdout ?? "", /gemini/);
  });

  it("rejects unknown commands", () => {
    const result = runCli(["missing"]);

    assert.equal(result.code, 1);
    assert.match(result.stderr ?? "", /알 수 없는 명령/);
  });

  it("runs through a symlinked bin path", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "helm-bin-link-"));

    try {
      const binPath = join(tempDir, "helm");
      symlinkSync(join(process.cwd(), "src/cli.ts"), binPath);

      const result = runCommand(binPath, ["version"], { cwd: tempDir });

      assert.equal(result.code, 0);
      assert.match(result.stdout, /^0\.1\.0/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
