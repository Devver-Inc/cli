import { Console, Data, Effect, Runtime } from "effect";
import { Argument, Command } from "effect/cli";

import { attachTarget } from "./local-server";

const MAX_CAUSE_DEPTH = 5;

export class ServerCreateError extends Data.TaggedError("ServerCreateError")<{
  message: string;
}> {
  [Runtime.errorReported] = true;
}

// Only `Error` messages are read from the chain; an arbitrary thrown value can
// carry credentials in its properties.
function causeMessages(error: Error): string {
  const messages: string[] = [];
  let current: Error | undefined = error;
  for (
    let depth = 0;
    depth < MAX_CAUSE_DEPTH && current !== undefined;
    depth += 1
  ) {
    messages.push(current.message);
    current = current.cause instanceof Error ? current.cause : undefined;
  }
  return messages.join("\n");
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
              ? causeMessages(error)
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
