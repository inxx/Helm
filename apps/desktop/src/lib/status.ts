import type { TaskStatus } from "./types";
import type { AppLanguage } from "./i18n";

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

const TASK_STATUS_LABELS: Record<AppLanguage, Record<TaskStatus, string>> = {
  en: {
    Planned: "Planned",
    Ready: "Ready",
    Coding: "Coding",
    PlanVerification: "Plan Review",
    CodeReview: "Code Review",
    Testing: "Testing",
    MergeWaiting: "Merge Waiting",
    Merged: "Merged",
    Done: "Done",
    Blocked: "Blocked",
  },
  ko: TASK_STATUS_LABEL,
};

export function taskStatusLabel(status: TaskStatus, language: AppLanguage = "ko"): string {
  return TASK_STATUS_LABELS[language][status] ?? status;
}

export function shortHash(hash: string | null): string {
  if (!hash) return "-";
  return hash.slice(0, 8);
}
