import { useState } from "react";
import { api } from "../lib/api";
import type { ApprovalSummary, ProjectSnapshot } from "../lib/types";

interface ApprovalInboxProps {
  snapshot: ProjectSnapshot;
  onRefresh: () => Promise<void>;
}

export function ApprovalInbox({ snapshot, onRefresh }: ApprovalInboxProps) {
  const [reasonById, setReasonById] = useState<Record<string, string>>({});
  const approvals = snapshot.approvals;

  async function decide(approval: ApprovalSummary, decision: "approve" | "reject") {
    const reason = reasonById[approval.id] || (decision === "approve" ? "확인 완료" : "반려");
    if (decision === "approve") {
      await api.approveApproval(snapshot.project.id, approval.id, reason);
    } else {
      await api.rejectApproval(snapshot.project.id, approval.id, reason);
    }
    await onRefresh();
  }

  return (
    <section className="content-panel approval-inbox">
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
              <button onClick={() => decide(approval, "approve")} type="button">승인</button>
              <button onClick={() => decide(approval, "reject")} type="button">반려</button>
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
