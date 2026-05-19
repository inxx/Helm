/* ============================================================
   Helm UI — view router + per-view renderers
   ============================================================ */

const state = {
  snapshot: null,
  route: "tasks",
  selectedId: null,
  filter: "",
  view: "all",
  artifact: "log",
  settingsSection: "repository",
};

const VIEW_META = {
  tasks: { title: "태스크", subtitle: "Agent Runs" },
  git: { title: "깃", subtitle: "Read-only viewer" },
  terminal: { title: "터미널", subtitle: "Phase 1 skeleton" },
  settings: { title: "설정", subtitle: ".helm/config.json" },
};

const BOARD_COLUMNS = [
  { key: "review", label: "검토", tone: "warn" },
  { key: "ship", label: "출시", tone: "ok" },
  { key: "running", label: "실행중", tone: "accent" },
  { key: "opened", label: "PR 열림", tone: "accent" },
  { key: "repair", label: "수리", tone: "error" },
  { key: "closed", label: "완료", tone: "muted" },
];

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const refs = {
  refreshButton: $("#refresh-button"),
  navItems: $$("[data-route]"),
  views: {
    tasks: $("#view-tasks"),
    git: $("#view-git"),
    terminal: $("#view-terminal"),
    settings: $("#view-settings"),
  },
  viewTitle: $("#view-title"),
  viewSubtitle: $("#view-subtitle"),
  repoPath: $("#repo-path"),

  // Rail repo
  railBranch: $("#rail-branch"),
  railHead: $("#rail-head"),
  railState: $("#rail-state"),

  // Nav counts
  navTasks: $("#nav-tasks-count"),
  navGit: $("#nav-git-count"),
  navTerminal: $("#nav-terminal-count"),

  // Tasks toolbar
  chips: $$("[data-view]"),
  chipAll: $("#chip-all"),
  chipReview: $("#chip-review"),
  chipShip: $("#chip-ship"),
  chipRepair: $("#chip-repair"),
  filter: $("#session-filter"),
  workflow: $("#workflow-strip"),

  // Tasks board
  board: $("#board-columns"),
  detailTitle: $("#detail-title"),
  detailMeta: $("#detail-meta"),
  detailBody: $("#detail-body"),
  artifactTabs: $$("[data-artifact]"),

  // Git view
  gitBranch: $("#git-branch"),
  gitHead: $("#git-head"),
  gitState: $("#git-state"),
  gitStateWrap: $("#git-state-wrap"),
  gitCaptured: $("#git-captured"),
  gitChangesCount: $("#git-changes-count"),
  gitChangesList: $("#git-changes-list"),
  gitCommitsCount: $("#git-commits-count"),
  gitCommitsList: $("#git-commits-list"),

  // Terminal
  terminalStatus: $("#terminal-status-output"),

  // Settings
  settingsNav: $$("[data-section]:not(section)"),
  settingsSections: $$("section[data-section]"),
  settingsRepoPath: $("#settings-repo-path"),
  settingsBranch: $("#settings-branch"),
  settingsHead: $("#settings-head"),
  settingsDirty: $("#settings-dirty"),
};

bindEvents();
loadOverview();

function bindEvents() {
  refs.refreshButton.addEventListener("click", loadOverview);

  for (const button of refs.navItems) {
    button.addEventListener("click", () => switchRoute(button.dataset.route));
  }

  for (const chip of refs.chips) {
    chip.addEventListener("click", () => {
      state.view = chip.dataset.view ?? "all";
      state.selectedId = null;
      render();
    });
  }

  refs.filter.addEventListener("input", (event) => {
    state.filter = event.target.value.toLowerCase().trim();
    render();
  });

  for (const tab of refs.artifactTabs) {
    tab.addEventListener("click", () => {
      state.artifact = tab.dataset.artifact ?? "log";
      render();
    });
  }

  for (const navItem of refs.settingsNav) {
    navItem.addEventListener("click", () => {
      state.settingsSection = navItem.dataset.section;
      renderSettingsRouting();
    });
  }

  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      refs.filter.focus();
    }
  });
}

function switchRoute(route) {
  if (!VIEW_META[route]) {
    return;
  }

  state.route = route;

  for (const button of refs.navItems) {
    button.classList.toggle("active", button.dataset.route === route);
  }

  for (const [key, element] of Object.entries(refs.views)) {
    element.classList.toggle("visible", key === route);
  }

  const meta = VIEW_META[route];
  refs.viewTitle.textContent = meta.title;
  refs.viewSubtitle.textContent = meta.subtitle;

  render();
}

async function loadOverview() {
  refs.refreshButton.disabled = true;

  try {
    const response = await fetch("/api/overview", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`overview request failed: ${response.status}`);
    }
    state.snapshot = await response.json();

    if (!state.selectedId) {
      state.selectedId = filteredSessions()[0]?.id ?? null;
    }

    render();
  } finally {
    refs.refreshButton.disabled = false;
  }
}

function render() {
  if (!state.snapshot) {
    return;
  }

  renderShell();

  switch (state.route) {
    case "tasks":
      renderTasks();
      break;
    case "git":
      renderGit();
      break;
    case "terminal":
      renderTerminal();
      break;
    case "settings":
      renderSettings();
      break;
  }
}

/* ============================================================
   Shell — rail + topbar + nav counts
   ============================================================ */

function renderShell() {
  const { repo, totals, sessions } = state.snapshot;
  const repairCount = sessions.filter((s) => s.nextAction.key === "repair").length;

  refs.repoPath.textContent = repo.path;
  refs.repoPath.title = repo.path;
  refs.railBranch.textContent = repo.branch || "—";
  refs.railHead.textContent = repo.head ?? "—";

  const isClean = repo.dirtyCount === 0;
  refs.railState.textContent = isClean ? "clean" : `${repo.dirtyCount} changed`;
  refs.railState.classList.toggle("state-clean", isClean);
  refs.railState.classList.toggle("state-dirty", !isClean);

  refs.navTasks.textContent = totals.sessions;
  refs.navGit.textContent = repo.dirtyCount;
  refs.navTerminal.textContent = totals.running;

  refs.chipAll.textContent = totals.sessions;
  refs.chipReview.textContent = totals.needsReview;
  refs.chipShip.textContent = totals.readyToShip;
  refs.chipRepair.textContent = repairCount;

  for (const chip of refs.chips) {
    chip.classList.toggle("active", chip.dataset.view === state.view);
  }

  for (const tab of refs.artifactTabs) {
    tab.classList.toggle("active", tab.dataset.artifact === state.artifact);
  }
}

/* ============================================================
   Tasks view
   ============================================================ */

function renderTasks() {
  renderWorkflowStrip();
  renderBoard();
}

function renderWorkflowStrip() {
  refs.workflow.replaceChildren(
    ...state.snapshot.workflow.map((step, index) => {
      const item = document.createElement("div");
      item.className = `workflow-step ${step.tone}`;

      const idx = document.createElement("span");
      idx.className = "workflow-index";
      idx.textContent = String(index + 1).padStart(2, "0");

      const label = document.createElement("span");
      label.className = "workflow-label";
      label.textContent = step.label;

      const count = document.createElement("span");
      count.className = "workflow-count";
      count.textContent = step.count;

      item.append(idx, label, count);
      return item;
    }),
  );
}

function renderBoard() {
  const sessions = filteredSessions();

  const grouped = new Map(BOARD_COLUMNS.map((col) => [col.key, []]));
  for (const session of sessions) {
    const key = grouped.has(session.nextAction.key) ? session.nextAction.key : "closed";
    grouped.get(key).push(session);
  }

  refs.board.replaceChildren(
    ...BOARD_COLUMNS.map((column) => buildColumn(column, grouped.get(column.key) ?? [])),
  );

  const selected = sessions.find((session) => session.id === state.selectedId) ?? sessions[0] ?? null;
  state.selectedId = selected?.id ?? null;
  renderDetail(selected);
}

function buildColumn(column, items) {
  const wrapper = document.createElement("section");
  wrapper.className = "board-column";

  const head = document.createElement("div");
  head.className = "board-column-head";

  const name = document.createElement("div");
  name.className = "name";

  const dot = document.createElement("span");
  dot.className = `dot ${column.tone}`;

  const label = document.createElement("span");
  label.textContent = column.label;

  const count = document.createElement("span");
  count.className = "count";
  count.textContent = items.length;

  name.append(dot, label, count);
  head.append(name);

  const body = document.createElement("div");
  body.className = "board-column-body";

  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.style.minHeight = "92px";
    empty.textContent = "비어있음";
    body.append(empty);
  } else {
    body.append(...items.map((session) => buildTaskCard(session)));
  }

  wrapper.append(head, body);
  return wrapper;
}

function buildTaskCard(session) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "task-card";

  if (session.id === state.selectedId) {
    card.classList.add("selected");
  }

  card.addEventListener("click", () => {
    state.selectedId = session.id;
    render();
  });

  const prompt = document.createElement("p");
  prompt.className = "card-prompt";
  prompt.textContent = session.prompt;

  const meta = document.createElement("div");
  meta.className = "card-meta";
  meta.append(
    pill(session.agent, "agent"),
    pill(session.nextAction.label, `tone-${session.nextAction.tone}`),
  );
  if (session.commitHash) {
    meta.append(pill(session.commitHash.slice(0, 7), "mono"));
  }
  if (session.pullRequest.url) {
    meta.append(pill("PR", "tone-accent"));
  }

  const footer = document.createElement("div");
  footer.className = "card-footer";

  const files = document.createElement("span");
  files.className = "files";
  files.textContent = session.changedFiles.length
    ? `${session.changedFiles.length}개 파일 · ${session.changedFiles[0]}`
    : "변경 없음";

  const time = document.createElement("span");
  time.className = "time";
  time.textContent = formatDateTime(session.updatedAt);

  footer.append(files, time);

  card.append(prompt, meta, footer);
  return card;
}

function renderDetail(session) {
  if (!session) {
    refs.detailTitle.textContent = "세션을 선택하세요";
    refs.detailMeta.replaceChildren();
    refs.detailBody.replaceChildren(
      emptyState("선택된 세션 없음", "왼쪽 보드에서 카드를 선택하면 상세가 표시됩니다."),
    );
    return;
  }

  refs.detailTitle.textContent = session.prompt;

  const meta = [
    pill(session.agent, "agent"),
    pill(session.nextAction.label, `tone-${session.nextAction.tone}`),
    pill(session.status, `tone-${statusTone(session)}`),
    pill(formatDateTime(session.updatedAt), "tone-muted"),
  ];
  refs.detailMeta.replaceChildren(...meta);

  const fields = fieldGrid([
    ["id", session.id],
    ["agent", session.agent],
    ["branch", session.branch],
    ["head", session.head ?? "—"],
    ["exit", session.exitCode ?? "—"],
    ["commit", session.commitHash ?? "—"],
    ["check", formatCheck(session)],
    ["pr", session.pullRequest.url ?? "—"],
  ]);

  const filesSection = document.createElement("section");
  filesSection.className = "detail-section";
  const filesHeading = document.createElement("h3");
  filesHeading.textContent = `Files (${session.changedFiles.length})`;
  const filesList = document.createElement("ul");
  filesList.className = "detail-files";
  if (session.changedFiles.length === 0) {
    const li = document.createElement("li");
    li.textContent = "— 변경 없음 —";
    filesList.append(li);
  } else {
    for (const path of session.changedFiles) {
      const li = document.createElement("li");
      const code = document.createElement("span");
      code.className = "status-code";
      code.textContent = "M";
      const value = document.createElement("span");
      value.textContent = path;
      li.append(code, value);
      filesList.append(li);
    }
  }
  filesSection.append(filesHeading, filesList);

  const artifactSection = document.createElement("section");
  artifactSection.className = "detail-section";
  const artifactHeading = document.createElement("h3");
  artifactHeading.textContent = state.artifact === "diff" ? "Diff Preview" : "Log Preview";
  const pre = document.createElement("pre");
  pre.className = "artifact-preview";
  pre.textContent =
    state.artifact === "diff"
      ? session.artifacts.diffPreview || "— diff 없음 —"
      : session.artifacts.logPreview || "— log 없음 —";
  artifactSection.append(artifactHeading, pre);

  refs.detailBody.replaceChildren(
    sectionWithHeader("Meta", fields),
    filesSection,
    artifactSection,
  );
}

function sectionWithHeader(title, body) {
  const section = document.createElement("section");
  section.className = "detail-section";
  const heading = document.createElement("h3");
  heading.textContent = title;
  section.append(heading, body);
  return section;
}

function fieldGrid(rows) {
  const list = document.createElement("dl");
  list.className = "kv-grid";

  for (const [label, value] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = label;

    const dd = document.createElement("dd");
    if (label === "pr" && typeof value === "string" && value.startsWith("http")) {
      const link = document.createElement("a");
      link.href = value;
      link.textContent = value;
      link.target = "_blank";
      link.rel = "noreferrer";
      dd.append(link);
    } else {
      dd.textContent = String(value);
    }

    list.append(dt, dd);
  }

  return list;
}

/* ============================================================
   Git view — read-only viewer
   ============================================================ */

function renderGit() {
  const { repo, sessions } = state.snapshot;
  refs.gitBranch.textContent = repo.branch || "—";
  refs.gitHead.textContent = repo.head ?? "—";

  const isClean = repo.dirtyCount === 0;
  refs.gitState.textContent = isClean ? "clean" : `${repo.dirtyCount} changed`;
  refs.gitStateWrap.classList.toggle("state-clean", isClean);
  refs.gitStateWrap.classList.toggle("state-dirty", !isClean);

  refs.gitCaptured.textContent = formatDateTime(repo.capturedAt);

  // Changes list
  refs.gitChangesCount.textContent = repo.status.length;

  if (repo.status.length === 0) {
    refs.gitChangesList.replaceChildren(
      emptyState("작업 트리 깨끗", "변경된 파일이 없습니다."),
    );
  } else {
    refs.gitChangesList.replaceChildren(
      ...repo.status.map((entry) => {
        const row = document.createElement("div");
        row.className = "change-row";

        const code = document.createElement("span");
        const trimmed = (entry.code ?? "").trim();
        code.className = `change-code ${codeClass(trimmed)}`;
        code.textContent = trimmed || "·";

        const path = document.createElement("span");
        path.className = "change-path";
        path.textContent = entry.path;
        path.title = entry.path;

        row.append(code, path);
        return row;
      }),
    );
  }

  // Commit timeline — sessions가 가진 commitHash를 기반으로 latest activity 표시
  const commitSessions = sessions.filter((s) => s.commitHash).slice(0, 20);
  refs.gitCommitsCount.textContent = commitSessions.length;

  if (commitSessions.length === 0) {
    refs.gitCommitsList.replaceChildren(
      emptyState("커밋 없음", "세션 기반 커밋 기록이 비어 있습니다."),
    );
  } else {
    refs.gitCommitsList.replaceChildren(
      ...commitSessions.map((session) => {
        const row = document.createElement("div");
        row.className = "commit-row";

        const hash = document.createElement("span");
        hash.className = "commit-hash";
        hash.textContent = session.commitHash.slice(0, 7);

        const subject = document.createElement("span");
        subject.className = "commit-subject";
        subject.textContent = session.prompt;
        subject.title = session.prompt;

        const meta = document.createElement("span");
        meta.className = "commit-meta";
        meta.append(
          pill(session.agent, "agent"),
          document.createTextNode(formatDateTime(session.updatedAt)),
        );

        row.append(hash, subject, meta);
        return row;
      }),
    );
  }
}

function codeClass(code) {
  if (!code) return "";
  if (code.includes("A") || code.includes("?")) return "added";
  if (code.includes("D")) return "deleted";
  if (code.includes("M") || code.includes("R")) return "modified";
  return "";
}

/* ============================================================
   Terminal view — fill the "inxx-helm status" stub block
   ============================================================ */

function renderTerminal() {
  const { repo, totals } = state.snapshot;

  const lines = [
    `repo     ${repo.path}`,
    `branch   ${repo.branch || "—"}`,
    `head     ${repo.head ?? "—"}`,
    `state    ${repo.dirtyCount === 0 ? "clean" : `${repo.dirtyCount} changed`}`,
    "",
    `sessions ${totals.sessions} (running ${totals.running}, completed ${totals.completed}, failed ${totals.failed})`,
    `review   ${totals.needsReview}    ship ${totals.readyToShip}    PR ${totals.withPullRequest}`,
  ];

  refs.terminalStatus.textContent = lines.join("\n");
}

/* ============================================================
   Settings view
   ============================================================ */

function renderSettings() {
  const { repo } = state.snapshot;

  refs.settingsRepoPath.textContent = repo.path;
  refs.settingsBranch.textContent = repo.branch || "—";
  refs.settingsHead.textContent = repo.head ?? "—";
  refs.settingsDirty.textContent =
    repo.dirtyCount === 0 ? "clean" : `${repo.dirtyCount} file(s) changed`;

  renderSettingsRouting();
}

function renderSettingsRouting() {
  for (const item of refs.settingsNav) {
    item.classList.toggle("active", item.dataset.section === state.settingsSection);
  }
  for (const section of refs.settingsSections) {
    section.hidden = section.dataset.section !== state.settingsSection;
  }
}

/* ============================================================
   Helpers
   ============================================================ */

function filteredSessions() {
  if (!state.snapshot) {
    return [];
  }

  return state.snapshot.sessions
    .filter((session) => state.view === "all" || session.nextAction.key === state.view)
    .filter((session) => {
      if (!state.filter) return true;
      const haystack = [
        session.id,
        session.status,
        session.agent,
        session.prompt,
        session.branch,
        session.commitHash,
        session.nextAction.label,
        session.pullRequest.title,
        session.pullRequest.url,
        session.changedFiles.join(" "),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(state.filter);
    });
}

function statusTone(session) {
  if (session.status === "failed" || (typeof session.exitCode === "number" && session.exitCode > 0)) {
    return "error";
  }
  if (session.status === "completed" || session.status === "committed") return "ok";
  if (session.status === "running") return "accent";
  return "muted";
}

function formatCheck(session) {
  if (!session.check.command) return "—";
  return `${session.check.command} · exit ${session.check.exitCode ?? "?"}`;
}

function pill(text, className = "") {
  const element = document.createElement("span");
  element.className = `pill ${className}`.trim();
  element.textContent = text;
  return element;
}

function emptyState(title, body) {
  const wrap = document.createElement("div");
  wrap.className = "empty-state";

  const strong = document.createElement("strong");
  strong.textContent = title;

  const span = document.createElement("span");
  span.textContent = body;

  wrap.append(strong, span);
  return wrap;
}

function formatDateTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
