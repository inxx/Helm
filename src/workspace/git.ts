import { runCommand } from "../core/process.ts";

export type GitStatusEntry = {
  raw: string;
  index: string;
  workingTree: string;
  path: string;
};

export type GitSnapshot = {
  repoPath: string;
  branch: string;
  head: string | null;
  status: GitStatusEntry[];
  capturedAt: string;
};

export function parseGitStatus(output: string): GitStatusEntry[] {
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => ({
      raw: line,
      index: line[0] ?? " ",
      workingTree: line[1] ?? " ",
      path: line.slice(3),
    }));
}

export function findGitRoot(cwd: string): string {
  const result = runCommand("git", ["rev-parse", "--show-toplevel"], { cwd });

  if (result.code !== 0) {
    throw new Error("git 저장소 안에서 실행해야 합니다.");
  }

  return result.stdout.trim();
}

export function readBranch(cwd: string): string {
  const branch = runCommand("git", ["branch", "--show-current"], { cwd });
  const branchName = branch.stdout.trim();

  if (branch.code === 0 && branchName) {
    return branchName;
  }

  const head = runCommand("git", ["rev-parse", "--short", "HEAD"], { cwd });

  if (head.code === 0) {
    return head.stdout.trim();
  }

  return "unknown";
}

export function readHead(cwd: string): string | null {
  const result = runCommand("git", ["rev-parse", "--short", "HEAD"], { cwd });

  if (result.code !== 0) {
    return null;
  }

  return result.stdout.trim();
}

export function readStatus(cwd: string): GitStatusEntry[] {
  const result = runCommand("git", ["status", "--short"], { cwd });

  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || "git status 실행에 실패했습니다.");
  }

  return parseGitStatus(result.stdout);
}

export function captureSnapshot(cwd: string, now = new Date()): GitSnapshot {
  const repoPath = findGitRoot(cwd);

  return {
    repoPath,
    branch: readBranch(repoPath),
    head: readHead(repoPath),
    status: readStatus(repoPath),
    capturedAt: now.toISOString(),
  };
}

export function readWorktreeDiff(cwd: string): string {
  const repoPath = findGitRoot(cwd);
  const staged = runCommand("git", ["diff", "--cached"], { cwd: repoPath });
  const unstaged = runCommand("git", ["diff"], { cwd: repoPath });
  const chunks: string[] = [];

  if (staged.stdout.trim()) {
    chunks.push(["# staged", staged.stdout].join("\n"));
  }

  if (unstaged.stdout.trim()) {
    chunks.push(["# unstaged", unstaged.stdout].join("\n"));
  }

  return chunks.join("\n");
}

export function formatStatusEntries(entries: GitStatusEntry[]): string {
  if (entries.length === 0) {
    return "변경사항 없음";
  }

  return entries.map((entry) => `${entry.index}${entry.workingTree} ${entry.path}`).join("\n");
}
