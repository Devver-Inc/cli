import { Console, Data, Effect, Result, Runtime } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import {
  listInstances,
  readInstanceService,
} from "../../../../server/identity";
import { listLocalDeployments } from "../../infra/api/local-deploy.requests";
import { saveLocalDeployments } from "../../infra/completion/cache";
import { readConfig } from "../../infra/config/api";
import type { CliConfig } from "../../infra/config/api";
import {
  removeInstance,
  stopInstance,
} from "../../infra/local-server/supervised-server-lifecycle";
import { identityAt } from "../../infra/local-server/target";
import { withLocalApi } from "../api";
import { Prompt } from "../prompts";

class ServerLifecycleError extends Data.TaggedError("ServerLifecycleError")<{
  message: string;
}> {
  [Runtime.errorReported] = true;
}

const status = Command.make("status", {}, () =>
  Effect.gen(function* () {
    const config: CliConfig = yield* Effect.tryPromise(readConfig);
    const target = config["local-target"];
    if (target === undefined) {
      yield* Console.log("No server attached");
    } else {
      const current = yield* Effect.result(identityAt(target.url));
      const reachable =
        Result.isSuccess(current) &&
        current.success.instanceId === target.instanceId &&
        current.success.name === target.name;
      yield* Console.log(
        `${target.name} (${target.instanceId}) at ${target.url} — version ${target.serverVersion}: ${reachable ? "reachable" : "unreachable"}`
      );
      if (reachable) {
        const deployments = yield* withLocalApi(
          target,
          listLocalDeployments
        ).pipe(
          Effect.catchTag("ApiError", (error) =>
            error.status === 404 || error.status === 405
              ? Effect.succeed(null)
              : Effect.fail(error)
          )
        );
        if (deployments === null) {
          yield* Console.log("  Deployment status unavailable on this server");
        } else {
          yield* Effect.tryPromise(async () =>
            saveLocalDeployments(target.instanceId, deployments)
          ).pipe(Effect.ignore);
          for (const deployment of deployments) {
            if (deployment.status === "degraded") {
              yield* Console.log(
                `  ${deployment.deploymentId}: degraded (${deployment.stage ?? "server"})`
              );
            }
          }
        }
      }
    }
  })
).pipe(
  Command.withDescription("Show the attached server and deployment status")
);

const instanceReachability = (
  url: string,
  name: string,
  instanceId: string,
  serverVersion: string
) =>
  Effect.gen(function* () {
    const current = yield* Effect.result(identityAt(url));
    if (Result.isFailure(current)) {
      return current.failure instanceof Error &&
        current.failure.message.startsWith("Incompatible server version")
        ? "incompatible"
        : "unreachable";
    }
    if (
      current.success.name !== name ||
      current.success.instanceId !== instanceId
    ) {
      return "mismatched identity";
    }
    return current.success.serverVersion === serverVersion
      ? "reachable"
      : "mismatched version";
  });

const list = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const config = yield* Effect.tryPromise(readConfig);
    const instances = yield* Effect.tryPromise(listInstances);
    if (instances.length === 0) {
      return yield* Console.log("No server instances found");
    }
    const lines: string[] = [];
    for (const instance of instances) {
      const service = yield* Effect.tryPromise(async () =>
        readInstanceService(instance.name)
      );
      const url = `http://127.0.0.1:${service.port}/api/v1`;
      const reachability = yield* instanceReachability(
        url,
        instance.name,
        instance.instanceId,
        service.serverVersion
      );
      const target = config["local-target"];
      const selected =
        target?.name === instance.name &&
        target.instanceId === instance.instanceId &&
        target.url === url
          ? " [selected]"
          : "";
      lines.push(
        `${instance.name} (${instance.instanceId}) at ${url} — version ${service.serverVersion}: ${reachability}${selected}`
      );
    }
    return yield* Console.log(lines.join("\n"));
  })
).pipe(Command.withDescription("List saved local server instances"));

const stop = Command.make(
  "stop",
  { name: Argument.String("name") },
  ({ name }) =>
    Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: async () => stopInstance(name),
        catch: (error) =>
          new ServerLifecycleError({
            message:
              error instanceof Error
                ? error.message
                : "Stopping the server failed",
          }),
      });
      yield* Console.log(
        `Stopped ${name}. Deployments and state are preserved; re-create the instance's process by hand or with a future 'devver server start'.`
      );
    })
).pipe(
  Command.withDescription(
    "Stop a supervised local server, preserving its state"
  )
);

const remove = Command.make(
  "remove",
  {
    name: Argument.String("name"),
    yes: Flag.Boolean("yes").pipe(Flag.withAlias("y"), Flag.withDefault(false)),
  },
  ({ name, yes }) =>
    Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: async () => await readInstanceService(name),
        catch: (error) =>
          new ServerLifecycleError({
            message:
              error instanceof Error
                ? error.message
                : `Instance '${name}' could not be read`,
          }),
      });
      if (!yes) {
        if (
          !process.stdin.isTTY ||
          !process.stdout.isTTY ||
          process.env.CI === "true"
        ) {
          return yield* new ServerLifecycleError({
            message:
              "--yes is required to remove a server without an interactive terminal",
          });
        }
        const confirm = yield* Prompt.select({
          message: `Remove ${name} and delete its deployments, history and state? This cannot be undone.`,
          options: Prompt.Questions.YNOpts,
        });
        if (confirm !== "Yes") {
          return yield* Console.log("Removal cancelled.");
        }
      }
      yield* Effect.tryPromise({
        try: async () => removeInstance(name),
        catch: (error) =>
          new ServerLifecycleError({
            message:
              error instanceof Error
                ? error.message
                : "Removing the server failed",
          }),
      });
      return yield* Console.log(`Removed ${name} and its state.`);
    })
).pipe(
  Command.withDescription(
    "Remove a supervised local server and delete its state"
  )
);

export const server = Command.make("server").pipe(
  Command.withDescription("Inspect local server instances"),
  Command.withSubcommands([status, list, stop, remove])
);
