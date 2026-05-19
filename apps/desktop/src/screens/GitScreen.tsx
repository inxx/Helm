import type { LucideIcon } from "lucide-react";
import { Files, GitBranch, GitCommitHorizontal, GitGraph } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { shortHash } from "../lib/status";
import type {
  GitBranchSummary,
  GitCommitSummary,
  GitFileStatus,
  ProjectSnapshot,
} from "../lib/types";

interface GitScreenProps {
  snapshot: ProjectSnapshot | null;
  onOpenProject: () => void;
}

type GitView = "genealogy" | "changes" | "branches";

type GitGraphRow =
  | {
      id: "worktree";
      kind: "worktree";
      refs: string[];
      subject: string;
      summary: string;
    }
  | {
      id: string;
      kind: "commit";
      refs: string[];
      commit: GitCommitSummary;
    };

const gitViews: Array<{ id: GitView; label: string; icon: LucideIcon }> = [
  { id: "genealogy", label: "계보", icon: GitGraph },
  { id: "changes", label: "변경", icon: Files },
  { id: "branches", label: "브랜치", icon: GitBranch },
];

export function GitScreen({ snapshot, onOpenProject }: GitScreenProps) {
  const [activeView, setActiveView] = useState<GitView>("genealogy");
  const [branches, setBranches] = useState<GitBranchSummary[]>([]);
  const [commits, setCommits] = useState<GitCommitSummary[]>([]);
  const [files, setFiles] = useState<GitFileStatus[]>([]);
  const [gitError, setGitError] = useState<string | null>(null);
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (!snapshot) {
      setBranches([]);
      setCommits([]);
      setFiles([]);
      setGitError(null);
      return;
    }

    setGitError(null);
    setBranches([]);
    setCommits([]);
    setFiles([]);
    setSelectedRowId(null);

    void Promise.all([
      api.getLocalBranches(snapshot.project.id),
      api.getRecentCommits(snapshot.project.id, 50),
      api.getChangedFiles(snapshot.project.id),
    ])
      .then(([nextBranches, nextCommits, nextFiles]) => {
        if (cancelled) return;
        setBranches(nextBranches);
        setCommits(nextCommits);
        setFiles(nextFiles);
      })
      .catch((error) => {
        if (cancelled) return;
        setGitError(messageFromError(error));
      });

    return () => {
      cancelled = true;
    };
  }, [snapshot]);

  const graphRows = useMemo(() => buildGraphRows(snapshot, commits), [snapshot, commits]);

  useEffect(() => {
    if (graphRows.length === 0) {
      setSelectedRowId(null);
      return;
    }
    if (!selectedRowId || !graphRows.some((row) => row.id === selectedRowId)) {
      setSelectedRowId(graphRows[0].id);
    }
  }, [graphRows, selectedRowId]);

  const selectedRow =
    graphRows.find((row) => row.id === selectedRowId) ?? graphRows[0] ?? null;

  if (!snapshot) {
    return (
      <section className="empty-state">
        <h2>Git 저장소 없음</h2>
        <p>프로젝트를 열면 read-only Git 상태가 표시됩니다.</p>
        <button className="primary-button" onClick={onOpenProject} type="button">
          프로젝트 열기
        </button>
      </section>
    );
  }

  return (
    <div className="git-layout">
      <header className="git-screen-header">
        <div className="git-repo-title">
          <h2>{snapshot.project.name}</h2>
          <p title={snapshot.project.rootPath}>{snapshot.project.rootPath}</p>
        </div>
        <div className="git-head-summary" aria-label="저장소 상태">
          <GitMetric label="branch" value={snapshot.repository.currentBranch ?? "detached"} />
          <GitMetric label="head" value={shortHash(snapshot.repository.head)} />
          <GitMetric label="staged" value={snapshot.repository.stagedCount} />
          <GitMetric label="unstaged" value={snapshot.repository.unstagedCount} />
          <GitMetric label="untracked" value={snapshot.repository.untrackedCount} />
        </div>
      </header>

      {gitError ? <div className="git-inline-error">{gitError}</div> : null}

      <nav className="git-subtabs" role="tablist" aria-label="Git 보기">
        {gitViews.map((view) => {
          const Icon = view.icon;
          const isActive = activeView === view.id;
          return (
            <button
              key={view.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              className={isActive ? "active" : ""}
              onClick={() => setActiveView(view.id)}
            >
              <Icon size={15} />
              <span>{view.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="git-tab-body">
        {activeView === "genealogy" ? (
          <GenealogyView
            rows={graphRows}
            selectedRow={selectedRow}
            selectedRowId={selectedRowId}
            onSelectRow={setSelectedRowId}
            files={files}
            snapshot={snapshot}
          />
        ) : null}
        {activeView === "changes" ? (
          <ChangesView files={files} snapshot={snapshot} />
        ) : null}
        {activeView === "branches" ? <BranchesView branches={branches} /> : null}
      </div>
    </div>
  );
}

function GitMetric({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

interface GenealogyViewProps {
  rows: GitGraphRow[];
  selectedRow: GitGraphRow | null;
  selectedRowId: string | null;
  onSelectRow: (id: string) => void;
  files: GitFileStatus[];
  snapshot: ProjectSnapshot;
}

function GenealogyView({
  rows,
  selectedRow,
  selectedRowId,
  onSelectRow,
  files,
  snapshot,
}: GenealogyViewProps) {
  return (
    <div className="git-genealogy-view">
      <section className="git-panel git-graph-panel">
        <div className="git-panel-title">
          <span>계보</span>
          <strong>{rows.length}</strong>
        </div>
        {rows.length === 0 ? (
          <div className="empty-inline">커밋 없음</div>
        ) : (
          <div className="git-graph-list" role="listbox" aria-label="커밋 계보">
            {rows.map((row, index) => (
              <button
                key={row.id}
                type="button"
                role="option"
                aria-selected={selectedRowId === row.id}
                className={`git-graph-row lane-${index % 6} ${
                  selectedRowId === row.id ? "selected" : ""
                }`}
                onClick={() => onSelectRow(row.id)}
              >
                <span className="git-graph-rail" aria-hidden="true">
                  <span className="git-graph-dot">{row.kind === "worktree" ? "◉" : "●"}</span>
                </span>
                <span className="git-graph-content">
                  <span className="git-graph-titleline">
                    {row.refs.slice(0, 3).map((ref) => (
                      <span className="git-ref-label" key={ref}>
                        {formatRefLabel(ref)}
                      </span>
                    ))}
                    <strong>{row.kind === "worktree" ? row.subject : row.commit.subject}</strong>
                  </span>
                  <span className="git-graph-subline">
                    {row.kind === "worktree"
                      ? row.summary
                      : `${row.commit.authorName} · ${formatCommitDate(row.commit.committedAt)}`}
                  </span>
                </span>
                <span className="git-graph-meta">
                  {row.kind === "worktree" ? (
                    <>
                      <span>{files.length} files</span>
                      <span>WORKTREE</span>
                    </>
                  ) : (
                    <>
                      <span>{row.commit.shortHash}</span>
                      <span>{row.commit.isMine ? "mine" : "commit"}</span>
                    </>
                  )}
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="git-panel git-selected-panel">
        <div className="git-panel-title">
          <span>상세</span>
          <strong>{selectedRow?.kind === "commit" ? selectedRow.commit.shortHash : "worktree"}</strong>
        </div>
        <SelectedGitDetail selectedRow={selectedRow} files={files} snapshot={snapshot} />
      </section>
    </div>
  );
}

function SelectedGitDetail({
  selectedRow,
  files,
  snapshot,
}: {
  selectedRow: GitGraphRow | null;
  files: GitFileStatus[];
  snapshot: ProjectSnapshot;
}) {
  if (!selectedRow) {
    return <div className="empty-inline">선택 항목 없음</div>;
  }

  if (selectedRow.kind === "worktree") {
    return (
      <div className="git-selected-content">
        <div className="git-detail-main">
          <div className="git-detail-heading">
            <GitCommitHorizontal size={16} />
            <div>
              <strong>Uncommitted Changes</strong>
              <span>{snapshot.repository.currentBranch ?? "detached"}</span>
            </div>
          </div>
          <div className="git-detail-metrics">
            <GitMetric label="staged" value={snapshot.repository.stagedCount} />
            <GitMetric label="unstaged" value={snapshot.repository.unstagedCount} />
            <GitMetric label="untracked" value={snapshot.repository.untrackedCount} />
          </div>
        </div>
        <div className="git-detail-side">
          <FilesList files={files} />
        </div>
      </div>
    );
  }

  const commit = selectedRow.commit;

  return (
    <div className="git-selected-content">
      <div className="git-detail-main">
        <div className="git-detail-heading">
          <GitCommitHorizontal size={16} />
          <div>
            <strong>{commit.subject}</strong>
            <span>
              {commit.authorName}
              {commit.isMine ? " · 내 커밋" : ""}
            </span>
          </div>
        </div>
        <dl className="git-detail-list">
          <div>
            <dt>hash</dt>
            <dd>{commit.hash}</dd>
          </div>
          <div>
            <dt>author</dt>
            <dd>
              {commit.authorName} &lt;{commit.authorEmail}&gt;
            </dd>
          </div>
          <div>
            <dt>date</dt>
            <dd>{formatCommitDate(commit.committedAt)}</dd>
          </div>
        </dl>
      </div>
      <div className="git-detail-side">
        {commit.refs.length === 0 ? (
          <p className="muted">refs 없음</p>
        ) : (
          <div className="git-ref-stack">
            {commit.refs.map((ref) => (
              <span className="git-ref-label" key={ref}>
                {formatRefLabel(ref)}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ChangesView({ files, snapshot }: { files: GitFileStatus[]; snapshot: ProjectSnapshot }) {
  return (
    <div className="git-changes-view">
      <section className="git-panel">
        <div className="git-panel-title">
          <span>상태</span>
          <strong>{snapshot.repository.dirtyCount}</strong>
        </div>
        <div className="git-status-breakdown">
          <GitMetric label="staged" value={snapshot.repository.stagedCount} />
          <GitMetric label="unstaged" value={snapshot.repository.unstagedCount} />
          <GitMetric label="untracked" value={snapshot.repository.untrackedCount} />
          <GitMetric
            label="user"
            value={snapshot.repository.userName ?? snapshot.repository.userEmail ?? "unset"}
          />
        </div>
      </section>
      <section className="git-panel">
        <div className="git-panel-title">
          <span>변경 파일</span>
          <strong>{files.length}</strong>
        </div>
        <FilesList files={files} />
      </section>
    </div>
  );
}

function BranchesView({ branches }: { branches: GitBranchSummary[] }) {
  return (
    <section className="git-panel git-branches-view">
      <div className="git-panel-title">
        <span>로컬 브랜치</span>
        <strong>{branches.length}</strong>
      </div>
      {branches.length === 0 ? (
        <div className="empty-inline">로컬 브랜치 없음</div>
      ) : (
        <ul className="git-branch-list">
          {branches.map((branch) => (
            <li className={branch.isCurrent ? "current" : ""} key={branch.branchName}>
              <div>
                <strong>{branch.branchName}</strong>
                <span>{branch.upstream ?? "upstream 없음"}</span>
              </div>
              <div className="git-branch-meta">
                <span>{shortHash(branch.headHash)}</span>
                <span>{branchTrackLabel(branch)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function FilesList({ files }: { files: GitFileStatus[] }) {
  if (files.length === 0) {
    return <p className="muted git-empty-copy">변경 파일 없음</p>;
  }

  return (
    <ul className="file-list git-file-list">
      {files.map((file) => (
        <li key={`${file.status}:${file.path}:${file.renamedFrom ?? ""}`}>
          <span className={fileCodeClass(file.status)}>{fileStatusCode(file.status)}</span>
          <strong title={file.path}>{file.path}</strong>
          {file.renamedFrom ? <span title={file.renamedFrom}>R</span> : null}
        </li>
      ))}
    </ul>
  );
}

function buildGraphRows(
  snapshot: ProjectSnapshot | null,
  commits: GitCommitSummary[],
): GitGraphRow[] {
  if (!snapshot) return [];

  const rows: GitGraphRow[] = [];
  if (snapshot.repository.dirtyCount > 0) {
    rows.push({
      id: "worktree",
      kind: "worktree",
      refs: [snapshot.repository.currentBranch ?? "detached"],
      subject: "Uncommitted Changes",
      summary: `${snapshot.repository.dirtyCount} files with changes`,
    });
  }

  rows.push(
    ...commits.map((commit) => ({
      id: commit.hash,
      kind: "commit" as const,
      refs: commit.refs,
      commit,
    })),
  );

  return rows;
}

function fileCodeClass(status: string): string {
  const trimmed = status.trim();
  if (!trimmed) return "";
  if (trimmed === "added" || trimmed === "untracked" || trimmed.includes("A")) {
    return "code-added";
  }
  if (trimmed === "deleted" || trimmed.includes("D")) return "code-deleted";
  if (trimmed === "renamed" || trimmed === "modified" || trimmed.includes("M")) {
    return "code-modified";
  }
  return "";
}

function fileStatusCode(status: string): string {
  switch (status) {
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "untracked":
      return "??";
    case "modified":
      return "M";
    default:
      return status.slice(0, 2).toUpperCase();
  }
}

function formatRefLabel(ref: string): string {
  return ref.replace(/^HEAD -> /, "").replace(/^tag: /, "tag:");
}

function formatCommitDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function branchTrackLabel(branch: GitBranchSummary): string {
  if (!branch.upstream) return "local";
  const parts = [];
  if (branch.ahead) parts.push(`+${branch.ahead}`);
  if (branch.behind) parts.push(`-${branch.behind}`);
  return parts.length > 0 ? parts.join(" / ") : "synced";
}

function messageFromError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String(error.message);
  }
  return "Git 상태를 불러오지 못했습니다.";
}
