import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatStatusEntries, parseGitStatus } from "../src/workspace/git.ts";

describe("parseGitStatus", () => {
  it("parses short status lines", () => {
    const entries = parseGitStatus(" M README.md\nA  src/cli.ts\n?? test/git.test.ts\n");

    assert.deepEqual(entries, [
      { raw: " M README.md", index: " ", workingTree: "M", path: "README.md" },
      { raw: "A  src/cli.ts", index: "A", workingTree: " ", path: "src/cli.ts" },
      { raw: "?? test/git.test.ts", index: "?", workingTree: "?", path: "test/git.test.ts" },
    ]);
  });
});

describe("formatStatusEntries", () => {
  it("prints an empty status message", () => {
    assert.equal(formatStatusEntries([]), "변경사항 없음");
  });
});
