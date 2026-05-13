import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { GitSnapshot } from "../workspace/git.ts";

export type SessionStatus = "created" | "running" | "completed" | "failed" | "committed";

export type SessionRecord = {
  id: string;
  status: SessionStatus;
  repoPath: string;
  branch: string;
  head: string | null;
  createdAt: string;
  updatedAt: string;
  agent?: string;
  prompt?: string;
  command?: string[];
  exitCode?: number;
  before?: GitSnapshot;
  after?: GitSnapshot;
  changedFiles?: string[];
  logPath?: string;
  diffPath?: string;
  checkCommand?: string;
  checkExitCode?: number;
  checkLogPath?: string;
  commitHash?: string;
  prBase?: string;
  prTitle?: string;
  prDraft?: boolean;
  prUrl?: string;
  prCreatedAt?: string;
};

export type SessionStore = {
  rootPath: string;
  sessionsPath: string;
};

export function createSessionStore(repoPath: string): SessionStore {
  const store = getSessionStore(repoPath);

  mkdirSync(store.sessionsPath, { recursive: true });

  return store;
}

export function getSessionStore(repoPath: string): SessionStore {
  const rootPath = join(repoPath, ".helm");
  const sessionsPath = join(rootPath, "sessions");

  return { rootPath, sessionsPath };
}

export function createSession(
  store: SessionStore,
  snapshot: GitSnapshot,
  now = new Date(),
): SessionRecord {
  const createdAt = now.toISOString();
  const id = `${createdAt.replaceAll(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;

  return {
    id,
    status: "created",
    repoPath: snapshot.repoPath,
    branch: snapshot.branch,
    head: snapshot.head,
    createdAt,
    updatedAt: createdAt,
    before: snapshot,
  };
}

export function saveSession(store: SessionStore, record: SessionRecord): void {
  writeFileSync(sessionFilePath(store, record.id), `${JSON.stringify(record, null, 2)}\n`);
}

export function sessionArtifactPath(store: SessionStore, id: string, extension: string): string {
  return join(store.sessionsPath, `${id}.${extension}`);
}

export function readSession(store: SessionStore, id: string): SessionRecord {
  const raw = readFileSync(sessionFilePath(store, id), "utf8");

  return JSON.parse(raw) as SessionRecord;
}

export function listSessions(store: SessionStore): SessionRecord[] {
  if (!existsSync(store.sessionsPath)) {
    return [];
  }

  return readdirSync(store.sessionsPath)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readSession(store, name.replace(/\.json$/, "")))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function resolveSession(store: SessionStore, id?: string): SessionRecord | null {
  if (id) {
    if (!existsSync(sessionFilePath(store, id))) {
      return null;
    }

    return readSession(store, id);
  }

  return listSessions(store)[0] ?? null;
}

function sessionFilePath(store: SessionStore, id: string): string {
  return join(store.sessionsPath, `${id}.json`);
}
