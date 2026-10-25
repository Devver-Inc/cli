import { Command, Flag } from "effect/cli";

export const root = Command.make("devver", {
  update: Flag.Boolean("update").pipe(Flag.withDefault(false)),
}).pipe(
  Command.withDescription("Deploy and try your app in seconds"),
  Command.withSharedFlags({
    apiUrl: Flag.String("api-url").pipe(Flag.optional),
  })
);
