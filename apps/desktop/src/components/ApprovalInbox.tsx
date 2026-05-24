import { useState } from "react";
import { useToast } from "./ToastProvider";
import { api } from "../lib/api";
import type { ApprovalSummary, ProjectSnapshot } from "../lib/types";

interface ApprovalInboxProps {
  snapshot: ProjectSnapshot;
  onRefresh: () => Promise<void>;
}

export function ApprovalInbox({ snapshot, onRefresh }: ApprovalInboxProps) {
  const { showToast } = useToast();
  const [reasonById, setReasonById] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const approvals = snapshot.approvals;

  async function decide(approval: ApprovalSummary, decision: "approve" | "reject") {
    const reason = reasonById[approval.id] || (decision === "approve" ? "확인 완료" : "반려");
    setBusyId(approval.id);
    try {
      if (decision === "approve") {
        await api.approveApproval(snapshot.project.id, approval.id, reason);
      } else {
        await api.rejectApproval(snapshot.project.id, approval.id, reason);
      }
      await onRefresh();
      setReasonById((current) => {
        const next = { ...current };
        delete next[approval.id];
        return next;
      });
      showToast({
        tone: "success",
        title: decision === "approve" ? "승인 완료" : "반려 완료",
        description:
          decision === "approve" && approval.approvalType === "PlanApproval"
            ? "계획 승인이 반영됐습니다. Task 상세에서 다음 role 실행을 준비하세요."
            : `${approvalLabel(approval.approvalType)} 상태가 반영되었습니다.`,
      });
    } catch (error) {
      showToast({
        tone: "error",
        title: decision === "approve" ? "승인 실패" : "반려 실패",
        description: messageFromError(error, "승인 상태를 변경하지 못했습니다."),
      });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="approval-inbox">
      <h2>승인 대기</h2>
      {approvals.length === 0 ? <p className="muted">승인 대기 항목이 없습니다.</p> : null}
      <ul className="plain-list">
        {approvals.map((approval) => (
          <li key={approval.id} className="approval-row">
            <div>
              <strong>{approvalLabel(approval.approvalType)}</strong>
              <span>{approval.requestedReason}</span>
            </div>
            <input
              placeholder="결정 사유"
              value={reasonById[approval.id] ?? ""}
              onChange={(event) =>
                setReasonById((current) => ({ ...current, [approval.id]: event.target.value }))
              }
            />
            <div className="approval-actions">
              <button
                disabled={busyId === approval.id}
                onClick={() => decide(approval, "approve")}
                type="button"
              >
                승인
              </button>
              <button
                disabled={busyId === approval.id}
                onClick={() => decide(approval, "reject")}
                type="button"
              >
                반려
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function approvalLabel(type: string): string {
  if (type === "PlanApproval") return "계획 승인";
  if (type === "RunApproval") return "실행 승인";
  if (type === "ManualStatusChange") return "수동 상태 변경";
  return type;
}

function messageFromError(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  if (typeof error === "string") return error;
  return fallback;
}
