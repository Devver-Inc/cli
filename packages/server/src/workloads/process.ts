import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";

import { Data, Effect, Schema } from "effect";
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";

import type { ProcessFailure } from "../exec";
import { runProcess } from "../exec";
import { locateAube } from "../packaged-tools";
import type { ProcessRecipe } from "./config";
import { launchRuleFor } from "./stacks/launch-rules";
import type { DaemonSpec, WorkloadTarget } from "./types";

const UNSAFE_COMMAND = /["'`$;&|<>(){}\\\r\n]/u;
const PORT_PLACEHOLDER = `\${PORT}`;
const INSTALL_TIMEOUT_MS = 120_000;
const INSTALL_MAX_BUFFER = 16 * 1024 * 1024;
// npm-style processes forward SIGTERM to their children unreliably; the
// spawner escalates to SIGKILL so an interrupted install truly ends.
const FORCE_KILL_AFTER_MS = 10_000;
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

// A preparation failure carries one of the plain sentences this module
// constructs; subprocess output never reaches it.
export class ProcessPrepareFailure extends Data.TaggedError(
  "ProcessPrepareFailure"
)<{
  readonly message: string;
}> {}

const failed = (message: string) => new ProcessPrepareFailure({ message });

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
    throw failed("Process commands must be plain executable arguments");
  }
  return parts;
}

async function packagedCommand(
  command: readonly string[]
): Promise<readonly string[]> {
  const [file, ...args] = command;
  return file === "aube" ? [await locateAube(), ...args] : command;
}

const run = (
  command: string,
  directory: string
): Effect.Effect<
  void,
  ProcessPrepareFailure | ProcessFailure,
  ChildProcessSpawner
> =>
  Effect.tryPromise({
    try: async () => await packagedCommand(commandParts(command)),
    catch: (cause) =>
      cause instanceof ProcessPrepareFailure
        ? cause
        : failed("Process commands must be plain executable arguments"),
  }).pipe(
    Effect.flatMap(
      ([file, ...args]): Effect.Effect<
        void,
        ProcessPrepareFailure | ProcessFailure,
        ChildProcessSpawner
      > =>
        file === undefined
          ? Effect.fail(failed("Process command is missing an executable"))
          : runProcess(file, args, {
              cwd: directory,
              timeoutMs: INSTALL_TIMEOUT_MS,
              maxBufferBytes: INSTALL_MAX_BUFFER,
              forceKillAfterMs: FORCE_KILL_AFTER_MS,
            }).pipe(Effect.asVoid)
    )
  );

const installFallback = (
  manager: string,
  directory: string
): Effect.Effect<
  void,
  ProcessPrepareFailure | ProcessFailure,
  ChildProcessSpawner
> => {
  const lockfile = lockfiles.get(manager);
  const hasLockfile =
    lockfile !== undefined && existsSync(join(directory, lockfile));
  if (manager === "npm") {
    return run(
      hasLockfile ? "npm ci" : "npm install --no-package-lock",
      directory
    );
  }
  return run(
    `${manager} install${hasLockfile ? " --frozen-lockfile" : ""}`,
    directory
  );
};

const managedDevCommand = (
  command: readonly string[],
  directory: string,
  port: number
): Effect.Effect<readonly string[], ProcessPrepareFailure> => {
  const [manager, action, script] = command;
  if (
    command.length !== 3 ||
    !packageManagers.has(manager ?? "") ||
    action !== "run" ||
    script !== "dev"
  ) {
    return Effect.succeed(command);
  }
  return Effect.tryPromise({
    try: async () => {
      const content = await readFile(join(directory, "package.json"), "utf-8");
      return packageScripts(JSON.parse(content));
    },
    catch: () => failed("The process package scripts are not usable"),
  }).pipe(
    Effect.flatMap((parsed) => {
      const rule = launchRuleFor(parsed.scripts.dev ?? "");
      return Effect.succeed(
        rule === undefined
          ? command
          : [
              ...command,
              ...(manager === "npm" ? ["--"] : []),
              rule.hostFlag,
              "127.0.0.1",
              "--port",
              String(port),
              ...rule.extraArgs,
            ]
      );
    })
  );
};

export const prepareProcess = (
  recipe: ProcessRecipe,
  { worktree, port }: WorkloadTarget
): Effect.Effect<
  DaemonSpec,
  ProcessPrepareFailure | ProcessFailure,
  ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const { install, build, run: start } = recipe;
    const directory = yield* Effect.tryPromise({
      try: async () => await realpath(worktree),
      catch: () => failed("The process checkout is not usable"),
    });
    const command = commandParts(start, port);
    const [manager, action, script] = command;
    if (install !== undefined) {
      yield* run(install, directory);
    } else if (
      command.length === 3 &&
      packageManagers.has(manager ?? "") &&
      action === "run" &&
      script !== undefined
    ) {
      yield* run("aube install --frozen-lockfile", directory).pipe(
        Effect.catch(() => installFallback(manager ?? "", directory))
      );
    }
    if (build !== undefined) {
      yield* run(build, directory);
    }
    return {
      command: yield* managedDevCommand(
        yield* Effect.tryPromise({
          try: async () => await packagedCommand(command),
          catch: (cause) =>
            cause instanceof ProcessPrepareFailure
              ? cause
              : failed("Process commands must be plain executable arguments"),
        }),
        directory,
        port
      ),
      dir: directory,
      env: { HOST: "127.0.0.1", HOSTNAME: "127.0.0.1", PORT: String(port) },
      port,
    } satisfies DaemonSpec;
  });
