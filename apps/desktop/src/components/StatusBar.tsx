import { shortHash } from "../lib/status";
import type { ProjectSnapshot } from "../lib/types";

interface StatusBarProps {
  snapshot: ProjectSnapshot;
}

export function StatusBar({ snapshot }: StatusBarProps) {
  const dirtyCount = snapshot.repository.dirtyCount;
  const totalTasks = snapshot.taskCounts.total;
  const doneTasks = snapshot.taskCounts.done;

  return (
    <section className="statusbar" aria-label="repository status">
      <div>
        <span className="status-label">branch</span>
        <strong>{snapshot.repository.currentBranch ?? "detached"}</strong>
      </div>
      <div>
        <span className="status-label">head</span>
        <strong>{shortHash(snapshot.repository.head)}</strong>
      </div>
      <div>
        <span className="status-label">workspace</span>
        <strong className={dirtyCount === 0 ? "tone-ok" : "tone-warn"}>
          {dirtyCount === 0 ? "clean" : `${dirtyCount} changed`}
        </strong>
      </div>
      <div>
        <span className="status-label">tasks</span>
        <strong>{totalTasks}</strong>
      </div>
      <div>
        <span className="status-label">done</span>
        <strong className={doneTasks > 0 ? "tone-ok" : undefined}>{doneTasks}</strong>
      </div>
    </section>
  );
}
