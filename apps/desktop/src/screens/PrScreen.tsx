import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Clock3,
  ExternalLink,
  FileDiff,
  GitCommit,
  GitMerge,
  GitPullRequest,
  MessageSquare,
  RefreshCw,
  Search,
  ThumbsUp,
  UserRound,
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// ponytail: GitHub serves avatars at github.com/<login>.png — no API call, no avatarUrl field.
function AuthorAvatar({ login }: { login: string }) {
  const [failed, setFailed] = useState(false);
  if (!login || failed) return <UserRound size={13} />;
  return (
    <img
      className="pr-author-avatar"
      src={`https://github.com/${encodeURIComponent(login)}.png?size=40`}
      alt=""
      onError={() => setFailed(true)}
    />
  );
}
import { api } from "../lib/api";
import { useI18n } from "../lib/i18n";
import type { ProjectSnapshot, PullRequestDetail, PullRequestSummary } from "../lib/types";

interface PrScreenProps {
  snapshot: ProjectSnapshot | null;
  onOpenProject: () => void;
}

export function PrScreen({ snapshot, onOpenProject }: PrScreenProps) {
  const { language } = useI18n();
  const ko = language === "ko";
  const [pulls, setPulls] = useState<PullRequestSummary[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [selected, setSelected] = useState<PullRequestSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!snapshot) {
      setPulls([]);
      setLoadError(null);
      return;
    }
    setLoading(true);
    setLoadError(null);
    api
      .listAllPullRequests()
      .then((rows) => {
        if (cancelled) return;
        setPulls(rows);
      })
      .catch((error) => {
        if (cancelled) return;
        setLoadError(messageFromError(error, ko ? "PR을 불러오지 못했습니다." : "Failed to load pull requests."));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ko, reloadKey, snapshot]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return pulls.filter((pr) => {
      if (!needle) return true;
      return [`#${pr.number}`, pr.title, pr.branch, pr.author, pr.projectName].some((value) =>
        value.toLowerCase().includes(needle),
      );
    });
  }, [pulls, search]);

  if (!snapshot) {
    return (
      <section className="empty-state">
        <h2>{ko ? "프로젝트 없음" : "No project open"}</h2>
        <p>{ko ? "프로젝트를 열면 GitHub PR이 표시됩니다." : "Open a project to see GitHub pull requests."}</p>
        <button className="primary-button" onClick={onOpenProject} type="button">
          {ko ? "프로젝트 열기" : "Open project"}
        </button>
      </section>
    );
  }

  if (selected) {
    return (
      <PrDetail
        pr={selected}
        ko={ko}
        onBack={() => setSelected(null)}
        onDone={() => {
          setSelected(null);
          setReloadKey((key) => key + 1);
        }}
      />
    );
  }

  return (
    <section className="issues-layout">
      <header className="issues-header">
        <div>
          <h2>{ko ? "Pull Requests" : "Pull Requests"}</h2>
          <p>
            {ko
              ? `전체 프로젝트 · gh CLI로 가져온 열린 PR`
              : `All projects · open PRs via gh CLI`}
          </p>
        </div>
      </header>

      {loadError ? <div className="git-inline-error">{loadError}</div> : null}

      <section className="git-work-dashboard">
        <div className="git-work-toolbar">
          <label className="git-work-search">
            <Search size={15} />
            <input
              aria-label={ko ? "PR 검색" : "Search PRs"}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={ko ? "제목, 브랜치, 작성자" : "title, branch, author"}
              value={search}
            />
          </label>
          <div className="git-work-actions">
            <button
              onClick={() => setReloadKey((key) => key + 1)}
              title={ko ? "새로고침" : "Refresh"}
              type="button"
            >
              <RefreshCw size={15} />
            </button>
          </div>
        </div>

        <div className="git-work-table-shell">
          <div className="git-work-table pr-cols" role="table" aria-label={ko ? "PR 목록" : "Pull request list"}>
            <div className="git-work-row git-work-head" role="row">
              <span>ID</span>
              <span>{ko ? "제목" : "Title"}</span>
              <span>{ko ? "상태" : "Status"}</span>
              <span>{ko ? "작성자" : "Author"}</span>
              <span>{ko ? "리뷰" : "Review"}</span>
              <span>{ko ? "검사" : "Checks"}</span>
              <span>{ko ? "업데이트됨" : "Updated"}</span>
            </div>
            {filtered.length === 0 ? (
              <div className="git-work-empty">
                {loading
                  ? ko
                    ? "불러오는 중…"
                    : "Loading…"
                  : ko
                    ? "열린 PR이 없거나 GitHub에 연결되지 않았습니다."
                    : "No open PRs, or this repo is not connected to GitHub."}
              </div>
            ) : (
              filtered.map((pr) => (
                <PrRow
                  key={`${pr.projectId}#${pr.number}`}
                  pr={pr}
                  ko={ko}
                  onSelect={() => setSelected(pr)}
                />
              ))
            )}
          </div>
        </div>
      </section>
    </section>
  );
}

function PrRow({ pr, ko, onSelect }: { pr: PullRequestSummary; ko: boolean; onSelect: () => void }) {
  const review = reviewView(pr.reviewDecision, ko);
  const checks = checksView(pr.checks, ko);
  const state = stateView(pr.state, ko);
  return (
    <div className="git-work-row git-work-row-link" role="row" onClick={onSelect}>
      <span className="git-pr-id">
        <GitPullRequest size={13} />#{pr.number}
      </span>
      <span className="git-work-titlecell">
        <strong>{pr.title}</strong>
        <span>
          {pr.branch} → {pr.base}
          {pr.isDraft ? <i className="draft">{ko ? "초안" : "draft"}</i> : null}
        </span>
      </span>
      <StatusPill tone={state.tone}>{state.label}</StatusPill>
      <StatusPill tone="muted">
        <AuthorAvatar login={pr.author} />
        {pr.author || "—"}
      </StatusPill>
      <StatusPill tone={review.tone}>{review.label}</StatusPill>
      <StatusPill tone={checks.tone}>
        {checks.icon}
        {checks.label}
      </StatusPill>
      <span className="git-work-updated">{relativeDate(pr.updatedAt)}</span>
    </div>
  );
}

function reviewView(decision: string, ko: boolean): { tone: Tone; label: string } {
  switch (decision) {
    case "APPROVED":
      return { tone: "success", label: ko ? "승인됨" : "Approved" };
    case "CHANGES_REQUESTED":
      return { tone: "danger", label: ko ? "변경 요청" : "Changes requested" };
    case "REVIEW_REQUIRED":
      return { tone: "warning", label: ko ? "리뷰 필요" : "Review required" };
    default:
      return { tone: "muted", label: ko ? "리뷰 없음" : "No review" };
  }
}

function checksView(checks: string, ko: boolean): { tone: Tone; label: string; icon: ReactNode } {
  switch (checks) {
    case "passing":
      return { tone: "success", label: ko ? "통과" : "Passing", icon: <CheckCircle2 size={13} /> };
    case "failing":
      return { tone: "danger", label: ko ? "실패" : "Failing", icon: <AlertTriangle size={13} /> };
    case "pending":
      return { tone: "warning", label: ko ? "진행 중" : "Pending", icon: <Clock3 size={13} /> };
    default:
      return { tone: "muted", label: ko ? "검사 없음" : "No checks", icon: <Clock3 size={13} /> };
  }
}

function stateView(state: string, ko: boolean): { tone: Tone; label: string } {
  switch (state.toUpperCase()) {
    case "MERGED":
      return { tone: "success", label: ko ? "머지됨" : "Merged" };
    case "CLOSED":
      return { tone: "danger", label: ko ? "닫힘" : "Closed" };
    default:
      return { tone: "warning", label: ko ? "열림" : "Open" };
  }
}

function PrDetail({
  pr,
  ko,
  onBack,
  onDone,
}: {
  pr: PullRequestSummary;
  ko: boolean;
  onBack: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState<"approve" | "merge" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<PullRequestDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(true);
  const [diff, setDiff] = useState<string | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const review = reviewView(pr.reviewDecision, ko);
  const checks = checksView(pr.checks, ko);
  const state = stateView(pr.state, ko);
  const isOpen = pr.state.toUpperCase() === "OPEN";

  useEffect(() => {
    let cancelled = false;
    setDetailLoading(true);
    api
      .pullRequestDetail(pr.projectId, pr.number)
      .then((data) => {
        if (!cancelled) setDetail(data);
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pr.projectId, pr.number]);

  // ponytail: one `gh pr diff` for the whole PR, sliced per file in-browser — no per-file fetch.
  const fileDiffs = useMemo(() => splitDiffByFile(diff ?? ""), [diff]);

  function toggleFile(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    if (diff === null && diffError === null) {
      api
        .pullRequestDiff(pr.projectId, pr.number)
        .then(setDiff)
        .catch((err) =>
          setDiffError(messageFromError(err, ko ? "diff를 불러오지 못했습니다." : "Failed to load diff.")),
        );
    }
  }

  async function run(action: "approve" | "merge") {
    setBusy(action);
    setError(null);
    try {
      if (action === "approve") await api.approvePullRequest(pr.projectId, pr.number);
      else await api.mergePullRequest(pr.projectId, pr.number);
      onDone();
    } catch (err) {
      setError(messageFromError(err, ko ? "작업에 실패했습니다." : "Action failed."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="issues-layout">
      <header className="issues-header">
        <div>
          <h2>
            #{pr.number} {pr.title}
          </h2>
          <p>
            {pr.projectName} · {pr.branch} → {pr.base}
            {pr.isDraft ? <i className="draft">{ko ? "초안" : "draft"}</i> : null}
          </p>
        </div>
        <div className="pr-header-actions">
          <button className="ghost-button" onClick={onBack} type="button">
            <ArrowLeft size={15} />
            {ko ? "목록" : "Back"}
          </button>
          <button
            className="ghost-button"
            disabled={!pr.url}
            onClick={() => pr.url && void api.openExternal(pr.url)}
            type="button"
          >
            <ExternalLink size={15} />
            {ko ? "GitHub에서 열기" : "Open on GitHub"}
          </button>
        </div>
      </header>

      {error ? <div className="git-inline-error">{error}</div> : null}

      <section className="git-work-dashboard pr-detail-card">
        <div className="pr-detail-meta">
          <StatusPill tone={state.tone}>{state.label}</StatusPill>
          <StatusPill tone="muted">
            <AuthorAvatar login={pr.author} />
            {pr.author || "—"}
          </StatusPill>
          <StatusPill tone={review.tone}>{review.label}</StatusPill>
          <StatusPill tone={checks.tone}>
            {checks.icon}
            {checks.label}
          </StatusPill>
          <span className="git-work-updated">{relativeDate(pr.updatedAt)}</span>

          <div className="pr-detail-actions">
            <button
              className="primary-button"
              disabled={!isOpen || busy !== null}
              onClick={() => void run("approve")}
              type="button"
            >
              <ThumbsUp size={15} />
              {busy === "approve" ? (ko ? "승인 중…" : "Approving…") : ko ? "승인" : "Approve"}
            </button>
            <button
              className="primary-button"
              disabled={!isOpen || busy !== null}
              onClick={() => void run("merge")}
              type="button"
            >
              <GitMerge size={15} />
              {busy === "merge" ? (ko ? "머지 중…" : "Merging…") : ko ? "메인 머지" : "Merge"}
            </button>
          </div>
        </div>

        {detailLoading ? (
          <p className="pr-detail-loading">{ko ? "상세를 불러오는 중…" : "Loading details…"}</p>
        ) : detail ? (
          <div className="pr-detail-body">
            <div className="pr-detail-stats">
              <span>
                <FileDiff size={14} />
                {detail.changedFiles} {ko ? "파일" : "files"}
              </span>
              <span className="pr-diff-add">+{detail.additions}</span>
              <span className="pr-diff-del">−{detail.deletions}</span>
              <span>
                <GitCommit size={14} />
                {detail.commits} {ko ? "커밋" : "commits"}
              </span>
              <span>
                <MessageSquare size={14} />
                {detail.comments.length} {ko ? "댓글" : "comments"}
              </span>
            </div>

            {detail.labels.length > 0 ? (
              <div className="pr-detail-labels">
                {detail.labels.map((label) => (
                  <span key={label} className="pr-label-chip">
                    {label}
                  </span>
                ))}
              </div>
            ) : null}

            <div className="pr-detail-section">
              <h3>{ko ? "설명" : "Description"}</h3>
              {detail.body.trim() ? (
                <div className="pr-detail-description">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{detail.body.trim()}</ReactMarkdown>
                </div>
              ) : (
                <p className="pr-detail-empty">{ko ? "설명이 없습니다." : "No description."}</p>
              )}
            </div>

            {detail.files.length > 0 ? (
              <div className="pr-detail-section">
                <h3>
                  {ko ? "변경된 파일" : "Changed files"} ({detail.files.length})
                </h3>
                <ul className="pr-file-list">
                  {detail.files.map((file) => {
                    const open = expanded.has(file.path);
                    return (
                      <li key={file.path} className={open ? "pr-file-open" : undefined}>
                        <div
                          className="pr-file-row-link"
                          title={ko ? "변경된 코드 보기" : "View diff"}
                          onClick={() => toggleFile(file.path)}
                        >
                          <span className="pr-file-path">{file.path}</span>
                          <span className="pr-file-stat">
                            <span className="pr-diff-add">+{file.additions}</span>
                            <span className="pr-diff-del">−{file.deletions}</span>
                          </span>
                        </div>
                        {open ? (
                          <PrFileDiff
                            diff={fileDiffs.get(file.path) ?? ""}
                            loading={diff === null && diffError === null}
                            error={diffError}
                            ko={ko}
                          />
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}

            <div className="pr-detail-section">
              <h3>
                {ko ? "대화" : "Conversation"} ({detail.comments.length})
              </h3>
              {detail.comments.length > 0 ? (
                <ul className="pr-comment-thread">
                  {detail.comments.map((comment, index) => {
                    const tag = commentTag(comment.kind, ko);
                    return (
                      <li key={`${comment.author}-${comment.createdAt}-${index}`} className="pr-comment">
                        <div className="pr-comment-head">
                          <AuthorAvatar login={comment.author} />
                          <strong>{comment.author || "—"}</strong>
                          {tag ? <span className={`pr-comment-tag ${tag.tone}`}>{tag.label}</span> : null}
                          <span className="pr-comment-date">{relativeDate(comment.createdAt)}</span>
                        </div>
                        {comment.body.trim() ? (
                          <pre className="pr-comment-body">{comment.body.trim()}</pre>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="pr-detail-empty">{ko ? "주고받은 코멘트가 없습니다." : "No comments yet."}</p>
              )}
            </div>
          </div>
        ) : null}
      </section>
    </section>
  );
}

// Split a unified PR diff into per-file sections, keyed by the new ("b/") path.
function splitDiffByFile(diff: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!diff.trim()) return map;
  for (const section of diff.split(/\n(?=diff --git )/)) {
    const match = section.match(/^diff --git a\/.+? b\/(.+)$/m);
    if (match) map.set(match[1].trim(), section);
  }
  return map;
}

function PrFileDiff({
  diff,
  loading,
  error,
  ko,
}: {
  diff: string;
  loading: boolean;
  error: string | null;
  ko: boolean;
}) {
  if (loading) return <div className="pr-detail-empty">{ko ? "diff 불러오는 중…" : "Loading diff…"}</div>;
  if (error) return <div className="git-inline-error">{error}</div>;
  if (!diff.trim()) return <div className="pr-detail-empty">{ko ? "표시할 diff 없음" : "No diff to display"}</div>;
  return (
    <pre className="git-diff-code pr-file-diff" aria-label={ko ? "파일 diff" : "File diff"}>
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

function commentTag(kind: string, ko: boolean): { tone: Tone; label: string } | null {
  switch (kind) {
    case "APPROVED":
      return { tone: "success", label: ko ? "승인" : "Approved" };
    case "CHANGES_REQUESTED":
      return { tone: "danger", label: ko ? "변경 요청" : "Changes requested" };
    case "COMMENTED":
      return { tone: "muted", label: ko ? "리뷰" : "Review" };
    default:
      return null;
  }
}

type Tone = "success" | "warning" | "danger" | "muted";

function StatusPill({ children, tone }: { children: ReactNode; tone: Tone }) {
  return <span className={`git-status-pill ${tone}`}>{children}</span>;
}

function relativeDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || "—";
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
    return String((error as { message: unknown }).message);
  }
  return fallback;
}
