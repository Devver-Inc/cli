import { Effect, Option } from "effect";
import { Argument, Command } from "effect/cli";

const project = Argument.String("project").pipe(Argument.optional);

export const launchTui = (directory?: string) =>
  Effect.tryPromise(async () => {
    const { tui } = await import("../cmd/tui/app");
    await tui({ url: "", args: {}, directory });
  });

export const tui = Command.make("tui", { project }, ({ project }) =>
  launchTui(Option.getOrUndefined(project))
).pipe(Command.withDescription("Start the terminal UI"));
