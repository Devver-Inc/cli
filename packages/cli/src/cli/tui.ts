import { Effect, Option } from "effect";
import { Argument, Command } from "effect/cli";
import pkg from "../../../../package.json" with { type: "json" };
import { versionLine } from "./version";

const project = Argument.String("project").pipe(Argument.optional);

export const launchTui = (directory?: string) =>
  Effect.tryPromise(async () => {
    const { tui } = await import("../cmd/tui/app");
    await tui({
      url: "",
      args: {},
      directory,
      version: versionLine(pkg.version),
    });
  });

export const tui = Command.make("tui", { project }, ({ project }) =>
  launchTui(Option.getOrUndefined(project))
).pipe(Command.withDescription("Start the terminal UI"));
