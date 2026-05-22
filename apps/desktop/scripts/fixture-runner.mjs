#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);

if (args.includes("--health")) {
  process.stdout.write("fixture-runner ok\n");
  process.exit(0);
}

if (args.includes("--planning")) {
  process.stdout.write(
    JSON.stringify(
      {
        title: "Fixture planner draft",
        summary: "Fixture planner가 목표를 계획 문서 초안으로 정리했습니다.",
        scope: ["planning conversation", "draft approval", "task materialize"],
        tasks: [
          {
            title: "Fixture planning task",
            description: "fixture planner conversation 결과를 확인합니다.",
            subtasks: ["planning command 실행", "Plan Document 갱신", "승인 후 Task 생성"],
            acceptanceCriteria: ["planner 응답이 Plan Document에 반영된다.", "승인 전 Task가 생성되지 않는다."],
            risks: ["fixture 응답은 실제 repo 분석을 하지 않는다."],
            testPlan: ["Planning 탭에서 fixture template으로 대화 실행을 확인한다."],
          },
        ],
        openQuestions: [],
        risks: ["fixture 응답은 실제 AI plan mode를 대체하지 않는다."],
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const modeIndex = args.indexOf("--mode");
const mode = modeIndex >= 0 ? args[modeIndex + 1] ?? "pass" : "pass";
const artifactDir = mustEnv("HELM_ARTIFACT_DIR");
const roleId = process.env.HELM_ROLE_ID ?? "unknown";
const taskId = process.env.HELM_TASK_ID ?? "unknown-task";
const resultPath = process.env.HELM_RESULT_PATH ?? path.join(artifactDir, "structured-result.json");
const summaryPath = process.env.HELM_SUMMARY_PATH ?? path.join(artifactDir, "summary.md");
const worktreePath = process.env.HELM_WORKTREE_PATH ?? process.cwd();

fs.mkdirSync(artifactDir, { recursive: true });

if (mode === "schema_invalid") {
  fs.writeFileSync(summaryPath, `# Fixture ${roleId}\n\nInvalid schema fixture.\n`);
  fs.writeFileSync(resultPath, JSON.stringify({ schemaVersion: 1, status: "pass" }, null, 2));
  process.exit(0);
}

const changedFiles = [];
if (roleId === "coder" && (mode === "pass" || mode === "changed_files_mismatch")) {
  const outputDir = path.join(worktreePath, "helm-fixture-output");
  fs.mkdirSync(outputDir, { recursive: true });
  const filePath = path.join(outputDir, `${taskId}.txt`);
  fs.writeFileSync(filePath, `Fixture coder output for ${taskId}\n`);
  changedFiles.push(path.relative(worktreePath, filePath));
}

const status = mode === "fail" ? "fail" : mode === "needs_changes" ? "needs_changes" : "pass";
const summary = `Fixture ${roleId} completed with ${status}.`;
const reportedChangedFiles = mode === "changed_files_mismatch" ? [] : changedFiles;
const gateResult =
  mode === "gate_fail"
    ? {
        gate: roleId === "plan_verifier" ? "plan_verification" : "rules",
        status: "fail",
        blocking: true,
        summary: "Fixture blocking gate failed.",
        blockers: [
          {
            id: "fixture-gate-failure",
            severity: "error",
            summary: "Fixture gate requires repair.",
            file: "README.md",
          },
        ],
        affectedFiles: ["README.md"],
        suggestedNext: {
          action: "fix",
          reason: "Repair fixture gate failure and rerun verification.",
        },
      }
    : null;

fs.writeFileSync(
  summaryPath,
  `# Fixture ${roleId}\n\n- status: ${status}\n- task: ${taskId}\n`,
);
fs.writeFileSync(
  resultPath,
  JSON.stringify(
    {
      schemaVersion: 1,
      status,
      summary,
      changedFiles: reportedChangedFiles,
      risks: status === "pass" ? [] : ["Fixture runner forced a non-pass result."],
      nextActions: nextActionsFor(roleId, status),
      gateResult,
    },
    null,
    2,
  ),
);

process.stdout.write(`${summary}\n`);
process.exit(mode === "fail" ? 1 : 0);

function mustEnv(name) {
  const value = process.env[name];
  if (!value) {
    process.stderr.write(`${name} is required\n`);
    process.exit(2);
  }
  return value;
}

function nextActionsFor(roleId, status) {
  if (status !== "pass") return ["Review fixture failure output."];
  if (roleId === "planner") return ["Approve PlanApproval."];
  if (roleId === "tester") return ["Review merge readiness."];
  return ["Run the next Helm role."];
}
