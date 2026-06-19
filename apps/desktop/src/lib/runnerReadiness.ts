import type { EffectiveSettings, RoleAssignment } from "./types";
import type { AppLanguage } from "./i18n";

export type RoleId = RoleAssignment["roleId"];

export interface RunnerReadiness {
  roleId: RoleId;
  ready: boolean;
  label: string;
  description: string;
  source: "assignment" | "legacy-preset" | "missing";
}

const ROLE_LABELS: Record<AppLanguage, Record<RoleId, string>> = {
  en: {
    planner: "Planner",
    coder: "Coder",
    plan_verifier: "Plan Reviewer",
    code_reviewer: "Code Reviewer",
    tester: "Tester",
  },
  ko: {
    planner: "설계자",
    coder: "구현자",
    plan_verifier: "계획 검토자",
    code_reviewer: "코드 리뷰어",
    tester: "테스트 담당자",
  },
};

export function roleLabel(roleId: string, language: AppLanguage = "ko"): string {
  return ROLE_LABELS[language][roleId as RoleId] ?? roleId;
}

export function roleDossierArtifactName(roleId: string): string {
  switch (roleId) {
    case "planner":
      return "plan.md";
    case "coder":
      return "pr-dossier.md";
    case "plan_verifier":
      return "plan-verification.md";
    case "code_reviewer":
      return "review-report.md";
    case "tester":
      return "test-report.md";
    default:
      return "role-dossier.md";
  }
}

export function roleDossierLabel(roleId: string, language: AppLanguage = "ko"): string {
  switch (roleId) {
    case "planner":
      return language === "ko" ? "계획서" : "Plan";
    case "coder":
      return language === "ko" ? "PR 문서" : "PR Dossier";
    case "plan_verifier":
      return language === "ko" ? "계획 검토" : "Plan Review";
    case "code_reviewer":
      return language === "ko" ? "리뷰 기록" : "Review Report";
    case "tester":
      return language === "ko" ? "테스트 기록" : "Test Report";
    default:
      return language === "ko" ? "역할 기록" : "Role Dossier";
  }
}

export function runnerReadinessFor(settings: EffectiveSettings, roleId: RoleId, language: AppLanguage = "ko"): RunnerReadiness {
  const assignment = settings.roleAssignments.find((item) => item.roleId === roleId);
  const selection = firstSelection(assignment);

  if (selection) {
    const connection = settings.aiConnections.find((item) => item.id === selection.connectionId);
    if (!connection) {
      return {
        roleId,
        ready: false,
        label: language === "ko" ? "연결 없음" : "No connection",
        description:
          language === "ko"
            ? `${roleLabel(roleId, language)} 역할에 배정된 AI CLI 연결을 찾을 수 없습니다.`
            : `No AI CLI connection is assigned to the ${roleLabel(roleId, language)} role.`,
        source: "missing",
      };
    }
    if (!connection.enabled) {
      return {
        roleId,
        ready: false,
        label: connection.label,
        description:
          language === "ko"
            ? `${connection.label} CLI 연결이 비활성화되어 있습니다.`
            : `${connection.label} CLI connection is disabled.`,
        source: "assignment",
      };
    }
    if (connection.commandArgs.length === 0) {
      return {
        roleId,
        ready: false,
        label: connection.label,
        description:
          language === "ko"
            ? `${connection.label} CLI 연결에 실행 command가 없습니다.`
            : `${connection.label} CLI connection has no command.`,
        source: "assignment",
      };
    }
    return {
      roleId,
      ready: true,
      label: connection.label,
      description:
        language === "ko"
          ? `${connection.provider} CLI command로 host runner를 실행합니다.`
          : `Runs the host runner with the ${connection.provider} CLI command.`,
      source: "assignment",
    };
  }

  if (legacyPresetHasCommand(settings.rolePresets, roleId)) {
    return {
      roleId,
      ready: true,
      label: "Legacy preset",
      description:
        language === "ko"
          ? "기존 role preset command로 host runner를 실행합니다."
          : "Runs the host runner with the legacy role preset command.",
      source: "legacy-preset",
    };
  }

  return {
    roleId,
    ready: false,
    label: language === "ko" ? "Runner 없음" : "No runner",
    description:
      language === "ko"
        ? "Runner Template을 적용하거나 AI CLI 연결을 역할에 배정해야 합니다."
        : "Apply a runner template or assign an AI CLI connection to this role.",
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
