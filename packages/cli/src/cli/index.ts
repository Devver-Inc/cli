#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect, Runtime } from "effect";
import { Command } from "effect/cli";

import pkg from "../../../../package.json" with { type: "json" };
import { versionLine } from "../infra/version";
import { attach } from "./commands/attach";
import { auth } from "./commands/auth";
import { cloud } from "./commands/cloud";
import { config } from "./commands/config";
import { deploy } from "./commands/deploy";
import { detach } from "./commands/detach";
import { init } from "./commands/init";
import { merge } from "./commands/merge";
import { newCommand } from "./commands/new";
import { organization } from "./commands/organization";
import { project } from "./commands/project";
import { repos } from "./commands/repos";
import { secret } from "./commands/secret";
import { server } from "./commands/server";
import { launchTui, tui } from "./commands/tui";
import {
  deploymentIds,
  extendCompletions,
  serverNames,
} from "./completion/scripts";
import { root } from "./root";
import { runUpdate } from "./update";

// Expected failures already carry a user-facing message, so the process edge
// prints it and marks it reported to suppress duplicate cause logging.
const printExpected = (error: {
  readonly message: string;
  [Runtime.errorReported]?: boolean;
}) =>
  Effect.gen(function* () {
    yield* Console.error(error.message);
    error[Runtime.errorReported] = false;
  });

export const cli = root.pipe(
  Command.withHandler(({ apiUrl, update }) =>
    Effect.gen(function* () {
      if (update) {
        return yield* runUpdate;
      }
      return yield* launchTui(undefined, apiUrl);
    })
  ),
  Command.withSubcommands([
    attach,
    auth,
    cloud,
    config,
    deploy,
    detach,
    init,
    merge,
    newCommand,
    organization,
    project,
    repos,
    secret,
    server,
    tui,
  ])
);

const isCompletionScript = (value: unknown): value is string =>
  typeof value === "string";

const isConsoleMember = (
  target: Console.Console,
  property: PropertyKey
): property is keyof Console.Console => property in target;

// Compiled Windows executables can report import.meta.main as false.
declare const DEVVER_STANDALONE_ENTRY: boolean;
if (
  import.meta.main ||
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Build-only constant is absent in source and npm.
  (typeof DEVVER_STANDALONE_ENTRY === "boolean" && DEVVER_STANDALONE_ENTRY)
) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--completion-server-names") {
    NodeRuntime.runMain(serverNames);
  } else if (args.length === 1 && args[0] === "--completion-deployment-ids") {
    NodeRuntime.runMain(deploymentIds);
  } else {
    const completion =
      args.find((arg) => arg.startsWith("--completions="))?.split("=")[1] ??
      (args[0] === "--completions" ? args[1] : undefined);
    const program = Command.run(cli, { version: versionLine(pkg.version) });
    const withCompletions =
      completion === undefined
        ? program
        : Effect.gen(function* () {
            const original = yield* Console.Console;
            return yield* program.pipe(
              Effect.provideService(
                Console.Console,
                new Proxy(original, {
                  get(target, property) {
                    if (property === "log") {
                      return (...messages: readonly unknown[]) => {
                        for (const message of messages) {
                          original.log(
                            isCompletionScript(message)
                              ? extendCompletions(message, completion)
                              : message
                          );
                        }
                      };
                    }
                    return isConsoleMember(target, property)
                      ? target[property]
                      : undefined;
                  },
                })
              )
            );
          });
    NodeRuntime.runMain(
      withCompletions.pipe(
        Effect.tapErrorTag("DeployAbortError", printExpected),
        Effect.tapErrorTag("InitAbortError", printExpected),
        Effect.tapErrorTag("ServerCreateError", printExpected),
        Effect.tapErrorTag("ServerLifecycleError", printExpected),
        Effect.tapErrorTag("UpdateError", printExpected),
        // @effect-diagnostics-next-line strictEffectProvide:off
        Effect.provide(NodeServices.layer)
      )
    );
  }
}
