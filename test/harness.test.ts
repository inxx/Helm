import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildAgentCommand, isAgentName } from "../src/harness/agents.ts";

describe("agents", () => {
  it("builds Codex exec commands", () => {
    assert.deepEqual(buildAgentCommand("codex", "hello"), {
      command: "codex",
      args: ["exec", "hello"],
    });
  });

  it("builds Claude prompt commands", () => {
    assert.deepEqual(buildAgentCommand("claude", "hello"), {
      command: "claude",
      args: ["-p", "hello"],
    });
  });

  it("validates agent names", () => {
    assert.equal(isAgentName("codex"), true);
    assert.equal(isAgentName("missing"), false);
  });
});
