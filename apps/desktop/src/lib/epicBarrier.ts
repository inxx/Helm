import { TASK_STATUS_ORDER } from "./status.ts";
import type { TaskStatus, TaskSummary } from "./types";

// epic 게이트(plan_verifier=PlanVerification, code_reviewer=CodeReview)는 anchor task에서
// 1회만 도는데, 형제 task가 모두 게이트 상태에 도달해야 발화한다. anchor가 게이트 상태에
// 와 있어도 형제가 덜 왔으면 카드는 idle처럼 보이며 조용히 대기한다 — 그 대기를 가시화한다.
// 규칙은 db.rs의 epic_gate_ready / epic_barrier_met와 동일(공유 코드 없는 의도적 미러).
const EPIC_GATE_STATUSES: TaskStatus[] = ["PlanVerification", "CodeReview"];

export interface EpicBarrierWait {
  gateStatus: TaskStatus;
  blocking: TaskSummary[]; // 아직 게이트에 도달 못 했거나 Blocked인 형제들
}

// task가 epic 게이트 anchor로서 형제를 기다리는 중이면 막고 있는 형제 목록을, 아니면 null.
export function epicBarrierWait(task: TaskSummary, allTasks: TaskSummary[]): EpicBarrierWait | null {
  if (!task.epicId) return null;
  if (!EPIC_GATE_STATUSES.includes(task.status)) return null;
  const gateIdx = TASK_STATUS_ORDER.indexOf(task.status);
  const siblings = allTasks.filter((candidate) => candidate.epicId === task.epicId);
  if (siblings.length <= 1) return null;
  // anchor = (sortOrder, id) 최소. anchor가 아니면 이 카드는 게이트를 호스팅하지 않는다.
  const anchor = siblings.reduce((min, candidate) =>
    candidate.sortOrder < min.sortOrder ||
    (candidate.sortOrder === min.sortOrder && candidate.id < min.id)
      ? candidate
      : min,
  );
  if (anchor.id !== task.id) return null;
  // Blocked는 순서상 뒤에 있어도 "진행"이 아니므로 배리어를 막는다(backend와 동일).
  const blocking = siblings.filter(
    (sib) => sib.status === "Blocked" || TASK_STATUS_ORDER.indexOf(sib.status) < gateIdx,
  );
  return blocking.length > 0 ? { gateStatus: task.status, blocking } : null;
}
