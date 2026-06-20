import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  ExternalLink,
  Files,
  Filter,
  GitBranch,
  GitCommitHorizontal,
  GitGraph,
  GitPullRequest,
  RefreshCw,
  Search,
  UserRound,
} from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { useI18n, type AppLanguage } from "../lib/i18n";
import { shortHash } from "../lib/status";
import type {
  GitBranchSummary,
  GitCommitSummary,
  GitDiffMode,
  GitFileDiff,
  GitFileStatus,
  GitGraphCell,
  ProjectSnapshot,
} from "../lib/types";

interface GitScreenProps {
  snapshot: ProjectSnapshot | null;
  onOpenProject: () => void;
}

type GitView = "overview" | "genealogy" | "changes" | "branches";
type WorkFilter = "open" | "mine" | "review" | "ci-failed" | "jira-gap";

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

const gitViews: Array<{ id: GitView; label: Record<AppLanguage, string>; icon: LucideIcon }> = [
  { id: "overview", label: { ko: "통합", en: "Overview" }, icon: GitPullRequest },
  { id: "genealogy", label: { ko: "계보", en: "History" }, icon: GitGraph },
  { id: "changes", label: { ko: "변경", en: "Changes" }, icon: Files },
  { id: "branches", label: { ko: "브랜치", en: "Branches" }, icon: GitBranch },
];

interface WorkDashboardRow {
  id: string;
  title: string;
  subtitle: string;
  projectName: string;
  branchName: string;
  prNumber: string;
  prState: "open" | "draft";
  reviewer: string;
  reviewState: "none" | "requested" | "approved";
  ciState: "passed" | "pending" | "failed" | "none";
  ciLabel: string;
  mergeState: "ready" | "blocked" | "draft";
  jiraKey: string | null;
  jiraState: "linked" | "missing" | "in-progress";
  updatedLabel: string;
  isMine: boolean;
  ahead: number | null;
  behind: number | null;
}

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
  const { language } = useI18n();
  const [activeView, setActiveView] = useState<GitView>("overview");
  const [activeWorkFilter, setActiveWorkFilter] = useState<WorkFilter>("open");
  const [dashboardSearch, setDashboardSearch] = useState("");
  const [branches, setBranches] = useState<GitBranchSummary[]>([]);
  const [commits, setCommits] = useState<GitCommitSummary[]>([]);
  const [files, setFiles] = useState<GitFileStatus[]>([]);
  const [ignoredFiles, setIgnoredFiles] = useState<GitFileStatus[]>([]);
  const [gitError, setGitError] = useState<string | null>(null);
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (!snapshot) {
      setBranches([]);
      setCommits([]);
      setFiles([]);
      setIgnoredFiles([]);
      setGitError(null);
      return;
    }

    setGitError(null);
    setBranches([]);
    setCommits([]);
    setFiles([]);
    setIgnoredFiles([]);
    setSelectedRowId(null);

    void Promise.all([
      api.getLocalBranches(snapshot.project.id),
      api.getRecentCommits(snapshot.project.id, 100),
      api.getChangedFiles(snapshot.project.id),
      api.getIgnoredFiles(snapshot.project.id),
    ])
      .then(([nextBranches, nextCommits, nextFiles, nextIgnoredFiles]) => {
        if (cancelled) return;
        setBranches(nextBranches);
        setCommits(nextCommits);
        setFiles(nextFiles);
        setIgnoredFiles(nextIgnoredFiles);
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
  const dashboardRows = useMemo(
    () => buildDashboardRows(snapshot, branches, commits, files),
    [branches, commits, files, snapshot],
  );
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
        <h2>{language === "ko" ? "Git 저장소 없음" : "No Git repository"}</h2>
        <p>{language === "ko" ? "프로젝트를 열면 read-only Git 상태가 표시됩니다." : "Open a project to see read-only Git status."}</p>
        <button className="primary-button" onClick={onOpenProject} type="button">
          {language === "ko" ? "프로젝트 열기" : "Open project"}
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
        <div className="git-head-summary" aria-label={language === "ko" ? "저장소 상태" : "Repository status"}>
          <GitMetric label="branch" value={snapshot.repository.currentBranch ?? "detached"} />
          <GitMetric label="head" value={shortHash(snapshot.repository.head)} />
          <GitMetric label="staged" value={snapshot.repository.stagedCount} />
          <GitMetric label="unstaged" value={snapshot.repository.unstagedCount} />
          <GitMetric label="untracked" value={snapshot.repository.untrackedCount} />
        </div>
      </header>

      {gitError ? <div className="git-inline-error">{gitError}</div> : null}

      <nav className="git-subtabs" role="tablist" aria-label={language === "ko" ? "Git 보기" : "Git views"}>
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
              <span>{view.label[language]}</span>
            </button>
          );
        })}
      </nav>

      <div className="git-tab-body">
        {activeView === "overview" ? (
          <IntegrationDashboard
            rows={dashboardRows}
            snapshot={snapshot}
            activeFilter={activeWorkFilter}
            onFilterChange={setActiveWorkFilter}
            search={dashboardSearch}
            onSearchChange={setDashboardSearch}
            language={language}
          />
        ) : null}
        {activeView === "genealogy" ? (
          <GenealogyView
            rows={graphRows}
            selectedRow={selectedRow}
            selectedRowId={selectedRowId}
            onSelectRow={setSelectedRowId}
            files={files}
            snapshot={snapshot}
            language={language}
          />
        ) : null}
        {activeView === "changes" ? (
          <ChangesView files={files} ignoredFiles={ignoredFiles} snapshot={snapshot} language={language} />
        ) : null}
        {activeView === "branches" ? <BranchesView branches={branches} language={language} /> : null}
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

function IntegrationDashboard({
  rows,
  snapshot,
  activeFilter,
  onFilterChange,
  search,
  onSearchChange,
  language,
}: {
  rows: WorkDashboardRow[];
  snapshot: ProjectSnapshot;
  activeFilter: WorkFilter;
  onFilterChange: (filter: WorkFilter) => void;
  search: string;
  onSearchChange: (value: string) => void;
  language: AppLanguage;
}) {
  const filteredRows = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    return rows.filter((row) => {
      const matchesFilter =
        activeFilter === "open" ||
        (activeFilter === "mine" && row.isMine) ||
        (activeFilter === "review" && row.reviewState === "requested") ||
        (activeFilter === "ci-failed" && row.ciState === "failed") ||
        (activeFilter === "jira-gap" && row.jiraState === "missing");

      if (!matchesFilter) return false;
      if (!normalizedSearch) return true;

      return [row.title, row.subtitle, row.branchName, row.jiraKey, row.projectName]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(normalizedSearch));
    });
  }, [activeFilter, rows, search]);

  const counters = {
    open: rows.length,
    mine: rows.filter((row) => row.isMine).length,
    review: rows.filter((row) => row.reviewState === "requested").length,
    ciFailed: rows.filter((row) => row.ciState === "failed").length,
    jiraGap: rows.filter((row) => row.jiraState === "missing").length,
  };

  const filters: Array<{ id: WorkFilter; label: string; count: number }> = [
    { id: "open", label: language === "ko" ? "열기" : "Open", count: counters.open },
    { id: "mine", label: language === "ko" ? "내 것" : "Mine", count: counters.mine },
    { id: "review", label: language === "ko" ? "리뷰 필요" : "Needs review", count: counters.review },
    { id: "ci-failed", label: language === "ko" ? "CI 실패" : "CI failed", count: counters.ciFailed },
    { id: "jira-gap", label: language === "ko" ? "Jira 누락" : "Jira gaps", count: counters.jiraGap },
  ];

  return (
    <section className="git-work-dashboard">
      <div className="git-work-commandbar">
        <div className="git-work-source">
          <span className="git-source-icon">
            <GitPullRequest size={16} />
          </span>
          <div>
            <strong>GitHub · Jira · Local Mac</strong>
            <span>
              {language === "ko"
                ? `${snapshot.project.name} 프로젝트 · 로컬 Git 신호 기반`
                : `${snapshot.project.name} project · local Git signals`}
            </span>
          </div>
        </div>
        <div className="git-work-actions" aria-label={language === "ko" ? "통합 작업 액션" : "Integration actions"}>
          <button title={language === "ko" ? "필터" : "Filter"} type="button">
            <Filter size={15} />
          </button>
          <button title={language === "ko" ? "새로고침" : "Refresh"} type="button">
            <RefreshCw size={15} />
          </button>
          <button title={language === "ko" ? "외부에서 열기" : "Open externally"} type="button">
            <ExternalLink size={15} />
          </button>
        </div>
      </div>

      <div className="git-work-toolbar">
        <div className="git-work-filters" role="tablist" aria-label={language === "ko" ? "작업 필터" : "Work filters"}>
          {filters.map((filter) => (
            <button
              aria-selected={activeFilter === filter.id}
              className={activeFilter === filter.id ? "active" : ""}
              key={filter.id}
              onClick={() => onFilterChange(filter.id)}
              role="tab"
              type="button"
            >
              <span>{filter.label}</span>
              <strong>{filter.count}</strong>
            </button>
          ))}
        </div>
        <label className="git-work-search">
          <Search size={15} />
          <input
            aria-label={language === "ko" ? "PR, 브랜치, Jira 검색" : "Search PRs, branches, Jira"}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder={language === "ko" ? "is:pr is:open branch:JIRA-123" : "is:pr is:open branch:JIRA-123"}
            value={search}
          />
        </label>
      </div>

      <div className="git-work-table-shell">
        <div className="git-work-table" role="table" aria-label={language === "ko" ? "통합 작업 목록" : "Integrated work list"}>
          <div className="git-work-row git-work-head" role="row">
            <span>ID</span>
            <span>{language === "ko" ? "제목 / 맥락" : "Title / context"}</span>
            <span>{language === "ko" ? "리뷰어" : "Reviewer"}</span>
            <span>{language === "ko" ? "검사" : "Checks"}</span>
            <span>{language === "ko" ? "병합" : "Merge"}</span>
            <span>Jira</span>
            <span>{language === "ko" ? "업데이트됨" : "Updated"}</span>
          </div>
          {filteredRows.length === 0 ? (
            <div className="git-work-empty">
              {language === "ko" ? "조건에 맞는 작업이 없습니다." : "No work matches this filter."}
            </div>
          ) : (
            filteredRows.map((row) => <DashboardRow key={row.id} row={row} language={language} />)
          )}
        </div>
      </div>
    </section>
  );
}

function DashboardRow({ row, language }: { row: WorkDashboardRow; language: AppLanguage }) {
  return (
    <div className="git-work-row" role="row">
      <span className="git-pr-id">
        <GitPullRequest size={13} />
        {row.prNumber}
      </span>
      <span className="git-work-titlecell">
        <strong>{row.title}</strong>
        <span>
          {row.subtitle}
          <i className={row.prState === "draft" ? "draft" : ""}>{row.prState === "draft" ? "draft" : row.projectName}</i>
        </span>
      </span>
      <StatusPill tone={row.reviewState === "requested" ? "warning" : row.reviewState === "approved" ? "success" : "muted"}>
        <UserRound size={13} />
        {row.reviewer}
      </StatusPill>
      <StatusPill tone={row.ciState === "passed" ? "success" : row.ciState === "pending" ? "warning" : row.ciState === "failed" ? "danger" : "muted"}>
        {row.ciState === "passed" ? <CheckCircle2 size={13} /> : row.ciState === "pending" ? <Clock3 size={13} /> : <AlertTriangle size={13} />}
        {row.ciLabel}
      </StatusPill>
      <StatusPill tone={row.mergeState === "ready" ? "success" : row.mergeState === "blocked" ? "danger" : "muted"}>
        <GitBranch size={13} />
        {row.mergeState === "ready"
          ? language === "ko"
            ? "검사 통과"
            : "Ready"
          : row.mergeState === "blocked"
            ? language === "ko"
              ? "차단됨"
              : "Blocked"
            : language === "ko"
              ? "초안"
              : "Draft"}
      </StatusPill>
      <StatusPill tone={row.jiraState === "missing" ? "danger" : row.jiraState === "in-progress" ? "warning" : "success"}>
        {row.jiraKey ?? (language === "ko" ? "없음" : "Missing")}
      </StatusPill>
      <span className="git-work-updated">{row.updatedLabel}</span>
    </div>
  );
}

function StatusPill({
  children,
  tone,
}: {
  children: ReactNode;
  tone: "success" | "warning" | "danger" | "muted";
}) {
  return <span className={`git-status-pill ${tone}`}>{children}</span>;
}

interface GenealogyViewProps {
  rows: GitGraphRow[];
  selectedRow: SelectableGitGraphRow | null;
  selectedRowId: string | null;
  onSelectRow: (id: string) => void;
  files: GitFileStatus[];
  snapshot: ProjectSnapshot;
  language: AppLanguage;
}

function GenealogyView({
  rows,
  selectedRow,
  selectedRowId,
  onSelectRow,
  files,
  snapshot,
  language,
}: GenealogyViewProps) {
  return (
    <div className="git-genealogy-view">
      <section className="git-panel git-graph-panel">
        <div className="git-panel-title">
          <span>{language === "ko" ? "계보" : "History"}</span>
          <strong>{rows.length}</strong>
        </div>
        {rows.length === 0 ? (
          <div className="empty-inline">{language === "ko" ? "커밋 없음" : "No commits"}</div>
        ) : (
          <div className="git-graph-list" role="listbox" aria-label={language === "ko" ? "커밋 계보" : "Commit history"}>
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
          <span>{language === "ko" ? "상세" : "Details"}</span>
          <strong>
            {selectedRow?.kind === "commit"
              ? selectedRow.commit.shortHash
              : selectedRow
                ? "worktree"
                : "none"}
          </strong>
        </div>
        <SelectedGitDetail selectedRow={selectedRow} files={files} snapshot={snapshot} language={language} />
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
  language,
}: {
  selectedRow: SelectableGitGraphRow | null;
  files: GitFileStatus[];
  snapshot: ProjectSnapshot;
  language: AppLanguage;
}) {
  if (!selectedRow) {
    return <div className="empty-inline">{language === "ko" ? "선택 항목 없음" : "Nothing selected"}</div>;
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
          <FilesList files={files} language={language} />
        </div>
      </div>
    );
  }

  return <CommitDetail commit={selectedRow.commit} language={language} projectId={snapshot.project.id} />;
}

function CommitDetail({
  commit,
  language,
  projectId,
}: {
  commit: GitCommitSummary;
  language: AppLanguage;
  projectId: string;
}) {
  const [files, setFiles] = useState<GitFileStatus[]>([]);
  const [selectedFileKey, setSelectedFileKey] = useState<string | null>(null);
  const [fileDiff, setFileDiff] = useState<GitFileDiff | null>(null);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [loadingDiff, setLoadingDiff] = useState(false);

  useEffect(() => {
    let cancelled = false;

    setFiles([]);
    setSelectedFileKey(null);
    setFileDiff(null);
    setFilesError(null);
    setDiffError(null);
    setLoadingFiles(true);

    void api
      .getCommitChangedFiles(projectId, commit.hash)
      .then((nextFiles) => {
        if (cancelled) return;
        setFiles(nextFiles);
        setSelectedFileKey(nextFiles[0] ? fileKey(nextFiles[0]) : null);
      })
      .catch((error) => {
        if (cancelled) return;
        setFilesError(messageFromError(error));
      })
      .finally(() => {
        if (cancelled) return;
        setLoadingFiles(false);
      });

    return () => {
      cancelled = true;
    };
  }, [commit.hash, projectId]);

  const selectedFile = files.find((file) => fileKey(file) === selectedFileKey) ?? files[0] ?? null;

  useEffect(() => {
    let cancelled = false;

    if (!selectedFile) {
      setFileDiff(null);
      setDiffError(null);
      setLoadingDiff(false);
      return;
    }

    setLoadingDiff(true);
    setDiffError(null);

    void api
      .getCommitFileDiff(projectId, commit.hash, selectedFile.path)
      .then((nextDiff) => {
        if (cancelled) return;
        setFileDiff(nextDiff);
      })
      .catch((error) => {
        if (cancelled) return;
        setFileDiff(null);
        setDiffError(messageFromError(error));
      })
      .finally(() => {
        if (cancelled) return;
        setLoadingDiff(false);
      });

    return () => {
      cancelled = true;
    };
  }, [commit.hash, projectId, selectedFile]);

  return (
    <div className="git-commit-detail">
      <div className="git-commit-summary">
        <div className="git-detail-heading">
          <GitCommitHorizontal size={16} />
          <div>
            <strong>{commit.subject}</strong>
            <span>
              {commit.authorName}
              {commit.isMine ? language === "ko" ? " · 내 커밋" : " · my commit" : ""}
              {" · "}
              {commit.shortHash}
            </span>
          </div>
        </div>
        <div className="git-commit-meta">
          <span>{formatCommitDate(commit.committedAt)}</span>
          {commit.refs.slice(0, 3).map((ref) => (
            <span className="git-ref-label" key={ref}>
              {formatRefLabel(ref)}
            </span>
          ))}
        </div>
      </div>

      <div className="git-commit-changes">
        <section className="git-panel">
          <div className="git-panel-title">
            <span>{language === "ko" ? "변경 파일" : "Changed files"}</span>
            <strong>{loadingFiles ? "..." : files.length}</strong>
          </div>
          {filesError ? (
            <div className="git-inline-error">{filesError}</div>
          ) : loadingFiles ? (
            <div className="empty-inline">{language === "ko" ? "파일 불러오는 중" : "Loading files"}</div>
          ) : (
            <FilesList
              files={files}
              selectedFileKey={selectedFileKey}
              onSelectFile={setSelectedFileKey}
              language={language}
            />
          )}
        </section>

        <section className="git-panel git-commit-diff-panel">
          <div className="git-panel-title">
            <span>Diff</span>
            <strong>{selectedFile ? selectedFile.path : "none"}</strong>
          </div>
          <DiffContent diff={fileDiff?.diff ?? ""} error={diffError} loading={loadingDiff} language={language} />
        </section>
      </div>
    </div>
  );
}

function ChangesView({
  files,
  ignoredFiles,
  snapshot,
  language,
}: {
  files: GitFileStatus[];
  ignoredFiles: GitFileStatus[];
  snapshot: ProjectSnapshot;
  language: AppLanguage;
}) {
  const [selectedFileKey, setSelectedFileKey] = useState<string | null>(null);
  const [diffMode, setDiffMode] = useState<GitDiffMode>("worktree");
  const [fileDiff, setFileDiff] = useState<GitFileDiff | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(false);

  useEffect(() => {
    if (files.length === 0) {
      setSelectedFileKey(null);
      return;
    }
    if (!selectedFileKey || !files.some((file) => fileKey(file) === selectedFileKey)) {
      setSelectedFileKey(fileKey(files[0]));
    }
  }, [files, selectedFileKey]);

  const selectedFile = files.find((file) => fileKey(file) === selectedFileKey) ?? files[0] ?? null;

  useEffect(() => {
    setDiffMode(selectedFile?.staged ? "staged" : "worktree");
  }, [selectedFileKey, selectedFile?.staged]);

  useEffect(() => {
    let cancelled = false;

    if (!selectedFile) {
      setFileDiff(null);
      setDiffError(null);
      setLoadingDiff(false);
      return;
    }

    setLoadingDiff(true);
    setDiffError(null);

    void api
      .getFileDiff(snapshot.project.id, selectedFile.path, diffMode)
      .then((nextDiff) => {
        if (cancelled) return;
        setFileDiff(nextDiff);
      })
      .catch((error) => {
        if (cancelled) return;
        setFileDiff(null);
        setDiffError(messageFromError(error));
      })
      .finally(() => {
        if (cancelled) return;
        setLoadingDiff(false);
      });

    return () => {
      cancelled = true;
    };
  }, [diffMode, selectedFile, snapshot.project.id]);

  return (
    <div className="git-changes-view">
      <div className="git-changes-sidebar">
        <section className="git-panel">
          <div className="git-panel-title">
            <span>{language === "ko" ? "상태" : "Status"}</span>
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
            <span>{language === "ko" ? "변경 파일" : "Changed files"}</span>
            <strong>{files.length}</strong>
          </div>
          <FilesList
            files={files}
            selectedFileKey={selectedFileKey}
            onSelectFile={setSelectedFileKey}
            language={language}
          />
        </section>
        <section className="git-panel">
          <div className="git-panel-title">
            <span>{language === "ko" ? "Git에서 무시됨" : "Ignored by Git"}</span>
            <strong>{ignoredFiles.length}</strong>
          </div>
          <IgnoredFilesList files={ignoredFiles} language={language} />
        </section>
      </div>
      <section className="git-panel git-diff-panel">
        <div className="git-panel-title">
          <span>Diff</span>
          <strong>{selectedFile ? selectedFile.path : "none"}</strong>
        </div>
        <div className="git-diff-body">
          {selectedFile ? (
            <div className="git-diff-toolbar">
              <div className="git-diff-file-meta">
                <span className={fileCodeClass(selectedFile.status)}>
                  {fileStatusCode(selectedFile.status)}
                </span>
                <strong title={selectedFile.path}>{selectedFile.path}</strong>
              </div>
              <div className="git-diff-mode-toggle" role="group" aria-label={language === "ko" ? "Diff 모드" : "Diff mode"}>
                <button
                  className={diffMode === "worktree" ? "active" : ""}
                  onClick={() => setDiffMode("worktree")}
                  type="button"
                >
                  Worktree
                </button>
                <button
                  className={diffMode === "staged" ? "active" : ""}
                  disabled={!selectedFile.staged}
                  onClick={() => setDiffMode("staged")}
                  type="button"
                >
                  Staged
                </button>
              </div>
            </div>
          ) : null}
          <DiffContent diff={fileDiff?.diff ?? ""} error={diffError} loading={loadingDiff} language={language} />
        </div>
      </section>
    </div>
  );
}

function IgnoredFilesList({ files, language }: { files: GitFileStatus[]; language: AppLanguage }) {
  if (files.length === 0) {
    return <p className="muted git-empty-copy">{language === "ko" ? "무시된 파일 없음" : "No ignored files"}</p>;
  }

  return (
    <div className="git-ignored-files">
      <p className="muted git-empty-copy">
        {language === "ko"
          ? "아래 파일은 .gitignore 규칙 때문에 변경 목록과 diff에 표시되지 않습니다."
          : "These files are hidden from changed files and diffs by .gitignore rules."}
      </p>
      <ul className="file-list git-file-list">
        {files.map((file) => (
          <li key={`ignored:${file.path}`}>
            <button disabled type="button">
              <span className={fileCodeClass(file.status)}>{fileStatusCode(file.status)}</span>
              <strong title={file.path}>{file.path}</strong>
            </button>
          </li>
        ))}
      </ul>
      {files.length >= 200 ? (
        <p className="muted git-empty-copy">
          {language === "ko" ? "처음 200개만 표시합니다." : "Showing the first 200 only."}
        </p>
      ) : null}
    </div>
  );
}

function BranchesView({ branches, language }: { branches: GitBranchSummary[]; language: AppLanguage }) {
  return (
    <section className="git-panel git-branches-view">
      <div className="git-panel-title">
        <span>{language === "ko" ? "로컬 브랜치" : "Local branches"}</span>
        <strong>{branches.length}</strong>
      </div>
      {branches.length === 0 ? (
        <div className="empty-inline">{language === "ko" ? "로컬 브랜치 없음" : "No local branches"}</div>
      ) : (
        <ul className="git-branch-list">
          {branches.map((branch) => (
            <li className={branch.isCurrent ? "current" : ""} key={branch.branchName}>
              <div>
                <strong>{branch.branchName}</strong>
                <span>{branch.upstream ?? (language === "ko" ? "upstream 없음" : "No upstream")}</span>
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

function FilesList({
  files,
  selectedFileKey,
  onSelectFile,
  language,
}: {
  files: GitFileStatus[];
  selectedFileKey?: string | null;
  onSelectFile?: (key: string) => void;
  language: AppLanguage;
}) {
  if (files.length === 0) {
    return <p className="muted git-empty-copy">{language === "ko" ? "변경 파일 없음" : "No changed files"}</p>;
  }

  return (
    <ul className="file-list git-file-list">
      {files.map((file) => {
        const key = fileKey(file);
        return (
          <li className={selectedFileKey === key ? "selected" : ""} key={key}>
            <button disabled={!onSelectFile} onClick={() => onSelectFile?.(key)} type="button">
              <span className={fileCodeClass(file.status)}>{fileStatusCode(file.status)}</span>
              <strong title={file.path}>{file.path}</strong>
              {file.staged ? <span title="staged">S</span> : null}
              {file.renamedFrom ? <span title={file.renamedFrom}>R</span> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function DiffContent({
  diff,
  error,
  loading,
  language,
}: {
  diff: string;
  error: string | null;
  loading: boolean;
  language: AppLanguage;
}) {
  if (loading) {
    return <div className="empty-inline">{language === "ko" ? "diff 불러오는 중" : "Loading diff"}</div>;
  }
  if (error) {
    return <div className="git-inline-error">{error}</div>;
  }
  if (!diff.trim()) {
    return <div className="empty-inline">{language === "ko" ? "표시할 diff 없음" : "No diff to display"}</div>;
  }

  return (
    <pre className="git-diff-code" aria-label={language === "ko" ? "파일 diff" : "File diff"}>
      {diff.split("\n").map((line, index) => (
        <span className={diffLineClass(line)} key={`${index}:${line}`}>
          {line || " "}
        </span>
      ))}
    </pre>
  );
}

function diffLineClass(line: string): string {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("diff --git") || line.startsWith("index ")) return "meta";
  if (line.startsWith("+++") || line.startsWith("---")) return "file";
  if (line.startsWith("+")) return "added";
  if (line.startsWith("-")) return "deleted";
  return "";
}

function fileKey(file: GitFileStatus): string {
  return `${file.status}:${file.path}:${file.renamedFrom ?? ""}`;
}

function buildDashboardRows(
  snapshot: ProjectSnapshot | null,
  branches: GitBranchSummary[],
  commits: GitCommitSummary[],
  files: GitFileStatus[],
): WorkDashboardRow[] {
  if (!snapshot) return [];

  const taskRefs = new Set(
    snapshot.tasks.flatMap((task) => [
      ...extractJiraKeys(task.title),
      ...task.externalRefs.flatMap((ref) => extractJiraKeys(`${ref.refValue} ${ref.refTitle ?? ""}`)),
    ]),
  );
  const headCommit = commits.find((commit) => commit.isHead) ?? commits[0] ?? null;
  const rows: WorkDashboardRow[] = [];

  if (snapshot.repository.dirtyCount > 0) {
    const branchName = snapshot.repository.currentBranch ?? "detached";
    const jiraKey = firstJiraKey([branchName, headCommit?.subject ?? ""]);
    rows.push({
      id: "worktree",
      title: "Uncommitted changes",
      subtitle: `${files.length} changed files on ${branchName}`,
      projectName: snapshot.project.name,
      branchName,
      prNumber: "local",
      prState: "draft",
      reviewer: "No reviewers",
      reviewState: "none",
      ciState: "pending",
      ciLabel: "local pending",
      mergeState: "draft",
      jiraKey,
      jiraState: jiraKey ? (taskRefs.has(jiraKey) ? "linked" : "in-progress") : "missing",
      updatedLabel: "now",
      isMine: true,
      ahead: null,
      behind: null,
    });
  }

  for (const [index, branch] of branches.entries()) {
    const commit = commits.find((candidate) => candidate.hash === branch.headHash) ?? null;
    const branchName = branch.branchName;
    const jiraKey = firstJiraKey([branchName, commit?.subject ?? "", ...(commit?.refs ?? [])]);
    const isDraft = !branch.upstream || branch.isCurrent;
    const hasRemoteProgress = Boolean(branch.upstream && ((branch.ahead ?? 0) > 0 || (branch.behind ?? 0) > 0));
    const isMine = branch.isCurrent || commit?.isMine === true;
    const ciState: WorkDashboardRow["ciState"] = branch.behind && branch.behind > 0 ? "failed" : isDraft ? "none" : hasRemoteProgress ? "pending" : "passed";
    const jiraState: WorkDashboardRow["jiraState"] = jiraKey ? (taskRefs.has(jiraKey) ? "linked" : "in-progress") : "missing";

    rows.push({
      id: branchName,
      title: commit?.subject ?? branchName,
      subtitle: `${branchName} · ${branchTrackLabel(branch)}`,
      projectName: snapshot.project.name,
      branchName,
      prNumber: branch.upstream ? `#${5900 + index}` : `draft-${index + 1}`,
      prState: isDraft ? "draft" : "open",
      reviewer: isMine ? "No reviewers" : "review needed",
      reviewState: isMine ? "none" : "requested",
      ciState,
      ciLabel: ciLabel(ciState, branch),
      mergeState: isDraft ? "draft" : ciState === "failed" || jiraState === "missing" ? "blocked" : "ready",
      jiraKey,
      jiraState,
      updatedLabel: commit ? relativeCommitDate(commit.committedAt) : "local",
      isMine,
      ahead: branch.ahead,
      behind: branch.behind,
    });
  }

  return rows.sort((a, b) => Number(b.isMine) - Number(a.isMine));
}

function extractJiraKeys(value: string): string[] {
  return Array.from(new Set(value.match(/[A-Z][A-Z0-9]+-\d+/g) ?? []));
}

function firstJiraKey(values: string[]): string | null {
  for (const value of values) {
    const [key] = extractJiraKeys(value);
    if (key) return key;
  }
  return null;
}

function ciLabel(state: WorkDashboardRow["ciState"], branch: GitBranchSummary): string {
  if (state === "passed") return "1/1 passed";
  if (state === "failed") return `${branch.behind ?? 1} behind`;
  if (state === "pending") return "1 pending";
  return "No checks";
}

function relativeCommitDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const elapsedMs = Date.now() - date.getTime();
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (elapsedMs < hour) return `${Math.max(1, Math.round(elapsedMs / minute))}m ago`;
  if (elapsedMs < day) return `${Math.round(elapsedMs / hour)}h ago`;
  return `${Math.round(elapsedMs / day)}d ago`;
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
  if (trimmed === "added" || trimmed === "copied" || trimmed === "untracked" || trimmed.includes("A")) {
    return "code-added";
  }
  if (trimmed === "deleted" || trimmed.includes("D")) return "code-deleted";
  if (trimmed === "renamed" || trimmed === "modified" || trimmed.includes("M")) {
    return "code-modified";
  }
  if (trimmed === "ignored") return "code-ignored";
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
    case "copied":
      return "C";
    case "untracked":
      return "??";
    case "modified":
      return "M";
    case "ignored":
      return "IG";
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
