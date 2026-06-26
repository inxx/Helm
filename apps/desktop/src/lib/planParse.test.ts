import assert from "node:assert/strict";
import test from "node:test";
import { dedupePlanTasks, parseOrchestratorReply, parsePlanTasks, stripPlanJson } from "./planParse.ts";

test("parsePlanTasks reads a fenced json block, ignoring surrounding prose", () => {
  const text = "여기 계획입니다:\n```json\n{\"tasks\":[{\"title\":\"로그인 UI\",\"description\":\"폼 작성\",\"role\":\"coder\"}]}\n```\n끝.";
  const tasks = parsePlanTasks(text);
  assert.deepEqual(tasks, [{ title: "로그인 UI", description: "폼 작성", role: "coder" }]);
});

test("parsePlanTasks falls back to the outermost object when unfenced", () => {
  const tasks = parsePlanTasks('{"tasks":[{"title":"A"},{"title":"B","role":"tester"}]}');
  assert.equal(tasks?.length, 2);
  assert.equal(tasks?.[1].role, "tester");
});

test("parsePlanTasks accepts a bare array", () => {
  const tasks = parsePlanTasks('[{"title":"only"}]');
  assert.deepEqual(tasks, [{ title: "only", description: undefined, role: undefined }]);
});

test("parsePlanTasks drops entries without a usable title", () => {
  const tasks = parsePlanTasks('{"tasks":[{"title":"  "},{"description":"no title"},{"title":"keep"}]}');
  assert.deepEqual(tasks, [{ title: "keep", description: undefined, role: undefined }]);
});

test("dedupePlanTasks drops titles already present (normalized) and in-batch repeats", () => {
  const tasks = [
    { title: "리스트 패리티 반영" }, // already exists
    { title: "  배너 슬라이드  타이틀 " }, // whitespace/case variant of existing
    { title: "새 작업" },
    { title: "새 작업" }, // in-batch repeat of the one above
  ];
  const fresh = dedupePlanTasks(tasks, ["리스트 패리티 반영", "배너 슬라이드 타이틀"]);
  assert.deepEqual(fresh.map((task) => task.title), ["새 작업"]);
});

test("parsePlanTasks returns null on invalid or empty input", () => {
  assert.equal(parsePlanTasks("계획을 못 세웠어요"), null);
  assert.equal(parsePlanTasks('{"tasks":[]}'), null);
  assert.equal(parsePlanTasks("```json\n{not valid}\n```"), null);
});

test("parseOrchestratorReply reads questions when not ready, tolerating prose and fences", () => {
  const text = "확인이 필요합니다:\n```json\n{\"ready\":false,\"requirement\":\"목표: 로그인\",\"questions\":[\"어떤 인증?\"],\"assumptions\":[\"웹 전용\"]}\n```";
  const reply = parseOrchestratorReply(text);
  assert.deepEqual(reply, {
    ready: false,
    requirement: "목표: 로그인",
    questions: ["어떤 인증?"],
    assumptions: ["웹 전용"],
  });
});

test("parseOrchestratorReply marks ready and defaults missing arrays", () => {
  const reply = parseOrchestratorReply('{"ready":true,"requirement":"정리 완료"}');
  assert.deepEqual(reply, { ready: true, requirement: "정리 완료", questions: [], assumptions: [] });
});

test("parseOrchestratorReply returns null when no ready-shaped object is present", () => {
  assert.equal(parseOrchestratorReply("그냥 설명만 있는 응답"), null);
  assert.equal(parseOrchestratorReply('{"tasks":[{"title":"A"}]}'), null);
});

test("stripPlanJson removes a tasks json block but keeps prose and other code", () => {
  const text = "정리했습니다.\n```json\n{\"tasks\":[{\"title\":\"A\",\"role\":\"planner\"}]}\n```";
  assert.equal(stripPlanJson(text), "정리했습니다.");
  // a non-task code block survives
  const other = "예시:\n```ts\nconst a = 1;\n```";
  assert.equal(stripPlanJson(other), other);
  // mid-stream unterminated fence is dropped
  assert.equal(stripPlanJson("진행합니다.\n```json\n{\"tasks\":[{\"title\":\"A\""), "진행합니다.");
});
