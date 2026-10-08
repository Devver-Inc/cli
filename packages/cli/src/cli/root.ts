import { Command, Flag } from "effect/cli";

import { launchTui } from "./tui";

export const root = Command.make("devver", {}, () => launchTui()).pipe(
  Command.withDescription("Deploy and try your app in seconds"),
  Command.withSharedFlags({
    apiUrl: Flag.String("api-url").pipe(Flag.optional),
  })
);
