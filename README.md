# Helm

**A local-first desktop control plane for AI coding agents.**

Helm helps you run AI-assisted software work like an accountable engineering workflow, not a pile of chat tabs. It gives each task a clear plan, role-based agent runs, isolated worktrees, captured artifacts, Git evidence, approvals, and an audit trail that lives with your local repository.

If you have ever asked Claude, Codex, Gemini, or another coding agent to work on the same project and then lost track of what changed, why it changed, which branch it touched, or whether the result was reviewed, Helm is built for that gap.

> Helm is not Kubernetes Helm. The CLI is named `inxx-helm` to avoid binary conflicts.

## Why Helm Exists

AI coding tools are powerful, but most workflows still rely on humans to manually coordinate:

- Which task is being worked on
- Which agent role should run next
- Whether the plan was approved
- Which files actually changed
- Whether review and test gates passed
- What evidence supports a merge decision

Helm turns that coordination into a deterministic local app. Agents produce outputs; Helm owns the state machine, approvals, Git inspection, artifacts, and next-step control.

```text
Human approves plan
-> Helm prepares context and task worktree
-> Agent performs one role
-> Helm captures stdout, stderr, diff, changed files, and structured result
-> Helm decides whether the next role is allowed
-> Human keeps final approval authority
```

## What You Can Do Today

The active product is the Tauri desktop app in `apps/desktop`.

- Open a local Git project
- Create and track epics, tasks, approvals, and external references
- Store project state in repo-local SQLite under `.helm/`
- Inspect read-only Git status and task worktree changes
- Prepare role-specific context packs for planner, coder, verifier, reviewer, and tester runs
- Run configured local host commands for agent roles
- Capture run artifacts including summary, structured result, logs, diffs, and changed files
- Enforce simple gate behavior before task status transitions
- Cancel, retry, and inspect role runs
- Use a terminal surface for project or task worktree commands
- Review task evidence through audit and timeline views

The older Node CLI remains in `src/` as a reference implementation for Git status, session artifacts, safe commit, and PR flow experiments.

## Product Direction

Helm is aiming to become the local operating console for AI engineering work:

- Task planning and approval before code starts
- Role-based AI execution: planner, coder, plan verifier, code reviewer, tester
- Task-scoped Git worktrees
- Artifact-first run history
- Gate checks based on real Git diffs and command results
- Merge readiness and human approval
- Obsidian, Jira, Slack, and terminal workflows after the core loop is solid
- Local-first storage and explicit user control by default

The goal is not full autonomy. The goal is controlled acceleration: agents can move fast, but Helm keeps the workflow inspectable, replayable, and accountable.

## Architecture

```text
Desktop app      Tauri v2 + React + TypeScript
Backend          Rust command layer
Local state      SQLite in repo/.helm/helm.sqlite
Git integration  git CLI, task worktrees, diff/status inspection
Runner           Host commands for local Claude/Codex/Gemini-style CLIs
Artifacts        Markdown, JSON, logs, diffs, changed-file manifests
Terminal         xterm.js-based desktop terminal surface
```

Core principle: the frontend does not get generic shell authority. Git state, command execution, task transitions, and approvals are owned by the backend command layer.

## Getting Started

### Desktop app

```bash
cd apps/desktop
npm install
npm run dev
```

For a production-style build check:

```bash
cd apps/desktop
npm run build
npm test
```

### Legacy CLI

The legacy CLI requires Node.js 25 or newer because it uses Node's TypeScript type stripping.

```bash
npm install
npm run check
node src/cli.ts --help
node src/cli.ts status
```

You can link the CLI locally as `inxx-helm`:

```bash
npm link
inxx-helm --help
```

## Repo Layout

```text
apps/desktop/  Tauri desktop app
src/           Legacy Node CLI reference
docs/          Product plans, architecture notes, and phase contracts
test/          Legacy CLI tests
.helm/         Local runtime state, ignored by Git
```

Start with these docs if you want to understand the product model:

- [Orchestrator Design](docs/orchestrator-design.md)
- [Core Loop Completion Plan](docs/core-loop-completion-plan.md)
- [Phase 3a Implementation Plan](docs/phase-3a-implementation-plan.md)
- [Role Artifact Contract](docs/role-artifact-contract.md)
- [Executable Planning Contract](docs/executable-planning-contract.md)

## Roadmap

- Close the full task core loop from planning to `MergeWaiting`
- Strengthen reviewer and tester gate contracts
- Add merge readiness, merge approval, and safer branch operations
- Improve run search, pinned sessions, and usage reporting
- Add workflow presets for repeatable checks and agent runs
- Expand integrations only after the local core loop is reliable

## Configuration

The legacy CLI reads optional repo-local settings from `.helm/config.json`.

```json
{
  "agentBinaries": {
    "codex": "/opt/homebrew/bin/codex",
    "claude": "/opt/homebrew/bin/claude",
    "gemini": "/opt/homebrew/bin/gemini"
  },
  "defaultCheckCommand": "npm run check",
  "prBaseBranch": "main"
}
```

CLI flags and environment variables override this file.

## Contributing

Helm is still early, and the most valuable contributions are the ones that make agent work safer and easier to inspect:

- Smaller, clearer state transitions
- Better run artifacts
- Better Git evidence
- Better failure and retry UX
- Tests that protect the task execution loop

If the idea of a local, auditable control plane for AI coding agents is useful to you, a star helps the project reach more developers who are trying to make agentic coding workflows less chaotic.

## License

MIT
