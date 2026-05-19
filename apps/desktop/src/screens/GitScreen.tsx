import type { LucideIcon } from "lucide-react";
import { Files, GitBranch, GitCommitHorizontal, GitGraph } from "lucide-react";
import type { CSSProperties } from "react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { shortHash } from "../lib/status";
import type {
  GitBranchSummary,
  GitCommitSummary,
  GitFileStatus,
  GitGraphCell,
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
      graphCells: GitGraphCell[];
      graphColorIndex: number;
      refs: string[];
      subject: string;
      summary: string;
    }
  | {
      id: string;
      kind: "connector";
      graphCells: GitGraphCell[];
    }
  | {
      id: string;
      kind: "commit";
      refs: string[];
      commit: GitCommitSummary;
    };

type SelectableGitGraphRow = Exclude<GitGraphRow, { kind: "connector" }>;

const gitViews: Array<{ id: GitView; label: string; icon: LucideIcon }> = [
  { id: "genealogy", label: "계보", icon: GitGraph },
  { id: "changes", label: "변경", icon: Files },
  { id: "branches", label: "브랜치", icon: GitBranch },
];

const graphLaneColors = [
  "oklch(0.64 0.16 252)",
  "oklch(0.66 0.16 166)",
  "oklch(0.66 0.17 316)",
  "oklch(0.68 0.17 82)",
  "oklch(0.62 0.2 27)",
  "oklch(0.66 0.14 205)",
  "oklch(0.62 0.18 145)",
  "oklch(0.68 0.14 290)",
  "oklch(0.58 0.02 260)",
];

const worktreeGraphColorIndex = 8;
const graphCellWidth = 10;

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
  const selectableRows = useMemo(
    () => graphRows.filter((row): row is SelectableGitGraphRow => row.kind !== "connector"),
    [graphRows],
  );

  useEffect(() => {
    if (selectableRows.length === 0) {
      setSelectedRowId(null);
      return;
    }
    if (!selectedRowId || !selectableRows.some((row) => row.id === selectedRowId)) {
      setSelectedRowId(selectableRows[0].id);
    }
  }, [selectableRows, selectedRowId]);

  const selectedRow =
    selectableRows.find((row) => row.id === selectedRowId) ?? selectableRows[0] ?? null;

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
  selectedRow: SelectableGitGraphRow | null;
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
            {rows.map((row, index) => {
              if (row.kind === "connector") {
                return (
                  <div className="git-graph-row connector" key={row.id} role="presentation">
                    <GitGraphCells connector cells={row.graphCells} />
                  </div>
                );
              }

              const rowColorIndex =
                row.kind === "worktree" ? row.graphColorIndex : row.commit.graphColorIndex;

              return (
                <button
                  key={row.id}
                  type="button"
                  role="option"
                  aria-selected={selectedRowId === row.id}
                  className={`git-graph-row lane-${index % 6} ${
                    selectedRowId === row.id ? "selected" : ""
                  }`}
                  style={{ "--branch-color": gitGraphColor(rowColorIndex) } as CSSProperties}
                  onClick={() => onSelectRow(row.id)}
                >
                  <GitGraphCells
                    cells={row.kind === "worktree" ? row.graphCells : row.commit.graphCells}
                    head={row.kind === "commit" ? row.commit.isHead : false}
                    worktree={row.kind === "worktree"}
                  />
                  <span className="git-graph-content">
                    <span className="git-graph-titleline">
                      {compactRefLabels(row.refs).map((ref) => (
                        <span className="git-ref-label" key={ref}>
                          {ref}
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
              );
            })}
          </div>
        )}
      </section>

      <section className="git-panel git-selected-panel">
        <div className="git-panel-title">
          <span>상세</span>
          <strong>
            {selectedRow?.kind === "commit"
              ? selectedRow.commit.shortHash
              : selectedRow
                ? "worktree"
                : "none"}
          </strong>
        </div>
        <SelectedGitDetail selectedRow={selectedRow} files={files} snapshot={snapshot} />
      </section>
    </div>
  );
}

function GitGraphCells({
  cells,
  connector = false,
  head = false,
  worktree = false,
}: {
  cells: GitGraphCell[];
  connector?: boolean;
  head?: boolean;
  worktree?: boolean;
}) {
  const height = connector ? 20 : 48;
  const width = Math.max(cells.length, 2) * graphCellWidth;
  const midY = height / 2;

  return (
    <svg
      aria-hidden="true"
      className={connector ? "git-visual-graph connector" : "git-visual-graph"}
      focusable="false"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      style={{ "--graph-columns": Math.max(cells.length, 2) } as CSSProperties}
    >
      {cells.map((cell, index) => (
        <GraphCellShape
          cell={cell}
          head={head}
          height={height}
          index={index}
          key={`${index}:${cell.kind}:${cell.colorIndex ?? "x"}:${cell.secondaryColorIndex ?? "x"}`}
          midY={midY}
          worktree={worktree}
        />
      ))}
    </svg>
  );
}

function GraphCellShape({
  cell,
  head,
  height,
  index,
  midY,
  worktree,
}: {
  cell: GitGraphCell;
  head: boolean;
  height: number;
  index: number;
  midY: number;
  worktree: boolean;
}) {
  if (cell.kind === "empty") return null;

  const centerX = index * graphCellWidth + graphCellWidth / 2;
  const leftX = centerX - graphCellWidth / 2;
  const rightX = centerX + graphCellWidth / 2;
  const color = gitGraphColor(cell.colorIndex ?? 0);
  const secondaryColor = gitGraphColor(cell.secondaryColorIndex ?? cell.colorIndex ?? 0);
  const strokeProps = {
    fill: "none",
    stroke: color,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    strokeWidth: 2.2,
  };

  switch (cell.kind) {
    case "pipe":
      return <line {...strokeProps} x1={centerX} x2={centerX} y1={0} y2={height} />;
    case "commit":
      return (
        <g>
          <line {...strokeProps} x1={centerX} x2={centerX} y1={0} y2={height} />
          <circle
            cx={centerX}
            cy={midY}
            fill={head || worktree ? "var(--surface)" : color}
            r={head || worktree ? 5 : 4.2}
            stroke={color}
            strokeWidth={head || worktree ? 2.3 : 1.8}
          />
        </g>
      );
    case "horizontal":
      return <line {...strokeProps} x1={leftX} x2={rightX} y1={midY} y2={midY} />;
    case "horizontal-pipe":
      return (
        <g>
          <line
            {...strokeProps}
            stroke={secondaryColor}
            x1={centerX}
            x2={centerX}
            y1={0}
            y2={height}
          />
          <line {...strokeProps} x1={leftX} x2={rightX} y1={midY} y2={midY} />
        </g>
      );
    case "branch-right":
      return (
        <path
          {...strokeProps}
          d={`M ${rightX} ${midY} Q ${centerX} ${midY} ${centerX} ${midY + 6} L ${centerX} ${height}`}
        />
      );
    case "branch-left":
      return (
        <path
          {...strokeProps}
          d={`M ${leftX} ${midY} Q ${centerX} ${midY} ${centerX} ${midY + 6} L ${centerX} ${height}`}
        />
      );
    case "merge-right":
      return (
        <path
          {...strokeProps}
          d={`M ${centerX} 0 L ${centerX} ${midY - 6} Q ${centerX} ${midY} ${rightX} ${midY}`}
        />
      );
    case "merge-left":
      return (
        <path
          {...strokeProps}
          d={`M ${centerX} 0 L ${centerX} ${midY - 6} Q ${centerX} ${midY} ${leftX} ${midY}`}
        />
      );
    case "tee-right":
      return (
        <g>
          <line {...strokeProps} x1={centerX} x2={centerX} y1={0} y2={height} />
          <line {...strokeProps} x1={centerX} x2={rightX} y1={midY} y2={midY} />
        </g>
      );
    case "tee-left":
      return (
        <g>
          <line {...strokeProps} x1={centerX} x2={centerX} y1={0} y2={height} />
          <line {...strokeProps} x1={leftX} x2={centerX} y1={midY} y2={midY} />
        </g>
      );
    case "tee-up":
      return (
        <g>
          <line {...strokeProps} x1={centerX} x2={centerX} y1={0} y2={midY} />
          <line {...strokeProps} x1={leftX} x2={rightX} y1={midY} y2={midY} />
        </g>
      );
    default:
      return null;
  }
}

function SelectedGitDetail({
  selectedRow,
  files,
  snapshot,
}: {
  selectedRow: SelectableGitGraphRow | null;
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
  const graphColumnCount = Math.max(
    2,
    ...commits.flatMap((commit) => [
      commit.graphCells.length,
      ...commit.graphConnectorRows.map((connectorRow) => connectorRow.length),
    ]),
  );

  if (snapshot.repository.dirtyCount > 0) {
    const headCommit = commits.find((commit) => commit.isHead) ?? commits[0] ?? null;
    const graphLane = headCommit?.graphLane ?? 0;
    rows.push({
      id: "worktree",
      kind: "worktree",
      graphCells: buildWorktreeGraphCells(graphColumnCount, graphLane),
      graphColorIndex: worktreeGraphColorIndex,
      refs: [snapshot.repository.currentBranch ?? "detached"],
      subject: "Uncommitted Changes",
      summary: `${snapshot.repository.dirtyCount} files with changes`,
    });
  }

  rows.push(
    ...commits.flatMap((commit) => [
      ...commit.graphConnectorRows.map((graphCells, index) => ({
        id: `${commit.hash}:connector:${index}`,
        kind: "connector" as const,
        graphCells,
      })),
      {
        id: commit.hash,
        kind: "commit" as const,
        refs: commit.refs,
        commit,
      },
    ]),
  );

  return rows;
}

function buildWorktreeGraphCells(columnCount: number, lane: number): GitGraphCell[] {
  const requiredColumnCount = Math.max(columnCount, lane * 2 + 1, 2);
  return Array.from({ length: requiredColumnCount }, (_, index) => ({
    kind: index === lane * 2 ? "commit" : "empty",
    colorIndex: index === lane * 2 ? worktreeGraphColorIndex : null,
    secondaryColorIndex: null,
  }));
}

function gitGraphColor(colorIndex: number): string {
  return graphLaneColors[colorIndex % graphLaneColors.length];
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

function compactRefLabels(refs: string[]): string[] {
  const labels = Array.from(new Set(refs.map(formatRefLabel).filter(Boolean)));
  const localRefs = new Set(
    labels.filter((ref) => !ref.startsWith("origin/") && !ref.startsWith("tag:")),
  );
  const remoteRefs = new Set(labels.filter((ref) => ref.startsWith("origin/")));
  const compacted: string[] = [];

  for (const label of labels) {
    if (label.startsWith("origin/")) {
      const localName = label.slice("origin/".length);
      if (localRefs.has(localName)) continue;
      compacted.push(label);
      continue;
    }

    if (!label.startsWith("tag:") && remoteRefs.has(`origin/${label}`)) {
      compacted.push(`${label} ↔ origin`);
      continue;
    }

    compacted.push(label);
  }

  if (compacted.length <= 2) return compacted;
  return [compacted[0], `+${compacted.length - 1}`];
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
