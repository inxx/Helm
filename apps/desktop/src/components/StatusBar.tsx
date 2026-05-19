import { shortHash } from "../lib/status";
import type { ProjectSnapshot } from "../lib/types";

interface StatusBarProps {
  snapshot: ProjectSnapshot;
}

export function StatusBar({ snapshot }: StatusBarProps) {
  return (
    <section className="statusbar">
      <div>
        <span className="status-label">브랜치</span>
        <strong>{snapshot.repository.currentBranch ?? "detached"}</strong>
      </div>
      <div>
        <span className="status-label">HEAD</span>
        <strong>{shortHash(snapshot.repository.head)}</strong>
      </div>
      <div>
        <span className="status-label">변경 파일</span>
        <strong>{snapshot.repository.dirtyCount}</strong>
      </div>
      <div>
        <span className="status-label">태스크</span>
        <strong>{snapshot.taskCounts.total}</strong>
      </div>
      <div>
        <span className="status-label">완료</span>
        <strong>{snapshot.taskCounts.done}</strong>
      </div>
    </section>
  );
}
