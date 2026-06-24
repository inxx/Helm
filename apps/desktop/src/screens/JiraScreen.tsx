import { ChevronDown, ExternalLink, RefreshCw, Search, Ticket, UserRound } from "lucide-react";
import { type MouseEvent, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../lib/api";
import { useI18n } from "../lib/i18n";
import type { JiraIssueSummary, JiraRelation, JiraTransition, ProjectSnapshot } from "../lib/types";

type RelationFilter = "all" | JiraRelation;

interface JiraScreenProps {
  snapshot: ProjectSnapshot | null;
  onOpenProject: () => void;
}

export function JiraScreen({ snapshot, onOpenProject }: JiraScreenProps) {
  const { language } = useI18n();
  const ko = language === "ko";
  const [issues, setIssues] = useState<JiraIssueSummary[]>([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [relationFilter, setRelationFilter] = useState<RelationFilter>("all");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    if (!snapshot) {
      setIssues([]);
      setLoadError(null);
      return;
    }
    setLoading(true);
    setLoadError(null);
    api
      .listJiraIssues(snapshot.project.id)
      .then((rows) => {
        if (cancelled) return;
        setIssues(rows);
      })
      .catch((error) => {
        if (cancelled) return;
        setIssues([]);
        setLoadError(messageFromError(error, ko ? "Jira 이슈를 불러오지 못했습니다." : "Failed to load Jira issues."));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ko, reloadKey, snapshot]);

  const statuses = useMemo(
    () => Array.from(new Set(issues.map((issue) => issue.status).filter(Boolean))).sort(),
    [issues],
  );

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return issues.filter((issue) => {
      if (statusFilter !== "all" && issue.status !== statusFilter) return false;
      if (relationFilter !== "all" && !issue.relations.includes(relationFilter)) return false;
      if (!needle) return true;
      return [issue.key, issue.summary, issue.status, issue.assignee].some((value) =>
        value.toLowerCase().includes(needle),
      );
    });
  }, [issues, search, statusFilter, relationFilter]);

  const relationOptions: Array<{ value: RelationFilter; label: string }> = [
    { value: "all", label: ko ? "전체" : "All" },
    { value: "assignee", label: ko ? "담당" : "Assignee" },
    { value: "reporter", label: ko ? "보고자" : "Reporter" },
    { value: "watcher", label: ko ? "관찰" : "Watcher" },
  ];

  if (!snapshot) {
    return (
      <section className="empty-state">
        <h2>{ko ? "프로젝트 없음" : "No project open"}</h2>
        <p>{ko ? "프로젝트를 열면 Jira 이슈가 표시됩니다." : "Open a project to see Jira issues."}</p>
        <button className="primary-button" onClick={onOpenProject} type="button">
          {ko ? "프로젝트 열기" : "Open project"}
        </button>
      </section>
    );
  }

  return (
    <section className="issues-layout">
      <header className="issues-header">
        <div>
          <h2>Jira</h2>
          <p>
            {ko
              ? `${snapshot.project.name} · 나와 관련된 Jira 이슈 (담당·보고·관찰)`
              : `${snapshot.project.name} · my Jira issues (assigned, reported, watched)`}
          </p>
        </div>
      </header>

      {loadError ? <div className="git-inline-error">{loadError}</div> : null}

      <section className="git-work-dashboard">
        <div className="git-work-toolbar">
          <label className="git-work-search">
            <Search size={15} />
            <input
              aria-label={ko ? "Jira 검색" : "Search Jira"}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={ko ? "키, 제목, 상태, 담당자" : "key, title, status, assignee"}
              value={search}
            />
          </label>
          <select
            className="jira-status-filter"
            aria-label={ko ? "관계 필터" : "Relation filter"}
            value={relationFilter}
            onChange={(event) => setRelationFilter(event.target.value as RelationFilter)}
          >
            {relationOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <select
            className="jira-status-filter"
            aria-label={ko ? "상태 필터" : "Status filter"}
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
          >
            <option value="all">{ko ? "모든 상태" : "All statuses"}</option>
            {statuses.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
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
          <div className="git-work-table jira-cols" role="table" aria-label={ko ? "Jira 목록" : "Jira list"}>
            <div className="git-work-row git-work-head" role="row">
              <span>{ko ? "키" : "Key"}</span>
              <span>{ko ? "제목" : "Title"}</span>
              <span>{ko ? "담당자" : "Assignee"}</span>
              <span>{ko ? "상태" : "Status"}</span>
              <span>{ko ? "업데이트됨" : "Updated"}</span>
            </div>
            {filtered.length === 0 ? (
              <div className="git-work-empty">
                {loading
                  ? ko
                    ? "불러오는 중…"
                    : "Loading…"
                  : loadError
                    ? ko
                      ? "설정 → Jira에서 사이트·이메일·토큰을 확인해주세요."
                      : "Check site, email, and token under Settings → Jira."
                    : ko
                      ? "진행 중인 Jira 이슈가 없습니다."
                      : "No open Jira issues."}
              </div>
            ) : (
              filtered.map((issue) => (
                <JiraRowView
                  key={issue.key}
                  issue={issue}
                  ko={ko}
                  projectId={snapshot.project.id}
                  onStatusChanged={(key, status) =>
                    setIssues((rows) => rows.map((row) => (row.key === key ? { ...row, status } : row)))
                  }
                />
              ))
            )}
          </div>
        </div>
      </section>
    </section>
  );
}

function JiraRowView({
  issue,
  ko,
  projectId,
  onStatusChanged,
}: {
  issue: JiraIssueSummary;
  ko: boolean;
  projectId: string;
  onStatusChanged: (key: string, status: string) => void;
}) {
  return (
    <div
      className={issue.url ? "git-work-row git-work-row-link" : "git-work-row"}
      role="row"
      onClick={() => issue.url && void api.openExternal(issue.url)}
    >
      <span className="git-pr-id">
        <Ticket size={13} />
        {issue.key}
      </span>
      <span className="git-work-titlecell jira-titlecell">
        <strong>{issue.summary}</strong>
        {issue.url ? <ExternalLink className="jira-link-icon" size={12} /> : null}
      </span>
      <span className="git-status-pill muted">
        {issue.assigneeAvatar ? (
          <img className="jira-assignee-avatar" src={issue.assigneeAvatar} alt="" />
        ) : (
          <UserRound size={13} />
        )}
        {issue.assignee || (ko ? "미지정" : "Unassigned")}
      </span>
      <JiraStatusSelect issue={issue} ko={ko} projectId={projectId} onStatusChanged={onStatusChanged} />
      <span className="git-work-updated">{relativeDate(issue.updatedAt)}</span>
    </div>
  );
}

function JiraStatusSelect({
  issue,
  ko,
  projectId,
  onStatusChanged,
}: {
  issue: JiraIssueSummary;
  ko: boolean;
  projectId: string;
  onStatusChanged: (key: string, status: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [transitions, setTransitions] = useState<JiraTransition[] | null>(null);
  const [busy, setBusy] = useState(false);

  const toggle = (event: MouseEvent) => {
    event.stopPropagation();
    if (open) {
      setOpen(false);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    setPos({ top: rect.bottom + 4, left: rect.left });
    setOpen(true);
    if (transitions === null) {
      api
        .listJiraTransitions(projectId, issue.key)
        .then(setTransitions)
        .catch(() => setTransitions([]));
    }
  };

  const pick = (event: MouseEvent, transition: JiraTransition) => {
    event.stopPropagation();
    setBusy(true);
    api
      .setJiraStatus(projectId, issue.key, transition.id)
      .then(() => {
        onStatusChanged(issue.key, transition.name);
        setOpen(false);
        setTransitions(null); // available transitions depend on the new status
      })
      .catch((error) => {
        window.alert(messageFromError(error, ko ? "상태 변경 실패" : "Failed to change status"));
      })
      .finally(() => setBusy(false));
  };

  return (
    <span className="jira-status-select" onClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        className={`git-status-pill ${jiraStatusVariant(issue.status)} jira-status-trigger`}
        onClick={toggle}
        disabled={busy}
      >
        {issue.status}
        <ChevronDown size={12} className="jira-status-caret" />
      </button>
      {open && pos
        ? createPortal(
            <>
              <div
                className="jira-status-backdrop"
                onClick={(event) => {
                  event.stopPropagation();
                  setOpen(false);
                }}
              />
              <div
                className="jira-status-menu"
                role="listbox"
                style={{ top: pos.top, left: pos.left }}
                onClick={(event) => event.stopPropagation()}
              >
                {transitions === null ? (
                  <div className="jira-status-menu-empty">{ko ? "불러오는 중…" : "Loading…"}</div>
                ) : transitions.length === 0 ? (
                  <div className="jira-status-menu-empty">{ko ? "가능한 전환 없음" : "No transitions"}</div>
                ) : (
                  transitions.map((transition) => (
                    <button
                      key={transition.id}
                      type="button"
                      className="jira-status-menu-item"
                      onClick={(event) => pick(event, transition)}
                    >
                      {transition.name}
                    </button>
                  ))
                )}
              </div>
            </>,
            document.body,
          )
        : null}
    </span>
  );
}

function jiraStatusVariant(status: string): string {
  const s = status.trim().toLowerCase();
  if (/(done|완료|resolved|closed)/.test(s)) return "success";
  if (/(drop|취소|cancel|reject)/.test(s)) return "danger";
  if (/(review|qa|리뷰)/.test(s)) return "warning";
  if (/(doing|progress|진행)/.test(s)) return "info";
  return "muted"; // todo, backlog 등 등록만 된 상태
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
