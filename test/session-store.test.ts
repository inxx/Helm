import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createSession,
  createSessionStore,
  listSessions,
  saveSession,
} from "../src/session/store.ts";
import type { GitSnapshot } from "../src/workspace/git.ts";

const tempDir = mkdtempSync(join(tmpdir(), "helm-session-store-"));

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("session store", () => {
  it("saves and lists sessions newest first", () => {
    const store = createSessionStore(tempDir);
    const first = createSession(store, snapshot("main"), new Date("2026-05-13T00:00:00.000Z"));
    const second = createSession(store, snapshot("feature/test"), new Date("2026-05-13T00:01:00.000Z"));

    saveSession(store, first);
    saveSession(store, second);

    const sessions = listSessions(store);

    assert.equal(sessions[0]?.id, second.id);
    assert.equal(sessions[1]?.id, first.id);
  });
});

function snapshot(branch: string): GitSnapshot {
  return {
    repoPath: tempDir,
    branch,
    head: null,
    status: [],
    capturedAt: "2026-05-13T00:00:00.000Z",
  };
}
