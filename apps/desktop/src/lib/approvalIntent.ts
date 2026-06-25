// 채팅 입력에서 승인/반려 의도를 뽑는다. 키워드 뒤에 오는 텍스트는 결정 사유로 쓴다.
// ponytail: 선두 키워드 매칭. 자연어 전체 해석이 필요해지면 그때 확장한다.
export function parseApprovalDecision(
  text: string,
): { decision: "approve" | "reject"; reason: string } | null {
  // \b는 ASCII 전용이라 한글 경계에 안 걸린다. 키워드 뒤를 끝/구분자(공백·:,-)로만 직접 검사한다.
  const trimmed = text.trim();
  const approve = trimmed.match(/^(?:승인|approve)(?:[\s:,-]+(.*))?$/is);
  if (approve)
    return { decision: "approve", reason: (approve[1] ?? "").trim() };
  const reject = trimmed.match(/^(?:반려|거절|reject)(?:[\s:,-]+(.*))?$/is);
  if (reject) return { decision: "reject", reason: (reject[1] ?? "").trim() };
  return null;
}
