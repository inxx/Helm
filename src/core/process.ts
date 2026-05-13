import { spawnSync } from "node:child_process";

export type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type RunCommandOptions = {
  cwd: string;
  input?: string;
};

export function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions,
): CommandResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    input: options.input,
    encoding: "utf8",
  });

  if (result.error) {
    return {
      code: 1,
      stdout: "",
      stderr: result.error.message,
    };
  }

  return {
    code: result.status ?? 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}
