import type { TaskStatus } from "./types";

export const TASK_STATUS_ORDER: TaskStatus[] = [
  "Planned",
  "Ready",
  "Coding",
  "PlanVerification",
  "CodeReview",
  "Testing",
  "MergeWaiting",
  "Merged",
  "Done",
  "Blocked",
];

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  Planned: "계획됨",
  Ready: "준비됨",
  Coding: "코딩중",
  PlanVerification: "계획 검토",
  CodeReview: "코드 리뷰",
  Testing: "테스트",
  MergeWaiting: "머지 대기",
  Merged: "머지됨",
  Done: "완료",
  Blocked: "막힘",
};

export function shortHash(hash: string | null): string {
  if (!hash) return "-";
  return hash.slice(0, 8);
}
