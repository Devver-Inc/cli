import { Effect, Option } from "effect";
import { Argument, Command } from "effect/cli";

import pkg from "../../../../package.json" with { type: "json" };
import { versionLine } from "./version";

const projectArgument = Argument.String("project").pipe(Argument.optional);

export const launchTui = (directory?: string) =>
  Effect.tryPromise(async () => {
    const { tui } = await import("../cmd/tui/app");
    const options = { url: "", args: {}, version: versionLine(pkg.version) };
    await tui(directory === undefined ? options : { ...options, directory });
  });

export const tui = Command.make(
  "tui",
  { project: projectArgument },
  ({ project }) => launchTui(Option.getOrUndefined(project))
).pipe(Command.withDescription("Start the terminal UI"));
