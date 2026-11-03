import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";

import { Schema } from "effect";

import { execute } from "../exec";
import { locateAube } from "../packaged-tools";
import { readProcessRecipe } from "./config";
import { launchRuleFor } from "./stacks/launch-rules";
import type { DaemonSpec, WorkloadKind } from "./types";

const UNSAFE_COMMAND = /["'`$;&|<>(){}\\\r\n]/u;
const PORT_PLACEHOLDER = `\${PORT}`;
const packageScripts = Schema.decodeUnknownSync(
  Schema.Struct({ scripts: Schema.Record(Schema.String, Schema.String) })
);
const packageManagers = new Set(["npm", "pnpm", "yarn", "bun"]);
const lockfiles = new Map([
  ["npm", "package-lock.json"],
  ["pnpm", "pnpm-lock.yaml"],
  ["yarn", "yarn.lock"],
  ["bun", "bun.lock"],
]);

function commandParts(command: string, port?: number): readonly string[] {
  const parts = command
    .trim()
    .split(/\s+/u)
    .map((part) =>
      part === PORT_PLACEHOLDER && port !== undefined ? String(port) : part
    );
  if (
    parts.length === 0 ||
    parts[0] === "" ||
    parts.some(
      (part) => UNSAFE_COMMAND.test(part) || part.includes(PORT_PLACEHOLDER)
    )
  ) {
    throw new Error("Process commands must be plain executable arguments");
  }
  return parts;
}

async function packagedCommand(
  command: readonly string[]
): Promise<readonly string[]> {
  const [file, ...args] = command;
  return file === "aube" ? [await locateAube(), ...args] : command;
}

async function run(command: string, worktree: string): Promise<void> {
  const [file, ...args] = await packagedCommand(commandParts(command));
  if (file === undefined) {
    throw new Error("Process command is missing an executable");
  }
  await execute(file, args, {
    cwd: worktree,
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
}

async function installFallback(
  manager: string,
  directory: string
): Promise<void> {
  const lockfile = lockfiles.get(manager);
  const hasLockfile =
    lockfile !== undefined && existsSync(join(directory, lockfile));
  if (manager === "npm") {
    await run(
      hasLockfile ? "npm ci" : "npm install --no-package-lock",
      directory
    );
    return;
  }
  await run(
    `${manager} install${hasLockfile ? " --frozen-lockfile" : ""}`,
    directory
  );
}

async function managedDevCommand(
  command: readonly string[],
  directory: string,
  port: number
): Promise<readonly string[]> {
  const [manager, action, script] = command;
  if (
    command.length !== 3 ||
    !packageManagers.has(manager ?? "") ||
    action !== "run" ||
    script !== "dev"
  ) {
    return command;
  }
  let scripts: Readonly<Record<string, string>>;
  try {
    const content = await readFile(join(directory, "package.json"), "utf-8");
    const parsed: unknown = JSON.parse(content);
    ({ scripts } = packageScripts(parsed));
  } catch {
    throw new Error("The process package scripts are not usable");
  }
  const rule = launchRuleFor(scripts.dev ?? "");
  if (rule === undefined) {
    return command;
  }
  return [
    ...command,
    ...(manager === "npm" ? ["--"] : []),
    rule.hostFlag,
    "127.0.0.1",
    "--port",
    String(port),
    ...rule.extraArgs,
  ];
}

export const processKind: WorkloadKind = {
  name: "process",
  resolve: async ({ worktree, port }) => {
    const { install, build, run: start } = await readProcessRecipe(worktree);
    const directory = await realpath(worktree);
    const command = commandParts(start, port);
    const [manager, action, script] = command;
    if (install !== undefined) {
      await run(install, directory);
    } else if (
      command.length === 3 &&
      packageManagers.has(manager ?? "") &&
      action === "run" &&
      script !== undefined
    ) {
      try {
        await run("aube install --frozen-lockfile", directory);
      } catch {
        await installFallback(manager ?? "", directory);
      }
    }
    if (build !== undefined) {
      await run(build, directory);
    }
    return {
      command: await managedDevCommand(
        await packagedCommand(command),
        directory,
        port
      ),
      dir: directory,
      env: { HOST: "127.0.0.1", HOSTNAME: "127.0.0.1", PORT: String(port) },
      port,
    } satisfies DaemonSpec;
  },
};
