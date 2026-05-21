import type { EffectiveSettings, RoleAssignment } from "./types";

export type RoleId = RoleAssignment["roleId"];

export interface RunnerReadiness {
  roleId: RoleId;
  ready: boolean;
  label: string;
  description: string;
  source: "assignment" | "legacy-preset" | "missing";
}

const ROLE_LABELS: Record<RoleId, string> = {
  planner: "설계자",
  coder: "구현자",
  plan_verifier: "계획 검토자",
  code_reviewer: "코드 리뷰어",
  tester: "테스트 담당자",
};

export function roleLabel(roleId: string): string {
  return ROLE_LABELS[roleId as RoleId] ?? roleId;
}

export function runnerReadinessFor(settings: EffectiveSettings, roleId: RoleId): RunnerReadiness {
  const assignment = settings.roleAssignments.find((item) => item.roleId === roleId);
  const selection = firstSelection(assignment);

  if (selection) {
    const connection = settings.aiConnections.find((item) => item.id === selection.connectionId);
    if (!connection) {
      return {
        roleId,
        ready: false,
        label: "연결 없음",
        description: `${roleLabel(roleId)} 역할에 배정된 AI CLI 연결을 찾을 수 없습니다.`,
        source: "missing",
      };
    }
    if (!connection.enabled) {
      return {
        roleId,
        ready: false,
        label: connection.label,
        description: `${connection.label} CLI 연결이 비활성화되어 있습니다.`,
        source: "assignment",
      };
    }
    if (connection.commandArgs.length === 0) {
      return {
        roleId,
        ready: false,
        label: connection.label,
        description: `${connection.label} CLI 연결에 실행 command가 없습니다.`,
        source: "assignment",
      };
    }
    return {
      roleId,
      ready: true,
      label: connection.label,
      description: `${connection.provider} CLI command로 host runner를 실행합니다.`,
      source: "assignment",
    };
  }

  if (legacyPresetHasCommand(settings.rolePresets, roleId)) {
    return {
      roleId,
      ready: true,
      label: "Legacy preset",
      description: "기존 role preset command로 host runner를 실행합니다.",
      source: "legacy-preset",
    };
  }

  return {
    roleId,
    ready: false,
    label: "Runner 없음",
    description: "Runner Template을 적용하거나 AI CLI 연결을 역할에 배정해야 합니다.",
    source: "missing",
  };
}

function firstSelection(assignment: RoleAssignment | undefined) {
  if (!assignment) return null;
  const selection = assignment.selections.find((item) => item.connectionId.trim());
  if (selection) return selection;
  const legacyConnectionId = assignment.connectionIds.find((connectionId) => connectionId.trim());
  return legacyConnectionId ? { connectionId: legacyConnectionId, model: null, effort: null } : null;
}

function legacyPresetHasCommand(rolePresets: unknown, roleId: RoleId): boolean {
  if (!Array.isArray(rolePresets)) return false;
  const preset = rolePresets.find(
    (item) => isRecord(item) && item.roleId === roleId,
  );
  if (!isRecord(preset)) return false;
  const commandArgs = preset.commandArgs;
  if (Array.isArray(commandArgs) && commandArgs.some((item) => typeof item === "string" && item.trim())) {
    return true;
  }
  return typeof preset.commandTemplate === "string" && preset.commandTemplate.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
