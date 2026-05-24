# Helm Agent Runner Lifecycle Plan

## Goal

Helm should stop treating planning chat as a one-shot CLI call that blocks the UI. The target model is a local agent control plane:

- Planning chat stays responsive and writes intent/draft updates.
- Task materialization enqueues work.
- A runner lifecycle claims queued work and streams observable status.
- Approval gates stop risky transitions.

## Reference Models

| Reference | Useful Pattern | Helm Adaptation |
| --- | --- | --- |
| `tt-a1i/hive` | Local orchestrator and worker CLI sessions coordinate through a small team protocol and shared task state. | Keep Helm local-first. Use real CLI workers, but make completion explicit through structured result and audit logs. |
| `multica-ai/multica` | Issue/task assignment becomes `enqueue -> claim -> start -> complete/fail`, with progress streamed to the UI. | Add queue/claim lifecycle on top of `agent_runs` and keep approval gates as Helm's source of truth. |

## Execution Plan

| Phase | Scope | User Value | Acceptance |
| --- | --- | --- | --- |
| 1. Auto-start first run | After Plan Document materialization, queue the first Task's next role and start host runner in the background. | Creating a task visibly starts work instead of leaving the user at a manual next-action card. | First created task gets a worktree, a queued planner run, and then a background host run. UI can refresh when the run finishes. |
| 2. Queue-only safety | If host runner cannot start, mark the run as `NeedsInspection` instead of leaving it stuck in `Running`. | Failed automation is visible and recoverable. | Command spawn/config errors produce an inspectable run artifact and audit event. |
| 3. Run status events | Emit `agent-run://updated` when background runs finish. | Task detail updates without the user guessing whether work completed. | Active Task Detail reloads runs and project snapshot on matching events. |
| 4. Approval continuation | When a user approves `PlanApproval`, queue and start the next role automatically. | Approval becomes the only manual gate before implementation starts. | Approving a planner result moves the task to `Ready` and starts the coder run best-effort. |
| 5. Supervisor reconciler | When the queue is empty, scan task state and queue the missing next role if no run for that role exists yet. | App restart, event loss, or interrupted continuation does not strand a task between stages. | `Ready -> coder`, `PlanVerification -> plan_verifier`, `CodeReview -> code_reviewer`, and `Testing -> tester` gaps are repaired once, without retrying failed runs. |
| 6. Auto-next policy | Add explicit project setting for `manual`, `observe`, `repair`, or `gate`. | User controls how autonomous Helm should be. | Default keeps PlanApproval human-gated; post-approval role continuation can be repaired automatically. |
| 7. Planner chat split | Separate quick chat response from full Plan Draft regeneration. | Planning tab feels like chat, not a frozen CLI invocation. | User messages render immediately; draft regeneration can run as a job. |
| 8. Streaming terminal/logs | Stream stdout/stderr or PTY output into run timeline. | Long CLI work feels alive and diagnosable. | User sees incremental worker output before structured result completes. |

## Current MVP Boundary

Implemented MVP boundary:

- Auto-start only the first Task created from a Planning approval.
- Stop after planner run creates `PlanApproval`; do not auto-approve.
- After a user approves `PlanApproval`, auto-start the coder run best-effort.
- After coder success, continue through `PlanVerification -> CodeReview -> Testing -> MergeWaiting`.
- A deterministic supervisor reconciler repairs missing post-approval role runs when the queue is empty.
- The reconciler does not auto-start planner runs for plain `Planned` tasks and does not retry a role that already has a run record.
- Keep manual buttons as fallback.

## Supervisor vs Conductor

Helm uses two separate orchestration layers:

- **Supervisor reconciler**: deterministic backend logic. It compares task status with expected next role and creates a queued run when the next role is missing. This is the "observer that repairs the pipeline" role.
- **Conductor AI**: optional LLM gate before a queued run starts. In `observe` mode it records selection only. In `gate` mode it can return `run` or `hold`.

The planner remains scoped to planning and `PlanApproval`. It does not directly invoke coder, reviewer, or tester. Helm backend owns the role chain.

## Blocker Rules

- If the run cannot create a worktree, show the failure and keep the Task in `Planned`.
- If host runner launch fails, convert the run to `NeedsInspection`.
- If the runner succeeds but structured result is invalid, keep the existing `NeedsInspection` path.
- If approval is required, stop and wait for the user.
