import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getSessionStore, listSessions, type SessionRecord } from "../session/store.ts";
import { formatStatusEntries, readBranch, readHead, readStatus } from "../workspace/git.ts";

export type UiServerOptions = {
  repoPath: string;
  host: string;
  port: number;
};

export type UiServerHandle = {
  url: string;
  close: () => Promise<void>;
};

type UiSession = {
  id: string;
  status: string;
  agent: string;
  prompt: string;
  branch: string;
  head: string;
  exitCode: number | null;
  createdAt: string;
  updatedAt: string;
  changedFiles: string[];
  command: string[];
  commitHash: string | null;
  check: {
    command: string | null;
    exitCode: number | null;
    logPath: string | null;
  };
  pullRequest: {
    base: string | null;
    title: string | null;
    draft: boolean | null;
    url: string | null;
    createdAt: string | null;
  };
  artifacts: {
    logPath: string | null;
    diffPath: string | null;
    logPreview: string;
    diffPreview: string;
  };
};

export type UiSnapshot = {
  repo: {
    path: string;
    branch: string;
    head: string | null;
    dirtyCount: number;
    statusText: string;
    capturedAt: string;
  };
  totals: {
    sessions: number;
    completed: number;
    failed: number;
    committed: number;
    withPullRequest: number;
  };
  sessions: UiSession[];
};

const STATIC_ROOT = join(dirname(fileURLToPath(import.meta.url)), "static");
const PREVIEW_LIMIT = 4000;

export function createUiSnapshot(repoPath: string, now = new Date()): UiSnapshot {
  const status = readStatus(repoPath);
  const store = getSessionStore(repoPath);
  const sessions = listSessions(store).map(toUiSession);

  return {
    repo: {
      path: repoPath,
      branch: readBranch(repoPath),
      head: readHead(repoPath),
      dirtyCount: status.length,
      statusText: formatStatusEntries(status),
      capturedAt: now.toISOString(),
    },
    totals: {
      sessions: sessions.length,
      completed: sessions.filter((session) => session.status === "completed").length,
      failed: sessions.filter((session) => session.status === "failed").length,
      committed: sessions.filter((session) => session.status === "committed").length,
      withPullRequest: sessions.filter((session) => Boolean(session.pullRequest.url)).length,
    },
    sessions,
  };
}

export function startUiServer(options: UiServerOptions): Promise<UiServerHandle> {
  const server = createServer((request, response) => {
    handleRequest(options.repoPath, request, response);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve({
        url: formatServerUrl(options.host, server),
        close: () => closeServer(server),
      });
    });
  });
}

function handleRequest(repoPath: string, request: IncomingMessage, response: ServerResponse): void {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;

  try {
    if (pathname === "/api/overview") {
      writeJson(response, createUiSnapshot(repoPath));
      return;
    }

    if (pathname === "/" || pathname === "/index.html") {
      writeStatic(response, "index.html", "text/html; charset=utf-8");
      return;
    }

    if (pathname === "/assets/app.css") {
      writeStatic(response, "app.css", "text/css; charset=utf-8");
      return;
    }

    if (pathname === "/assets/app.js") {
      writeStatic(response, "app.js", "text/javascript; charset=utf-8");
      return;
    }

    writeText(response, 404, "Not found\n", "text/plain; charset=utf-8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeText(response, 500, `${message}\n`, "text/plain; charset=utf-8");
  }
}

function toUiSession(session: SessionRecord): UiSession {
  return {
    id: session.id,
    status: session.status,
    agent: session.agent ?? "-",
    prompt: session.prompt ?? "-",
    branch: session.branch,
    head: session.head ?? "-",
    exitCode: session.exitCode ?? null,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    changedFiles: session.changedFiles ?? [],
    command: session.command ?? [],
    commitHash: session.commitHash ?? null,
    check: {
      command: session.checkCommand ?? null,
      exitCode: session.checkExitCode ?? null,
      logPath: session.checkLogPath ?? null,
    },
    pullRequest: {
      base: session.prBase ?? null,
      title: session.prTitle ?? null,
      draft: session.prDraft ?? null,
      url: session.prUrl ?? null,
      createdAt: session.prCreatedAt ?? null,
    },
    artifacts: {
      logPath: session.logPath ?? null,
      diffPath: session.diffPath ?? null,
      logPreview: readPreview(session.logPath),
      diffPreview: readPreview(session.diffPath),
    },
  };
}

function readPreview(path: string | undefined): string {
  if (!path || !existsSync(path)) {
    return "";
  }

  const content = readFileSync(path, "utf8");

  if (content.length <= PREVIEW_LIMIT) {
    return content;
  }

  return `${content.slice(0, PREVIEW_LIMIT)}\n... truncated`;
}

function writeStatic(response: ServerResponse, filename: string, contentType: string): void {
  writeText(response, 200, readFileSync(join(STATIC_ROOT, filename), "utf8"), contentType);
}

function writeJson(response: ServerResponse, body: unknown): void {
  writeText(response, 200, `${JSON.stringify(body)}\n`, "application/json; charset=utf-8");
}

function writeText(
  response: ServerResponse,
  statusCode: number,
  body: string,
  contentType: string,
): void {
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": contentType,
  });
  response.end(body);
}

function formatServerUrl(host: string, server: Server): string {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const displayHost = host === "0.0.0.0" ? "127.0.0.1" : host;

  return `http://${displayHost}:${port}`;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}
