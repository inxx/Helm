import type { AiConnection, ProjectSnapshot } from "../lib/types";

interface AgentUsageBarProps {
  snapshot: ProjectSnapshot;
}

export function AgentUsageBar({ snapshot }: AgentUsageBarProps) {
  const connections = Array.isArray(snapshot.settings.aiConnections) ? snapshot.settings.aiConnections : [];
  const assignments = Array.isArray(snapshot.settings.roleAssignments) ? snapshot.settings.roleAssignments : [];
  const enabledConnections = connections.filter((connection) => connection.enabled);
  const totalConnections = connections.length;
  const assignedConnectionIds = new Set(
    assignments.flatMap((assignment) =>
      Array.isArray(assignment.selections)
        ? assignment.selections.map((selection) => selection.connectionId)
        : [],
    ),
  );
  const assignedConnections = connections.filter((connection) =>
    assignedConnectionIds.has(connection.id),
  );
  const approvals = Array.isArray(snapshot.approvals) ? snapshot.approvals : [];
  const pendingApprovals = approvals.filter((approval) => approval.status === "Pending").length;
  const tokenBudget = snapshot.settings.tokenBudget;
  const primaryConnection = assignedConnections[0] ?? enabledConnections[0] ?? null;

  return (
    <footer className="agent-usage-bar" aria-label="connected agent usage">
      <div className="agent-usage-primary">
        <span className="status-label">connected agents</span>
        <strong>
          {enabledConnections.length}/{totalConnections}
        </strong>
      </div>
      <AgentUsageItem label="primary" value={runnerLabel(primaryConnection)} />
      <AgentUsageItem label="assigned" value={String(assignedConnections.length)} />
      <AgentUsageItem label="models" value={modelSummary(assignedConnections)} />
      <AgentUsageItem
        label="usage"
        value={tokenBudget ? `미수집 / ${formatNumber(tokenBudget)} budget` : "미수집"}
        tone="warn"
      />
      <AgentUsageItem label="approvals" value={String(pendingApprovals)} tone={pendingApprovals > 0 ? "warn" : "ok"} />
    </footer>
  );
}

function AgentUsageItem({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "ok" | "warn";
}) {
  return (
    <div>
      <span className="status-label">{label}</span>
      <strong className={tone ? `tone-${tone}` : undefined}>{value}</strong>
    </div>
  );
}

function runnerLabel(connection: AiConnection | null | undefined): string {
  if (!connection) return "미설정";
  return `${connection.label} · ${connection.provider}`;
}

function modelSummary(connections: AiConnection[]): string {
  const models = connections
    .map((connection) => connection.defaultModel)
    .filter((model): model is string => Boolean(model));
  if (models.length === 0) return "-";
  if (models.length === 1) return models[0];
  return `${models[0]} +${models.length - 1}`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}
