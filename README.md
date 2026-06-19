# Helm

**Helm is a local desktop control plane for AI software work.**

It is designed for developers who already use agents such as Codex, Claude, or Gemini, but do not want a loose pile of chats, terminal logs, diffs, and half-remembered decisions. Helm turns AI-assisted development into a visible workflow: plan the work, run the right role, inspect the result, approve the next step, and keep an audit trail beside the repository.

Helm is not another chat box. It is the deterministic layer around AI agents.

```text
AI agents produce work
Helm records the result
Helm decides the allowed next state
The user approves the important transitions
```

## Why Helm

AI coding tools are powerful, but the workflow around them is still fragile:

- Plans live in chat history instead of the project.
- Reviews, test results, and decisions are hard to trace later.
- Multiple agents can step on each other without clear ownership.
- Git state is often trusted from agent summaries instead of inspected directly.
- Human approval gates are informal, inconsistent, or missing.

Helm is being built to make that workflow explicit.

## What Helm Does

Helm manages AI development work around a local repository:

- Task and epic tracking for local development work
- Role-based agent runs such as planner, coder, reviewer, verifier, and tester
- Approval gates before sensitive transitions
- Repo-local SQLite state in `.helm/helm.sqlite`
- Artifact storage under `.helm/artifacts`
- Read-only Git status from the backend, not from agent claims
- Audit logs for runs, approvals, and task state changes
- A Tauri desktop app with React, TypeScript, Rust, and SQLite

The long-term goal is a local operating console for AI-assisted software teams: tasks, agents, Git, terminals, artifacts, approvals, and project memory in one place.

## Current Status

Helm is under active development.

The repository currently contains two layers:

- `apps/desktop/`: the new Tauri desktop app and the future main product
- `src/`: the legacy Node.js CLI prototype kept as a reference implementation

The desktop app is the primary direction. The legacy CLI is useful for understanding early experiments around Git status, session artifacts, agent binary resolution, safe commits, and PR flows, but it is not the foundation for the new product.

## Product Roadmap

Helm is intentionally being built in small vertical slices.

```text
Phase 1: Open a project, create repo-local DB, show task and Git skeletons
Phase 2: Stub role runs, approvals, audit log, and state transitions
Phase 3a: Task worktrees and a single local Codex/Claude host run
Phase 3b: Docker-based observer for execution evidence and audit support
Phase 3c: Reviewer, verifier, tester chain with gate results
Phase 4+: Git graph, terminal workspace, Jira, Slack, backup, recovery
```

The first real success target is small but important: one local task can move from plan to execution to review to approval with traceable artifacts and Git evidence.

## Desktop App

The desktop app lives in `apps/desktop`.

### Requirements

- Node.js 25+
- Rust stable
- Tauri v2 prerequisites for your platform

### Install

```bash
cd apps/desktop
npm install
```

### Run Development Build

```bash
npm run dev
```

This builds the React app and serves the compiled desktop frontend for local development.

### Typecheck and Build

```bash
npm run typecheck
npm run build
```

### Tests

```bash
npm test
```

## Legacy CLI

The legacy CLI remains at the repository root.

### Requirements

- Node.js 25+

### Commands

```bash
npm run check
node src/cli.ts --help
node src/cli.ts agents
node src/cli.ts run --agent codex --dry-run "Summarize this repository"
node src/cli.ts status
node src/cli.ts show <session>
node src/cli.ts commit <session> --check "npm run check" -m "Fix failing tests"
node src/cli.ts pr <session> --dry-run --base main --title "Fix failing tests"
node src/cli.ts ui
```

You can also link the CLI locally:

```bash
npm link
inxx-helm --help
```

The binary is named `inxx-helm` to avoid conflicting with Kubernetes Helm.

## Repository Layout

```text
Helm/
  apps/
    desktop/          # Tauri + React desktop app
  docs/               # Product design and implementation plans
  scripts/            # Local automation and sync helpers
  src/                # Legacy Node CLI prototype
  test/               # Legacy CLI tests
```

## Design Principles

- Helm is deterministic; agents are workers, not orchestrators.
- AI agents do not directly call other AI agents.
- Git state comes from the backend reading the repository.
- Planning approval and merge approval are explicit user decisions.
- The frontend does not get generic shell execution access.
- Repo-local metadata stays under `.helm/` and should not be committed.
- Real multi-agent execution starts only after worktree isolation, artifacts, audit logs, and cancellation are reliable.

## Key Docs

- [Orchestrator Design](docs/orchestrator-design.md)
- [Phase 0-1 Implementation Plan](docs/phase-0-1-implementation-plan.md)
- [Phase 1-2 User Flow](docs/phase-1-2-user-flow.md)
- [Phase 2 Implementation Plan](docs/phase-2-implementation-plan.md)
- [Phase 3a Implementation Plan](docs/phase-3a-implementation-plan.md)
- [Executable Planning Contract](docs/executable-planning-contract.md)
- [Role Artifact Contract](docs/role-artifact-contract.md)
- [Hermes Local API Guide](docs/hermes-local-api-guide.md)

## Project Philosophy

Helm is built around a simple belief: AI coding becomes more useful when the surrounding workflow is more explicit.

The product should make it obvious:

- what is being worked on,
- who or what produced each artifact,
- what changed in Git,
- which gate is blocking progress,
- what the user approved,
- and why the final change exists.

That is the layer Helm is trying to provide.

## License

MIT
