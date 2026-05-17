const state = {
  snapshot: null,
  selectedId: null,
  filter: "",
  view: "all",
  artifact: "log",
};

const elements = {
  repoPath: document.querySelector("#repo-path"),
  repoBranch: document.querySelector("#repo-branch"),
  repoHead: document.querySelector("#repo-head"),
  repoState: document.querySelector("#repo-state"),
  capturedAt: document.querySelector("#captured-at"),
  metricDirty: document.querySelector("#metric-dirty"),
  metricSessions: document.querySelector("#metric-sessions"),
  metricReview: document.querySelector("#metric-review"),
  metricShip: document.querySelector("#metric-ship"),
  metricPrs: document.querySelector("#metric-prs"),
  navAll: document.querySelector("#nav-all"),
  navReview: document.querySelector("#nav-review"),
  navShip: document.querySelector("#nav-ship"),
  navRepair: document.querySelector("#nav-repair"),
  workflow: document.querySelector("#workflow-strip"),
  refreshButton: document.querySelector("#refresh-button"),
  filter: document.querySelector("#session-filter"),
  list: document.querySelector("#session-list"),
  statusList: document.querySelector("#status-list"),
  detail: document.querySelector("#session-detail"),
  viewButtons: Array.from(document.querySelectorAll("[data-view]")),
  artifactTabs: Array.from(document.querySelectorAll("[data-artifact]")),
};

elements.refreshButton.addEventListener("click", () => {
  loadOverview();
});

elements.filter.addEventListener("input", (event) => {
  state.filter = event.target.value.toLowerCase().trim();
  render();
});

for (const button of elements.viewButtons) {
  button.addEventListener("click", () => {
    state.view = button.dataset.view ?? "all";
    state.selectedId = null;
    render();
  });
}

for (const tab of elements.artifactTabs) {
  tab.addEventListener("click", () => {
    state.artifact = tab.dataset.artifact ?? "log";
    render();
  });
}

loadOverview();

async function loadOverview() {
  elements.refreshButton.disabled = true;

  try {
    const response = await fetch("/api/overview", { cache: "no-store" });

    if (!response.ok) {
      throw new Error(`overview request failed: ${response.status}`);
    }

    state.snapshot = await response.json();
    state.selectedId = state.selectedId ?? filteredSessions()[0]?.id ?? null;
    render();
  } finally {
    elements.refreshButton.disabled = false;
  }
}

function render() {
  if (!state.snapshot) {
    return;
  }

  renderShell();
  renderWorkflow();
  renderStatusList();
  renderSessions();
}

function renderShell() {
  const { repo, totals } = state.snapshot;
  const repairCount = state.snapshot.sessions.filter((session) => session.nextAction.key === "repair").length;

  elements.repoPath.textContent = repo.path;
  elements.repoBranch.textContent = repo.branch;
  elements.repoHead.textContent = repo.head ?? "-";
  elements.repoState.textContent = repo.dirtyCount === 0 ? "clean" : `${repo.dirtyCount} changed`;
  elements.capturedAt.textContent = formatDateTime(repo.capturedAt);
  elements.metricDirty.textContent = repo.dirtyCount;
  elements.metricSessions.textContent = totals.sessions;
  elements.metricReview.textContent = totals.needsReview;
  elements.metricShip.textContent = totals.readyToShip;
  elements.metricPrs.textContent = totals.withPullRequest;
  elements.navAll.textContent = totals.sessions;
  elements.navReview.textContent = totals.needsReview;
  elements.navShip.textContent = totals.readyToShip;
  elements.navRepair.textContent = repairCount;

  for (const button of elements.viewButtons) {
    button.classList.toggle("active", button.dataset.view === state.view);
  }

  for (const tab of elements.artifactTabs) {
    tab.classList.toggle("active", tab.dataset.artifact === state.artifact);
  }
}

function renderWorkflow() {
  elements.workflow.replaceChildren(
    ...state.snapshot.workflow.map((step, index) => {
      const item = document.createElement("div");
      item.className = `workflow-step ${step.tone}`;

      const number = document.createElement("span");
      number.className = "workflow-index";
      number.textContent = String(index + 1).padStart(2, "0");

      const label = document.createElement("span");
      label.textContent = step.label;

      const count = document.createElement("strong");
      count.textContent = step.count;

      item.append(number, label, count);
      return item;
    }),
  );
}

function renderStatusList() {
  const rows = state.snapshot.repo.status;

  if (rows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "clean";
    elements.statusList.replaceChildren(empty);
    return;
  }

  elements.statusList.replaceChildren(
    ...rows.slice(0, 8).map((entry) => {
      const row = document.createElement("div");
      row.className = "status-row";

      const code = document.createElement("span");
      code.className = "status-code";
      code.textContent = entry.code;

      const path = document.createElement("strong");
      path.textContent = entry.path;

      row.append(code, path);
      return row;
    }),
  );
}

function renderSessions() {
  const sessions = filteredSessions();

  elements.list.replaceChildren(...sessions.map(renderSessionBlock));

  if (sessions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "empty";
    elements.list.replaceChildren(empty);
  }

  const selected = sessions.find((session) => session.id === state.selectedId) ?? sessions[0] ?? null;
  state.selectedId = selected?.id ?? null;
  renderDetail(selected);
}

function filteredSessions() {
  if (!state.snapshot) {
    return [];
  }

  return state.snapshot.sessions
    .filter((session) => state.view === "all" || session.nextAction.key === state.view)
    .filter((session) => {
      if (!state.filter) {
        return true;
      }

      return [
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
        .toLowerCase()
        .includes(state.filter);
    });
}

function renderSessionBlock(session) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `session-block ${session.nextAction.tone}`;

  if (session.id === state.selectedId) {
    button.classList.add("selected");
  }

  button.addEventListener("click", () => {
    state.selectedId = session.id;
    render();
  });

  const top = document.createElement("div");
  top.className = "block-top";

  const prompt = document.createElement("strong");
  prompt.className = "block-prompt";
  prompt.textContent = session.prompt;

  const action = document.createElement("span");
  action.className = `pill ${session.nextAction.tone}`;
  action.textContent = session.nextAction.label;

  top.append(prompt, action);

  const meta = document.createElement("div");
  meta.className = "block-meta";
  meta.append(
    pill(session.agent, "agent"),
    pill(session.status, statusTone(session)),
    pill(formatDateTime(session.updatedAt)),
  );

  if (session.commitHash) {
    meta.append(pill(session.commitHash, "mono"));
  }

  if (session.pullRequest.url) {
    meta.append(pill("PR", "accent"));
  }

  const files = document.createElement("div");
  files.className = "file-strip";
  files.textContent =
    session.changedFiles.length === 0
      ? "no changed files"
      : session.changedFiles.slice(0, 4).join(" / ");

  const preview = document.createElement("pre");
  preview.className = "block-preview";
  preview.textContent = previewOutput(session);

  button.append(top, meta, files, preview);
  return button;
}

function renderDetail(session) {
  if (!session) {
    elements.detail.className = "detail-empty";
    elements.detail.textContent = "-";
    return;
  }

  elements.detail.className = "detail-body";
  elements.detail.replaceChildren(
    summaryBlock(session),
    fieldGrid([
      ["id", session.id],
      ["agent", session.agent],
      ["branch", session.branch],
      ["head", session.head],
      ["exit", session.exitCode ?? "-"],
      ["commit", session.commitHash ?? "-"],
      ["check", formatCheck(session)],
      ["pr", session.pullRequest.url ?? "-"],
    ]),
    fileList(session),
    artifactPreview(session),
  );
}

function summaryBlock(session) {
  const wrapper = document.createElement("section");
  wrapper.className = "detail-summary";

  const action = document.createElement("span");
  action.className = `pill ${session.nextAction.tone}`;
  action.textContent = session.nextAction.label;

  const title = document.createElement("h3");
  title.textContent = session.prompt;

  const meta = document.createElement("p");
  meta.textContent = `${session.status} / ${formatDateTime(session.updatedAt)}`;

  wrapper.append(action, title, meta);
  return wrapper;
}

function fieldGrid(rows) {
  const list = document.createElement("dl");
  list.className = "field-grid";

  for (const [label, value] of rows) {
    const group = document.createElement("div");
    const term = document.createElement("dt");
    const detail = document.createElement("dd");
    term.textContent = label;

    if (label === "pr" && typeof value === "string" && value.startsWith("http")) {
      const link = document.createElement("a");
      link.href = value;
      link.textContent = value;
      link.rel = "noreferrer";
      detail.append(link);
    } else {
      detail.textContent = String(value);
    }

    group.append(term, detail);
    list.append(group);
  }

  return list;
}

function fileList(session) {
  const wrapper = document.createElement("section");
  wrapper.className = "changed-files";
  const heading = document.createElement("h3");
  heading.textContent = "Files";
  const list = document.createElement("ul");

  if (session.changedFiles.length === 0) {
    list.append(listItem("-"));
  } else {
    list.append(...session.changedFiles.map(listItem));
  }

  wrapper.append(heading, list);
  return wrapper;
}

function artifactPreview(session) {
  const pre = document.createElement("pre");
  pre.className = "artifact-preview";
  pre.textContent =
    state.artifact === "diff"
      ? session.artifacts.diffPreview || "-"
      : session.artifacts.logPreview || "-";
  return pre;
}

function listItem(text) {
  const item = document.createElement("li");
  item.textContent = text;
  return item;
}

function pill(text, className = "") {
  const element = document.createElement("span");
  element.className = `pill ${className}`.trim();
  element.textContent = text;
  return element;
}

function statusTone(session) {
  if (session.status === "failed" || session.exitCode > 0) {
    return "error";
  }

  if (session.status === "completed" || session.status === "committed") {
    return "ok";
  }

  if (session.status === "running") {
    return "accent";
  }

  return "muted";
}

function previewOutput(session) {
  const source = session.artifacts.diffPreview || session.artifacts.logPreview || session.prompt;
  return source.split("\n").slice(0, 7).join("\n");
}

function formatCheck(session) {
  if (!session.check.command) {
    return "-";
  }

  return `${session.check.command} / exit ${session.check.exitCode ?? "?"}`;
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}
