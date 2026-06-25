import assert from "node:assert/strict";
import { test } from "node:test";
import { parseApprovalDecision } from "./approvalIntent.ts";

test("approve/reject keywords with and without reason", () => {
  assert.deepEqual(parseApprovalDecision("승인"), {
    decision: "approve",
    reason: "",
  });
  assert.deepEqual(parseApprovalDecision("승인: 범위 확인됨"), {
    decision: "approve",
    reason: "범위 확인됨",
  });
  assert.deepEqual(parseApprovalDecision("approve looks good"), {
    decision: "approve",
    reason: "looks good",
  });
  assert.deepEqual(parseApprovalDecision("반려 테스트 부족"), {
    decision: "reject",
    reason: "테스트 부족",
  });
  assert.deepEqual(parseApprovalDecision("거절"), {
    decision: "reject",
    reason: "",
  });
});

test("non-decision input returns null", () => {
  assert.equal(parseApprovalDecision("승인해줘서 고마워"), null); // 키워드 뒤에 글자가 붙으면(구분자/끝 아님) 명령이 아님
  assert.equal(parseApprovalDecision("계획 다시 봐줘"), null);
  assert.equal(parseApprovalDecision("확인"), null); // 요구사항 확인 토큰과 충돌 방지
});
