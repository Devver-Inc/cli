import { Console, Effect } from "effect";
import { Argument, Command } from "effect/cli";

import { attachTarget } from "../local-server/target";

export const attach = Command.make(
  "attach",
  { url: Argument.String("url") },
  ({ url }) =>
    attachTarget(url).pipe(
      Effect.flatMap((target) =>
        Console.log(
          `Attached ${target.name} (${target.instanceId}) at ${target.url} — version ${target.serverVersion}`
        )
      )
    )
).pipe(Command.withDescription("Attach to a verified local server"));
