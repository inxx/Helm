import { Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { api } from "../lib/api";
import { roleLabel, runnerReadinessFor, type RoleId } from "../lib/runnerReadiness";
import type { AiConnection, ProjectSnapshot, RunnerCheckResult } from "../lib/types";

const ROLE_IDS: RoleId[] = ["planner", "coder", "plan_verifier", "code_reviewer", "tester"];

interface RuntimeReadinessBarProps {
  snapshot: ProjectSnapshot;
  onGoSettings: () => void;
}

export function RuntimeReadinessBar({ snapshot, onGoSettings }: RuntimeReadinessBarProps) {
  const [checks, setChecks] = useState<Record<string, RunnerCheckResult>>({});
  const [busy, setBusy] = useState(false);
  const rows = useMemo(
    () =>
      ROLE_IDS.map((roleId) => {
        const readiness = runnerReadinessFor(snapshot.settings, roleId);
        const connection = connectionForRole(snapshot, roleId);
        const check = checks[roleId];
        const command = connection?.commandArgs?.[0] ?? check?.command?.[0] ?? "-";
        const timeout = connection?.timeoutSeconds ? `${connection.timeoutSeconds}s` : "-";
        const policy = policyLabel(connection);
        const bypass = hasBypassFlag(connection);
        return {
          roleId,
          readiness,
          connection,
          check,
          command,
          timeout,
          policy,
          bypass,
        };
      }),
    [checks, snapshot],
  );
  const readyCount = rows.filter((row) => row.readiness.ready).length;
  const checkedCount = rows.filter((row) => row.check).length;
  const blockedCount = rows.filter((row) => !row.readiness.ready || row.check?.available === false).length;
  const bypassCount = rows.filter((row) => row.bypass).length;

  async function runChecks() {
    setBusy(true);
    try {
      const entries = await Promise.all(
        ROLE_IDS.map(async (roleId) => {
          try {
            return [roleId, await api.checkRoleRunner(snapshot.project.id, roleId)] as const;
          } catch (error) {
            return [
              roleId,
              {
                roleId,
                available: false,
                command: [],
                message: messageFromError(error, "runner health check에 실패했습니다."),
              },
            ] as const;
          }
        }),
      );
      setChecks(Object.fromEntries(entries));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="runtime-readiness-panel" aria-label="runtime readiness">
      <div className="runtime-readiness-summary">
        <div>
          <span className="status-label">runtime readiness</span>
          <strong className={blockedCount > 0 ? "tone-warn" : "tone-ok"}>
            {readyCount}/{ROLE_IDS.length} roles ready
          </strong>
        </div>
        <div>
          <span className="status-label">health checks</span>
          <strong>{checkedCount === 0 ? "not run" : `${checkedCount}/${ROLE_IDS.length}`}</strong>
        </div>
        <div>
          <span className="status-label">automation</span>
          <strong>테스트 완료까지 자동 · 머지 수동</strong>
        </div>
        <div>
          <span className="status-label">worktree root</span>
          <strong>{snapshot.settings.worktreeRoot ? "custom" : ".helm/worktrees"}</strong>
        </div>
        <div>
          <span className="status-label">bypass flags</span>
          <strong className={bypassCount > 0 ? "tone-warn" : "tone-ok"}>{bypassCount}</strong>
        </div>
        <div className="runtime-readiness-actions">
          <button
            aria-busy={busy ? true : undefined}
            className={busy ? "secondary-button loading-button is-loading" : "secondary-button loading-button"}
            disabled={busy}
            onClick={runChecks}
            type="button"
          >
            {busy ? <Loader2 className="loading-icon" size={14} aria-hidden /> : null}
            {busy ? "점검 중..." : "runtime 점검"}
          </button>
          <button className="secondary-button" onClick={onGoSettings} type="button">
            설정
          </button>
        </div>
      </div>
      <ul className="runtime-readiness-roles">
        {rows.map((row) => (
          <li key={row.roleId}>
            <div>
              <strong>{roleLabel(row.roleId)}</strong>
              <span className={row.readiness.ready && row.check?.available !== false ? "check-pass" : "check-fail"}>
                {statusLabel(row)}
              </span>
            </div>
            <p>{row.check?.message ?? row.readiness.description}</p>
            <small>
              {row.command} · timeout {row.timeout} · {row.policy}
              {row.bypass ? " · bypass flag" : ""}
            </small>
          </li>
        ))}
      </ul>
    </section>
  );
}

function connectionForRole(snapshot: ProjectSnapshot, roleId: RoleId): AiConnection | null {
  const assignment = snapshot.settings.roleAssignments.find((item) => item.roleId === roleId);
  const connectionId =
    assignment?.selections.find((selection) => selection.connectionId.trim())?.connectionId ??
    assignment?.connectionIds.find((id) => id.trim()) ??
    null;
  if (!connectionId) return legacyConnectionForRole(snapshot.settings.aiConnections, snapshot.settings.rolePresets, roleId);
  return snapshot.settings.aiConnections.find((connection) => connection.id === connectionId) ?? null;
}

function legacyConnectionForRole(
  connections: AiConnection[],
  rolePresets: unknown,
  roleId: RoleId,
): AiConnection | null {
  if (!Array.isArray(rolePresets)) return null;
  const preset = rolePresets.find((item) => isRecord(item) && item.roleId === roleId);
  if (!isRecord(preset)) return null;
  const provider = typeof preset.provider === "string" ? preset.provider : "legacy";
  const commandArgs = Array.isArray(preset.commandArgs)
    ? preset.commandArgs.filter((item): item is string => typeof item === "string")
    : [];
  const timeoutSeconds = typeof preset.timeoutSeconds === "number" ? preset.timeoutSeconds : 1800;
  return {
    id: `${roleId}:legacy`,
    label: "Legacy preset",
    provider,
    commandArgs,
    timeoutSeconds,
    enabled: true,
    approvalPolicy: typeof preset.approvalPolicy === "string" ? preset.approvalPolicy : null,
    sandbox: typeof preset.sandbox === "string" ? preset.sandbox : null,
  };
}

function policyLabel(connection: AiConnection | null): string {
  if (!connection) return "policy unknown";
  const approval = connection.approvalPolicy ?? "approval ?";
  const sandbox = connection.sandbox ?? "sandbox ?";
  return `${approval} / ${sandbox}`;
}

function hasBypassFlag(connection: AiConnection | null): boolean {
  return Boolean(
    connection?.commandArgs.some((arg) => arg.includes("dangerously-bypass") || arg.includes("bypass-approvals")),
  );
}

function statusLabel(row: {
  readiness: ReturnType<typeof runnerReadinessFor>;
  check?: RunnerCheckResult;
  bypass: boolean;
}): string {
  if (!row.readiness.ready) return "missing";
  if (row.check?.available === false) return "check failed";
  if (row.bypass) return "ready · bypass";
  if (row.check?.available) return "checked";
  return "ready";
}

function messageFromError(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  if (typeof error === "string") return error;
  return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
