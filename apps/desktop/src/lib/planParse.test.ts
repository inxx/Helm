import assert from "node:assert/strict";
import test from "node:test";
import { parsePlanTasks } from "./planParse.ts";

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

test("parsePlanTasks returns null on invalid or empty input", () => {
  assert.equal(parsePlanTasks("계획을 못 세웠어요"), null);
  assert.equal(parsePlanTasks('{"tasks":[]}'), null);
  assert.equal(parsePlanTasks("```json\n{not valid}\n```"), null);
});
