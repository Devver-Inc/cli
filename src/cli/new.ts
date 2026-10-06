import { Console, Effect } from "effect";
import { Argument, Command } from "effect/cli";

const createServer = Command.make(
  "server",
  { name: Argument.String("name").pipe(Argument.withDefault("default")) },
  ({ name }) =>
    Effect.tryPromise(async () => {
      if (process.platform === "darwin") {
        const { create } = await import("./supervised-server-macos");
        return create(name);
      }
      if (process.platform === "linux") {
        const { create } = await import("./supervised-server");
        return create(name);
      }
      throw new Error(
        `Creating a supervised server is currently unsupported on ${process.platform}`
      );
    }).pipe(
      Effect.flatMap((url) =>
        Console.log(`Server ready at ${url}\ndevver attach ${url}`)
      )
    )
).pipe(
  Command.withDescription("Create a supervised named server without attaching")
);

export const newCommand = Command.make("new").pipe(
  Command.withSubcommands([createServer])
);
