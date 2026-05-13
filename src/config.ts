import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isAgentName, type AgentName } from "./harness/agents.ts";

export type HelmConfig = {
  agentBinaries?: Partial<Record<AgentName, string>>;
  defaultCheckCommand?: string;
  prBaseBranch?: string;
};

export function loadHelmConfig(repoPath: string): HelmConfig {
  const configPath = join(repoPath, ".helm", "config.json");

  if (!existsSync(configPath)) {
    return {};
  }

  let rawConfig: unknown;

  try {
    rawConfig = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(`${configPath} 파일을 읽지 못했습니다: ${formatError(error)}`);
  }

  if (!isPlainObject(rawConfig)) {
    throw new Error(`${configPath} 파일은 JSON object여야 합니다.`);
  }

  return {
    agentBinaries: readAgentBinaries(rawConfig.agentBinaries, configPath),
    defaultCheckCommand: readOptionalString(
      rawConfig.defaultCheckCommand,
      "defaultCheckCommand",
      configPath,
    ),
    prBaseBranch: readOptionalString(rawConfig.prBaseBranch, "prBaseBranch", configPath),
  };
}

function readAgentBinaries(value: unknown, configPath: string): HelmConfig["agentBinaries"] {
  if (value === undefined) {
    return undefined;
  }

  if (!isPlainObject(value)) {
    throw new Error(`${configPath} agentBinaries 값은 JSON object여야 합니다.`);
  }

  const binaries: Partial<Record<AgentName, string>> = {};

  for (const [agent, binary] of Object.entries(value)) {
    if (!isAgentName(agent)) {
      throw new Error(`${configPath} agentBinaries.${agent}는 지원하지 않는 agent입니다.`);
    }

    binaries[agent] = readRequiredString(binary, `agentBinaries.${agent}`, configPath);
  }

  return binaries;
}

function readOptionalString(value: unknown, key: string, configPath: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return readRequiredString(value, key, configPath);
}

function readRequiredString(value: unknown, key: string, configPath: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${configPath} ${key} 값은 비어 있지 않은 문자열이어야 합니다.`);
  }

  return value.trim();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
