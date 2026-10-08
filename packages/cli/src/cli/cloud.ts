import { Console, Effect } from "effect";
import { Command } from "effect/cli";

import { CLOUD_API_URL, readConfig, writeConfig } from "../config/api";

export const cloud = Command.make("cloud", {}, () =>
  Effect.tryPromise(async () => {
    const { "local-target": _removed, ...config } = await readConfig();
    await writeConfig({ ...config, "cloud-target": true });
  }).pipe(
    Effect.flatMap(() => Console.log(`Selected cloud at ${CLOUD_API_URL}`))
  )
).pipe(Command.withDescription("Select the official Devver cloud API"));
