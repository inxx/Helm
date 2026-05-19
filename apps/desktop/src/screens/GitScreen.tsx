import { useEffect, useState } from "react";
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

export function GitScreen({ snapshot, onOpenProject }: GitScreenProps) {
  const [branches, setBranches] = useState<GitBranchSummary[]>([]);
  const [commits, setCommits] = useState<GitCommitSummary[]>([]);
  const [files, setFiles] = useState<GitFileStatus[]>([]);

  useEffect(() => {
    if (!snapshot) return;
    void Promise.all([
      api.getLocalBranches(snapshot.project.id).then(setBranches),
      api.getRecentCommits(snapshot.project.id).then(setCommits),
      api.getChangedFiles(snapshot.project.id).then(setFiles),
    ]);
  }, [snapshot]);

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
      <section className="content-panel">
        <h2>저장소 상태</h2>
        <div className="metric-grid">
          <div><span>브랜치</span><strong>{snapshot.repository.currentBranch ?? "detached"}</strong></div>
          <div><span>HEAD</span><strong>{shortHash(snapshot.repository.head)}</strong></div>
          <div><span>Staged</span><strong>{snapshot.repository.stagedCount}</strong></div>
          <div><span>Unstaged</span><strong>{snapshot.repository.unstagedCount}</strong></div>
          <div><span>Untracked</span><strong>{snapshot.repository.untrackedCount}</strong></div>
        </div>
      </section>

      <section className="content-panel">
        <h2>변경 파일</h2>
        {files.length === 0 ? <p className="muted">변경 파일 없음</p> : null}
        <ul className="file-list">
          {files.map((file) => (
            <li key={`${file.status}:${file.path}`}>
              <span>{file.status}</span>
              <strong>{file.path}</strong>
            </li>
          ))}
        </ul>
      </section>

      <section className="content-panel">
        <h2>로컬 브랜치</h2>
        <ul className="plain-list">
          {branches.map((branch) => (
            <li key={branch.branchName}>
              <strong>{branch.branchName}</strong>
              <span>{branch.isCurrent ? "현재" : shortHash(branch.headHash)}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="content-panel">
        <h2>최근 커밋</h2>
        <ul className="commit-list">
          {commits.map((commit) => (
            <li key={commit.hash}>
              <strong>{commit.subject}</strong>
              <span>{commit.shortHash} · {commit.authorName}{commit.isMine ? " · 내 커밋" : ""}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
