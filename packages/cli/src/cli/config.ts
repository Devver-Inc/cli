import { Console, Data, Effect, Schema } from "effect";
import { Argument, Command } from "effect/cli";

import {
  CLOUD_API_URL,
  getConfigValue,
  readConfig,
  unsetConfigValue,
} from "../config/api";

const configKey = Argument.String("key").pipe(
  Argument.withSchema(Schema.NonEmptyString)
);

const INACTIVE_API_URL =
  "Setting 'api-url' no longer selects a target. Run 'devver cloud' for the official cloud, 'devver attach <url>' for a local server, or pass --api-url for one command.";
const INACTIVE = "(inactive)";

class ConfigCommandError extends Data.TaggedError("ConfigCommandError")<{
  message: string;
}> {}

const invalidKey = (key: string) =>
  Effect.fail(
    new ConfigCommandError({ message: `Invalid config key '${key}'` })
  );

// oxlint-disable typescript/consistent-return -- Invalid keys return a never-succeeding Effect so subsequent code sees the validated key.
const get = Command.make("get", { key: configKey }, ({ key }) =>
  Effect.gen(function* () {
    if (key !== "api-url") {
      return yield* invalidKey(key);
    }
    const value = yield* Effect.tryPromise(async () => getConfigValue(key));
    yield* Console.log(
      value === undefined
        ? `  Config key '${key}' is not set`
        : `${value} ${INACTIVE}`
    );
  })
).pipe(Command.withDescription("Show a CLI configuration value"));

const set = Command.make(
  "set",
  { key: configKey, value: Argument.String("value") },
  ({ key }) =>
    key === "api-url"
      ? Effect.fail(new ConfigCommandError({ message: INACTIVE_API_URL }))
      : invalidKey(key)
).pipe(Command.withDescription("Set a CLI configuration value (unsupported)"));

const unset = Command.make("unset", { key: configKey }, ({ key }) =>
  Effect.gen(function* () {
    if (key !== "api-url") {
      return yield* invalidKey(key);
    }
    yield* Effect.tryPromise(async () => unsetConfigValue(key));
    yield* Console.log(`✓ Unset ${key}`);
  })
).pipe(Command.withDescription("Remove a CLI configuration value"));
// oxlint-enable typescript/consistent-return

const list = Command.make("list", {}, () =>
  Effect.tryPromise(readConfig).pipe(
    Effect.flatMap((config) => {
      const entries = Object.entries(config);
      const target = config["local-target"];
      return entries.length === 0
        ? Console.log(
            "  No target selected. Run 'devver cloud', attach a local server, or pass --api-url for one command."
          )
        : Effect.forEach(
            entries,
            ([entryKey]) => {
              if (entryKey === "local-target" && target !== undefined) {
                return Console.log(
                  `  ${entryKey} = ${target.name} at ${target.url}`
                );
              }
              if (entryKey === "cloud-target") {
                return Console.log(`  ${entryKey} = ${CLOUD_API_URL}`);
              }
              return Console.log(
                `  ${entryKey} = ${config["api-url"] ?? ""} ${INACTIVE}`
              );
            },
            {
              discard: true,
            }
          );
    })
  )
).pipe(Command.withDescription("List CLI configuration values"));

export const config = Command.make("config").pipe(
  Command.withDescription("Manage CLI configuration"),
  Command.withSubcommands([get, set, unset, list])
);
