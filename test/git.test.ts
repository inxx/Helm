import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { changedPaths, formatStatusEntries, parseGitStatus } from "../src/workspace/git.ts";

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

describe("changedPaths", () => {
  it("normalizes renamed paths and excludes Helm session files", () => {
    const entries = parseGitStatus(
      "R  old-name.txt -> new-name.txt\n?? .helm/sessions/session.json\n?? src/new/file.ts\n",
    );

    assert.deepEqual(changedPaths(entries), ["new-name.txt", "src/new/file.ts"]);
  });
});
