import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildAgentCommand, isAgentName, resolveAgentBinary } from "../src/harness/agents.ts";

describe("agents", () => {
  it("builds Codex exec commands", () => {
    assert.deepEqual(buildAgentCommand("codex", "hello", { HELM_CODEX_BIN: "codex" }), {
      command: "codex",
      args: ["exec", "hello"],
    });
  });

  it("builds Claude prompt commands", () => {
    assert.deepEqual(buildAgentCommand("claude", "hello", {}), {
      command: "claude",
      args: ["-p", "hello"],
    });
  });

  it("validates agent names", () => {
    assert.equal(isAgentName("codex"), true);
    assert.equal(isAgentName("missing"), false);
  });

  it("supports explicit binary overrides", () => {
    assert.equal(resolveAgentBinary("codex", { HELM_CODEX_BIN: "/custom/codex" }), "/custom/codex");
    assert.deepEqual(buildAgentCommand("gemini", "hello", { HELM_GEMINI_BIN: "/custom/gemini" }), {
      command: "/custom/gemini",
      args: ["-p", "hello"],
    });
  });
});
