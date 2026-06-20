import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  ExternalLink,
  Filter,
  GitBranch,
  GitPullRequest,
  RefreshCw,
  Search,
  UserRound,
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { useI18n, type AppLanguage } from "../lib/i18n";
import type { GitBranchSummary, GitCommitSummary, GitFileStatus, ProjectSnapshot, TaskSummary } from "../lib/types";

interface IssuesScreenProps {
  snapshot: ProjectSnapshot | null;
  onOpenProject: () => void;
}

type WorkFilter = "open" | "mine" | "review" | "ci-failed" | "jira-gap";

interface WorkDashboardRow {
  id: string;
  source: "git" | "jira" | "worktree";
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
}

export function IssuesScreen({ snapshot, onOpenProject }: IssuesScreenProps) {
  const { language } = useI18n();
  const [activeFilter, setActiveFilter] = useState<WorkFilter>("open");
  const [search, setSearch] = useState("");
  const [branches, setBranches] = useState<GitBranchSummary[]>([]);
  const [commits, setCommits] = useState<GitCommitSummary[]>([]);
  const [files, setFiles] = useState<GitFileStatus[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (!snapshot) {
      setBranches([]);
      setCommits([]);
      setFiles([]);
      setLoadError(null);
      return;
    }

    setLoadError(null);
    void Promise.all([
      api.getLocalBranches(snapshot.project.id),
      api.getRecentCommits(snapshot.project.id, 100),
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
        setLoadError(messageFromError(error, language === "ko" ? "이슈 데이터를 불러오지 못했습니다." : "Failed to load issue data."));
      });

    return () => {
      cancelled = true;
    };
  }, [language, snapshot]);

  const rows = useMemo(
    () => buildDashboardRows(snapshot, branches, commits, files),
    [branches, commits, files, snapshot],
  );

  if (!snapshot) {
    return (
      <section className="empty-state">
        <h2>{language === "ko" ? "프로젝트 없음" : "No project open"}</h2>
        <p>{language === "ko" ? "프로젝트를 열면 Jira와 Git 작업 흐름이 표시됩니다." : "Open a project to see Jira and Git work."}</p>
        <button className="primary-button" onClick={onOpenProject} type="button">
          {language === "ko" ? "프로젝트 열기" : "Open project"}
        </button>
      </section>
    );
  }

  const jiraConfigured = Boolean(
    snapshot.settings.jiraConfig?.enabled &&
      (snapshot.settings.jiraConfig.projectKey || snapshot.settings.jiraConfig.siteUrl),
  );
  const jiraRefs = snapshot.tasks.reduce((count, task) => count + jiraKeysForTask(task).length, 0);
  const gitConnected = Boolean(snapshot.repository.head || branches.length > 0);
  const githubLinked = branches.some((branch) => branch.upstream?.startsWith("origin/"));

  return (
    <section className="issues-layout">
      <header className="issues-header">
        <div>
          <h2>{language === "ko" ? "이슈" : "Issues"}</h2>
          <p>{language === "ko" ? "Jira 이슈, Git 브랜치, PR 후보와 CI 상태를 한 화면에서 봅니다." : "Track Jira issues, Git branches, PR candidates, and checks in one place."}</p>
        </div>
        <div className="issues-source-strip" aria-label={language === "ko" ? "연결 상태" : "Connection status"}>
          <SourceChip label="Git" active={gitConnected} detail={gitConnected ? snapshot.repository.currentBranch ?? "detached" : "offline"} />
          <SourceChip label="GitHub" active={githubLinked} detail={githubLinked ? "origin linked" : "local only"} />
          <SourceChip label="Jira" active={jiraConfigured || jiraRefs > 0} detail={jiraConfigured ? snapshot.settings.jiraConfig?.projectKey ?? "configured" : `${jiraRefs} refs`} />
        </div>
      </header>

      {loadError ? <div className="git-inline-error">{loadError}</div> : null}

      <IntegrationDashboard
        rows={rows}
        snapshot={snapshot}
        activeFilter={activeFilter}
        onFilterChange={setActiveFilter}
        search={search}
        onSearchChange={setSearch}
        language={language}
      />
    </section>
  );
}

function SourceChip({ active, detail, label }: { active: boolean; detail: string; label: string }) {
  return (
    <span className={active ? "issues-source-chip active" : "issues-source-chip"}>
      <strong>{label}</strong>
      <em>{detail}</em>
    </span>
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

      return [row.title, row.subtitle, row.branchName, row.jiraKey, row.projectName, row.prNumber]
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
                ? `${snapshot.project.name} 프로젝트 · 연결된 데이터 우선 표시`
                : `${snapshot.project.name} project · connected data first`}
            </span>
          </div>
        </div>
        <div className="git-work-actions" aria-label={language === "ko" ? "이슈 액션" : "Issue actions"}>
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
        <div className="git-work-filters" role="tablist" aria-label={language === "ko" ? "이슈 필터" : "Issue filters"}>
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
            placeholder="is:pr is:open branch:JIRA-123"
            value={search}
          />
        </label>
      </div>

      <div className="git-work-table-shell">
        <div className="git-work-table" role="table" aria-label={language === "ko" ? "이슈 목록" : "Issue list"}>
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
              {language === "ko" ? "조건에 맞는 이슈가 없습니다." : "No issues match this filter."}
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
          <i className={row.prState === "draft" ? "draft" : ""}>{row.prState === "draft" ? row.source : row.projectName}</i>
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

function buildDashboardRows(
  snapshot: ProjectSnapshot | null,
  branches: GitBranchSummary[],
  commits: GitCommitSummary[],
  files: GitFileStatus[],
): WorkDashboardRow[] {
  if (!snapshot) return [];

  const taskRefs = new Set(snapshot.tasks.flatMap((task) => [task.title, ...task.externalRefs.map((ref) => `${ref.refValue} ${ref.refTitle ?? ""}`)].flatMap(extractJiraKeys)));
  const headCommit = commits.find((commit) => commit.isHead) ?? commits[0] ?? null;
  const rows: WorkDashboardRow[] = [];

  if (snapshot.repository.dirtyCount > 0) {
    const branchName = snapshot.repository.currentBranch ?? "detached";
    const jiraKey = firstJiraKey([branchName, headCommit?.subject ?? ""]);
    rows.push({
      id: "worktree",
      source: "worktree",
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
      id: `git:${branchName}`,
      source: "git",
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
    });
  }

  const branchJiraKeys = new Set(rows.map((row) => row.jiraKey).filter(Boolean));
  for (const task of snapshot.tasks) {
    for (const jiraKey of jiraKeysForTask(task)) {
      if (branchJiraKeys.has(jiraKey)) continue;
      rows.push({
        id: `jira:${task.id}:${jiraKey}`,
        source: "jira",
        title: task.title,
        subtitle: `${task.status} · Helm task`,
        projectName: snapshot.project.name,
        branchName: "",
        prNumber: jiraKey,
        prState: "draft",
        reviewer: "No reviewers",
        reviewState: "none",
        ciState: "none",
        ciLabel: "No checks",
        mergeState: "draft",
        jiraKey,
        jiraState: "linked",
        updatedLabel: relativeCommitDate(task.updatedAt),
        isMine: false,
      });
    }
  }

  return rows.sort((a, b) => Number(b.isMine) - Number(a.isMine));
}

function jiraKeysForTask(task: TaskSummary): string[] {
  return [
    task.title,
    task.description,
    ...task.externalRefs.map((ref) => `${ref.refValue} ${ref.refTitle ?? ""}`),
  ].flatMap(extractJiraKeys);
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

function branchTrackLabel(branch: GitBranchSummary): string {
  if (!branch.upstream) return "local";
  const parts = [];
  if (branch.ahead) parts.push(`+${branch.ahead}`);
  if (branch.behind) parts.push(`-${branch.behind}`);
  return parts.length > 0 ? parts.join(" / ") : "synced";
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

function messageFromError(error: unknown, fallback: string): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String(error.message);
  }
  return fallback;
}
