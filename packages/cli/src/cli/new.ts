import { Console, Data, Effect, Runtime } from "effect";
import { Argument, Command } from "effect/cli";

import { attachTarget } from "./local-server";

export class ServerCreateError extends Data.TaggedError("ServerCreateError")<{
  message: string;
}> {
  [Runtime.errorReported] = true;
}

const createServer = Command.make(
  "server",
  { name: Argument.String("name").pipe(Argument.withDefault("default")) },
  ({ name }) =>
    Effect.tryPromise({
      try: async () => {
        if (process.platform === "darwin") {
          const { create } = await import("./supervised-server-macos");
          return await create(name);
        }
        if (process.platform === "linux") {
          const { create } = await import("./supervised-server-linux");
          return await create(name);
        }
        if (process.platform === "win32") {
          const { create } = await import("./windows-supervised-server");
          return await create(name);
        }
        throw new Error(
          `Creating a supervised server is currently unsupported on ${process.platform}`
        );
      },
      catch: (error) =>
        new ServerCreateError({
          message:
            error instanceof Error
              ? error.message
              : "Creating the server failed",
        }),
    }).pipe(
      Effect.tap((url) => attachTarget(url)),
      Effect.flatMap((url) =>
        Console.log(
          `Server ready and attached at ${url}\nDeploy from any Git checkout with 'devver deploy'.`
        )
      )
    )
).pipe(
  Command.withDescription("Create a supervised named server and attach to it")
);

export const newCommand = Command.make("new").pipe(
  Command.withSubcommands([createServer])
);
