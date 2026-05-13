import { spawn, spawnSync } from "node:child_process";
import type { Writable } from "node:stream";

export type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type RunCommandOptions = {
  cwd: string;
  input?: string;
};

export type RunCommandStreamOptions = RunCommandOptions & {
  stdout?: Writable;
  stderr?: Writable;
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

export function runCommandStream(
  command: string,
  args: string[],
  options: RunCommandStreamOptions,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const resolveOnce = (result: CommandResult) => {
      if (settled) {
        return;
      }

      settled = true;
      resolve(result);
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string | Buffer) => {
      const text = normalizeChunk(chunk);
      stdout += text;
      options.stdout?.write(text);
    });

    child.stderr.on("data", (chunk: string | Buffer) => {
      const text = normalizeChunk(chunk);
      stderr += text;
      options.stderr?.write(text);
    });

    child.on("error", (error) => {
      if (!stderr) {
        options.stderr?.write(error.message);
      }

      resolveOnce({
        code: 1,
        stdout,
        stderr: stderr ? `${stderr}${error.message}` : error.message,
      });
    });

    child.on("close", (code, signal) => {
      resolveOnce({
        code: code ?? (signal ? 1 : 0),
        stdout,
        stderr,
      });
    });

    child.stdin.end(options.input ?? "");
  });
}

function normalizeChunk(chunk: string | Buffer): string {
  return typeof chunk === "string" ? chunk : chunk.toString("utf8");
}
