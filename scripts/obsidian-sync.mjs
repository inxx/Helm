#!/usr/bin/env node
// Helm 실행 보고서를 Obsidian 세션 노트로 동기화하는 sidecar 워처.
// handoff watcher 와 분리된 소비자(consumer)다. .helm/outbox/reports/ 에 떨어진
// 성공 보고서만 읽어 Obsidian Vault 세션 템플릿으로 변환한다. Helm 실행 코어는
// 이 스크립트의 존재를 모르며, vault 경로가 없거나 변환이 실패해도 handoff 에는
// 영향이 없다.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  watch,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const helmRoot = resolve(here, "..");

const args = parseArgs(process.argv.slice(2));
const VAULT =
  args.vault ?? process.env.HELM_OBSIDIAN_VAULT ?? join(homedir(), "Documents", "Obsidian Vault");
const templatePath = join(VAULT, "templates", "Session-Template.md");
const reportsPath = resolve(args.reports ?? join(helmRoot, ".helm", "outbox", "reports"));
const statePath = resolve(args.state ?? join(helmRoot, ".helm", "outbox", ".obsidian-sync.json"));
const projectsRoot = join(VAULT, "projects");

main().catch((error) => {
  console.error("[obsidian-sync] 치명적 오류:", error);
  process.exit(1);
});

async function main() {
  if (args.help) {
    printUsage();
    return;
  }

  if (!existsSync(templatePath)) {
    console.error(`[obsidian-sync] 세션 템플릿이 없습니다: ${templatePath}`);
    process.exit(1);
  }

  // 단일 파일 모드: handoff 워처의 --on-report 훅이 보고서 경로 하나를 넘겨 호출한다.
  if (args.report) {
    const reportPath = resolve(args.report);
    if (!existsSync(reportPath)) {
      console.error(`[obsidian-sync] 보고서가 없습니다: ${reportPath}`);
      process.exit(1);
    }
    const state = loadState();
    const key = basename(reportPath);
    const prior = state.synced[key];
    if (prior && !prior.baseline && prior.note) {
      console.log(`[obsidian-sync] 이미 변환됨, 건너뜀: ${key}`);
      return;
    }
    syncReport(reportPath, key, state);
    return;
  }

  if (!existsSync(reportsPath)) {
    console.error(`[obsidian-sync] 리포트 경로가 없습니다: ${reportsPath}`);
    process.exit(1);
  }

  const state = loadState();
  const existing = listReports();

  if (args.backfill) {
    // 과거 미변환 리포트까지 전부 변환한다.
    for (const file of existing) {
      if (!state.synced[file]) syncReport(join(reportsPath, file), file, state);
    }
  } else {
    // 기본: 기존 리포트는 baseline(본 것)으로만 기록하고 변환하지 않는다.
    let baselined = 0;
    for (const file of existing) {
      if (!state.synced[file]) {
        state.synced[file] = { note: null, baseline: true };
        baselined += 1;
      }
    }
    if (baselined > 0) {
      saveState(state);
      console.log(`[obsidian-sync] 기존 리포트 ${baselined}건을 baseline 처리(변환 안 함). --backfill 로 과거분 변환 가능.`);
    }
  }

  if (args.once) {
    console.log("[obsidian-sync] --once 완료.");
    return;
  }

  console.log(`[obsidian-sync] 감시 시작: ${reportsPath}`);
  console.log(`[obsidian-sync] Vault: ${projectsRoot}`);

  const debounce = new Map();
  watch(reportsPath, (_event, filename) => {
    if (!filename || !filename.endsWith(".md")) return;
    if (state.synced[filename]) return; // 이미 처리/baseline
    clearTimeout(debounce.get(filename));
    debounce.set(
      filename,
      setTimeout(() => {
        debounce.delete(filename);
        const fresh = loadState();
        if (fresh.synced[filename]) return;
        syncReport(join(reportsPath, filename), filename, fresh);
        saveState(fresh);
      }, 800),
    );
  });
}

function syncReport(reportPath, key, state) {
  if (!existsSync(reportPath)) return;

  let parsed;
  try {
    parsed = parseReport(readFileSync(reportPath, "utf8"));
  } catch (error) {
    console.error(`[obsidian-sync] 파싱 실패 (${key}):`, error.message);
    return;
  }

  const changedFiles = extractChangedFiles(parsed.helmOutput);
  const { project, app } = deriveProjectApp(parsed.repo, changedFiles);
  const date = isoDate(parsed.startedAt);
  const topic = sanitize(parsed.taskId || parsed.title || basename(file, ".md"));
  const status = parsed.exit === "0" ? "완료" : "중단";

  const note = buildNote({ parsed, project, app, date, status, changedFiles, reportPath });

  const sessionsDir = join(projectsRoot, sanitize(project), sanitize(app), "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const notePath = uniquePath(sessionsDir, `${date}-${topic}.md`);

  writeFileSync(notePath, note);
  state.synced[key] = { note: notePath, baseline: false };
  saveState(state);
  console.log(`[obsidian-sync] ${key} → ${notePath}`);
}

function buildNote({ parsed, project, app, date, status, changedFiles, reportPath }) {
  const template = readFileSync(templatePath, "utf8");
  const title = parsed.title || parsed.taskId || "Helm 자동 실행";
  const commits = `Helm Session ${parsed.session ?? "-"} / Run ${parsed.runId ?? "-"}`;

  // 템플릿의 {{placeholder}} 만 치환한다. domain 은 helm 고정, helm-auto 태그 추가.
  const filled = template
    .replace(/\{\{date\}\}/g, date)
    .replace(/\{\{project\}\}/g, project)
    .replace(/\{\{app\}\}/g, app)
    .replace(/\{\{status\}\}/g, status)
    .replace(/\{\{title\}\}/g, title)
    .replace(/\{\{domain\}\}/g, "helm")
    .replace(/tags: \[세션, ([^\]]*)\]/, "tags: [세션, helm-auto, $1]")
    .replace(/\{\{commits\}\}/g, commits);

  // 사실 데이터는 별도 자동생성 섹션에 모은다. 인간 판단 필드(주요 결정 등)는 비워 둔다.
  const summary = trimSummary(parsed.helmOutput);
  const changedBlock = changedFiles.length
    ? changedFiles.map((f) => `- \`${f}\``).join("\n")
    : "- (변경 파일 없음)";

  const autoSection = [
    "",
    "## Helm 실행 요약 (자동 생성)",
    "",
    `- 작업 ID: ${parsed.taskId ?? "-"}`,
    `- Agent: ${parsed.agent ?? "-"}`,
    `- Repo: \`${parsed.repo ?? "-"}\``,
    `- 시작: ${parsed.startedAt ?? "-"}`,
    `- 종료: ${parsed.finishedAt ?? "-"}`,
    `- Exit: ${parsed.exit ?? "-"}`,
    `- Session: ${parsed.session ?? "-"}`,
    `- Run ID: ${parsed.runId ?? "-"}`,
    `- 전체 보고서: \`${reportPath}\``,
    "",
    "### 변경 파일",
    changedBlock,
    "",
    "### 에이전트 완료 보고",
    "```text",
    summary,
    "```",
    "",
  ].join("\n");

  return `${filled.trimEnd()}\n${autoSection}`;
}

// ── 파싱 ────────────────────────────────────────────────────────────────

function parseReport(content) {
  const field = (label) => {
    const m = new RegExp(`^- ${label}: (.*)$`, "m").exec(content);
    return m ? m[1].trim() : null;
  };

  // "## Helm 출력" 다음의 첫 코드펜스 내용을 추출한다.
  const helmOutput = extractSection(content, "## Helm 출력") ?? "";

  return {
    taskId: nullDash(field("작업 ID")),
    title: nullDash(field("제목")),
    agent: nullDash(field("Agent")),
    repo: nullDash(field("Repo")),
    startedAt: nullDash(field("시작")),
    finishedAt: nullDash(field("종료")),
    exit: nullDash(field("Exit")),
    session: nullDash(field("Session")),
    runId: nullDash(field("DB Run ID")),
    helmOutput,
  };
}

function extractSection(content, heading) {
  const idx = content.indexOf(heading);
  if (idx === -1) return null;
  const after = content.slice(idx + heading.length);
  const fence = /```(?:text)?\n([\s\S]*?)\n```/.exec(after);
  return fence ? fence[1] : null;
}

function extractChangedFiles(helmOutput) {
  const idx = helmOutput.indexOf("Changed files:");
  if (idx === -1) return [];
  const lines = helmOutput.slice(idx).split("\n").slice(1);
  const files = [];
  for (const line of lines) {
    const m = /^- (.+)$/.exec(line.trim());
    if (!m) break; // 목록은 연속된 "- " 줄로 끝난다.
    files.push(m[1].trim());
  }
  return files;
}

function trimSummary(helmOutput) {
  // 에이전트 완료 보고만 남긴다. handoff 가 덧붙인 "Session:" 줄 이후는 잘라낸다.
  const cut = helmOutput.search(/^Session: /m);
  const body = (cut === -1 ? helmOutput : helmOutput.slice(0, cut)).trim();
  const MAX = 4000;
  return body.length > MAX ? `${body.slice(0, MAX)}\n…(생략, 전체 보고서 참조)` : body || "(empty)";
}

// ── project/app 추론 ────────────────────────────────────────────────────

function deriveProjectApp(repoPath, changedFiles) {
  if (!repoPath) return { project: "unknown", app: "전체" };
  const joined = changedFiles.join("\n");

  if (repoPath.includes("/nova-frontend")) {
    const m = /apps\/(admin-bo|admin-po)\//.exec(joined);
    return { project: "nova-frontend", app: m ? m[1] : "전체" };
  }
  if (repoPath.includes("/zelda")) {
    if (/(^|\/)coco\//.test(joined)) return { project: "zelda", app: "coco" };
    if (/noah\//.test(joined)) return { project: "zelda", app: "noah" };
    return { project: "zelda", app: "전체" };
  }
  return { project: basename(repoPath), app: "전체" };
}

// ── 상태/유틸 ───────────────────────────────────────────────────────────

function loadState() {
  if (existsSync(statePath)) {
    try {
      return JSON.parse(readFileSync(statePath, "utf8"));
    } catch {
      console.warn("[obsidian-sync] 상태 파일 손상, 새로 시작합니다.");
    }
  }
  return { synced: {} };
}

function saveState(state) {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function listReports() {
  return readdirSync(reportsPath)
    .filter((f) => f.endsWith(".md"))
    .sort();
}

function isoDate(value) {
  // value 예: "2026-06-16T01:05:48.487Z" → "2026-06-16"
  const m = /(\d{4}-\d{2}-\d{2})/.exec(value ?? "");
  return m ? m[1] : "0000-00-00";
}

function sanitize(value) {
  return String(value).replace(/[^\w가-힣.-]+/g, "-").replace(/^-+|-+$/g, "") || "untitled";
}

function nullDash(value) {
  return value === "-" ? null : value;
}

function uniquePath(directory, name) {
  const ext = extname(name);
  const base = basename(name, ext);
  let candidate = join(directory, name);
  let suffix = 1;
  while (existsSync(candidate)) {
    candidate = join(directory, `${base}-${suffix}${ext}`);
    suffix += 1;
  }
  return candidate;
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--once") parsed.once = true;
    else if (arg === "--backfill") parsed.backfill = true;
    else if (arg === "--report") parsed.report = argv[++i];
    else if (arg?.startsWith("--report=")) parsed.report = arg.slice("--report=".length);
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--reports") parsed.reports = argv[++i];
    else if (arg?.startsWith("--reports=")) parsed.reports = arg.slice("--reports=".length);
    else if (arg === "--state") parsed.state = argv[++i];
    else if (arg?.startsWith("--state=")) parsed.state = arg.slice("--state=".length);
    else if (arg === "--vault") parsed.vault = argv[++i];
    else if (arg?.startsWith("--vault=")) parsed.vault = arg.slice("--vault=".length);
  }
  return parsed;
}

function printUsage() {
  console.log(`Helm → Obsidian 세션 노트 동기화 워처

사용법:
  node scripts/obsidian-sync.mjs [옵션]

옵션:
  --report <path>     보고서 한 건만 변환하고 종료 (handoff --on-report 훅용)
  --once              기존 미변환 리포트만 처리하고 종료(감시 안 함)
  --backfill          기존 리포트를 baseline 처리하지 않고 전부 변환
  --reports <path>    리포트 디렉토리 (기본 .helm/outbox/reports)
  --state <path>      동기화 상태 파일 (기본 .helm/outbox/.obsidian-sync.json)
  -h, --help          도움말

동작:
  성공 리포트를 Obsidian 세션 템플릿으로 변환해
  Vault/projects/{프로젝트}/{앱}/sessions/YYYY-MM-DD-{주제}.md 에 저장한다.
  상태 파일로 멱등성을 보장하며, 기본 실행은 신규 리포트만 변환한다.`);
}
