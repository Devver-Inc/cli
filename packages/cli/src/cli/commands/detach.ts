import { Console, Effect } from "effect";
import { Command } from "effect/cli";

import { readConfig, writeConfig } from "../../infra/config/api";

export const detach = Command.make("detach", {}, () =>
  Effect.tryPromise(async () => {
    const {
      "local-target": _local,
      "cloud-target": _cloud,
      ...config
    } = await readConfig();
    await writeConfig(config);
  }).pipe(Effect.flatMap(() => Console.log("Detached target")))
).pipe(Command.withDescription("Clear the selected target"));
