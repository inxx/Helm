const state = {
  snapshot: null,
  selectedId: null,
  filter: "",
};

const elements = {
  repoPath: document.querySelector("#repo-path"),
  repoBranch: document.querySelector("#repo-branch"),
  repoDirty: document.querySelector("#repo-dirty"),
  metricSessions: document.querySelector("#metric-sessions"),
  metricCommitted: document.querySelector("#metric-committed"),
  metricFailed: document.querySelector("#metric-failed"),
  metricPrs: document.querySelector("#metric-prs"),
  refreshButton: document.querySelector("#refresh-button"),
  filter: document.querySelector("#session-filter"),
  list: document.querySelector("#session-list"),
  detail: document.querySelector("#session-detail"),
};

elements.refreshButton.addEventListener("click", () => {
  loadOverview();
});

elements.filter.addEventListener("input", (event) => {
  state.filter = event.target.value.toLowerCase().trim();
  render();
});

loadOverview();

async function loadOverview() {
  const response = await fetch("/api/overview", { cache: "no-store" });

  if (!response.ok) {
    throw new Error(`overview request failed: ${response.status}`);
  }

  state.snapshot = await response.json();
  state.selectedId = state.selectedId ?? state.snapshot.sessions[0]?.id ?? null;
  render();
}

function render() {
  if (!state.snapshot) {
    return;
  }

  const { repo, totals } = state.snapshot;

  elements.repoPath.textContent = repo.path;
  elements.repoBranch.textContent = repo.branch;
  elements.repoDirty.textContent = repo.dirtyCount === 0 ? "clean" : `${repo.dirtyCount} changed`;
  elements.metricSessions.textContent = totals.sessions;
  elements.metricCommitted.textContent = totals.committed;
  elements.metricFailed.textContent = totals.failed;
  elements.metricPrs.textContent = totals.withPullRequest;

  const sessions = filteredSessions();
  elements.list.replaceChildren(...sessions.map(renderSessionBlock));

  if (sessions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "표시할 세션이 없습니다.";
    elements.list.replaceChildren(empty);
  }

  const selected = sessions.find((session) => session.id === state.selectedId) ?? sessions[0] ?? null;
  state.selectedId = selected?.id ?? null;
  renderDetail(selected);
}

function filteredSessions() {
  const sessions = state.snapshot.sessions;

  if (!state.filter) {
    return sessions;
  }

  return sessions.filter((session) =>
    [
      session.id,
      session.status,
      session.agent,
      session.prompt,
      session.branch,
      session.commitHash,
      session.pullRequest.title,
      session.pullRequest.url,
      session.changedFiles.join(" "),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(state.filter),
  );
}

function renderSessionBlock(session) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `session-block ${session.status}`;

  if (session.id === state.selectedId) {
    button.classList.add("selected");
  }

  button.addEventListener("click", () => {
    state.selectedId = session.id;
    render();
  });

  const head = document.createElement("div");
  head.className = "block-head";

  const title = document.createElement("div");
  title.className = "block-title";

  const command = document.createElement("p");
  command.className = "block-command";
  command.textContent = session.prompt;

  const meta = document.createElement("div");
  meta.className = "block-meta";
  meta.append(
    pill(session.agent, "agent"),
    pill(session.status, statusClass(session)),
    pill(formatTime(session.updatedAt)),
  );

  if (session.commitHash) {
    meta.append(pill(session.commitHash));
  }

  if (session.pullRequest.url) {
    meta.append(pill("PR", "ok"));
  }

  title.append(command, meta);

  const exit = document.createElement("span");
  exit.className = `pill ${statusClass(session)}`;
  exit.textContent = session.exitCode === null ? "-" : `exit ${session.exitCode}`;

  head.append(title, exit);

  const output = document.createElement("pre");
  output.className = "block-output";
  output.textContent = previewOutput(session);

  button.append(head, output);
  return button;
}

function renderDetail(session) {
  if (!session) {
    elements.detail.className = "detail-empty";
    elements.detail.textContent = "세션을 선택하세요.";
    return;
  }

  elements.detail.className = "detail-body";
  elements.detail.replaceChildren(
    section("Session", [
      kv("id", session.id),
      kv("status", session.status),
      kv("agent", session.agent),
      kv("branch", session.branch),
      kv("head", session.head),
      kv("commit", session.commitHash ?? "-"),
    ]),
    section("Check", [
      kv("command", session.check.command ?? "-"),
      kv("exit", session.check.exitCode ?? "-"),
      kv("log", session.check.logPath ?? "-"),
    ]),
    section("Pull request", [
      kv("title", session.pullRequest.title ?? "-"),
      kv("base", session.pullRequest.base ?? "-"),
      kv("draft", formatDraft(session.pullRequest.draft)),
      kv("url", session.pullRequest.url ?? "-"),
    ]),
    section("Files", session.changedFiles.length > 0 ? session.changedFiles.map((file) => item(file)) : [item("-")]),
    preSection("Log", session.artifacts.logPreview || "-"),
    preSection("Diff", session.artifacts.diffPreview || "-"),
  );
}

function section(title, rows) {
  const wrapper = document.createElement("section");
  wrapper.className = "detail-section";
  const heading = document.createElement("h3");
  heading.textContent = title;
  const list = document.createElement("ul");
  list.className = "detail-list";
  list.append(...rows);
  wrapper.append(heading, list);
  return wrapper;
}

function preSection(title, text) {
  const wrapper = document.createElement("section");
  wrapper.className = "detail-section";
  const heading = document.createElement("h3");
  heading.textContent = title;
  const pre = document.createElement("pre");
  pre.className = "detail-pre";
  pre.textContent = text;
  wrapper.append(heading, pre);
  return wrapper;
}

function kv(label, value) {
  const row = document.createElement("li");
  row.className = "kv-row";
  const key = document.createElement("span");
  key.textContent = label;
  const val = document.createElement("strong");
  val.textContent = String(value);
  row.append(key, val);
  return row;
}

function item(value) {
  const row = document.createElement("li");
  row.textContent = value;
  return row;
}

function pill(text, className = "") {
  const element = document.createElement("span");
  element.className = `pill ${className}`.trim();
  element.textContent = text;
  return element;
}

function statusClass(session) {
  if (session.status === "failed" || session.exitCode > 0) {
    return "error";
  }

  if (session.status === "completed") {
    return "ok";
  }

  return "";
}

function previewOutput(session) {
  const source = session.artifacts.logPreview || session.artifacts.diffPreview || session.prompt;
  return source.split("\n").slice(0, 10).join("\n");
}

function formatTime(value) {
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

function formatDraft(value) {
  if (value === null) {
    return "-";
  }

  return value ? "yes" : "no";
}
