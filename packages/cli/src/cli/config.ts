import { Console, Data, Effect, Schema } from "effect";
import { Argument, Command } from "effect/cli";

import "../config/detectors";
import { readConfigFile, writeConfigFile } from "../config";
import { getConfigValue, readConfig, unsetConfigValue } from "../config/api";
import { detectProject } from "../config/detect";

const configKey = Argument.String("key").pipe(
  Argument.withSchema(Schema.NonEmptyString)
);

/**
 * A stored `api-url` no longer selects a target: commands need an attached
 * local server or an explicit `--api-url`. Legacy values still decode and can
 * be read or cleared, but storing one must never look like it took effect.
 */
const INACTIVE_API_URL =
  "Setting 'api-url' no longer selects a target. Run 'devver attach <url>' for a local server, or pass --api-url to a single command for the cloud.";
const INACTIVE = "(inactive)";

class ConfigCommandError extends Data.TaggedError("ConfigCommandError")<{
  message: string;
}> {}

const get = Command.make("get", { key: configKey }, ({ key }) =>
  // Effect's never-success branch must return to preserve key narrowing.
  // oxlint-disable-next-line typescript/consistent-return
  Effect.gen(function* () {
    if (key !== "api-url") {
      return yield* Effect.fail(
        new ConfigCommandError({ message: `Invalid config key '${key}'` })
      );
    }
    const value = yield* Effect.tryPromise(async () => getConfigValue(key));
    yield* Console.log(
      value === undefined
        ? `  Config key '${key}' is not set`
        : `${value} ${INACTIVE}`
    );
  })
);

const set = Command.make(
  "set",
  { key: configKey, value: Argument.String("value") },
  ({ key }) =>
    Effect.fail(
      new ConfigCommandError({
        message:
          key === "api-url" ? INACTIVE_API_URL : `Invalid config key '${key}'`,
      })
    )
);

const unset = Command.make("unset", { key: configKey }, ({ key }) =>
  // oxlint-disable-next-line typescript/consistent-return
  Effect.gen(function* () {
    if (key !== "api-url") {
      return yield* Effect.fail(
        new ConfigCommandError({ message: `Invalid config key '${key}'` })
      );
    }
    yield* Effect.tryPromise(async () => unsetConfigValue(key));
    yield* Console.log(`✓ Unset ${key}`);
  })
);

const list = Command.make("list", {}, () =>
  Effect.tryPromise(readConfig).pipe(
    Effect.flatMap((config) => {
      const entries = Object.entries(config);
      const target = config["local-target"];
      return entries.length === 0
        ? Console.log(
            "  No config values set. Attach a local server or use an explicit --api-url for cloud commands."
          )
        : Effect.forEach(
            entries,
            ([entryKey]) =>
              entryKey === "local-target" && target !== undefined
                ? Console.log(`  ${entryKey} = ${target.name} at ${target.url}`)
                : Console.log(
                    `  ${entryKey} = ${config["api-url"] ?? ""} ${INACTIVE}`
                  ),
            {
              discard: true,
            }
          );
    })
  )
);

export const init = Command.make("init", {}, () =>
  Effect.gen(function* () {
    if ((yield* Effect.try(() => readConfigFile())) !== null) {
      yield* Console.log("✓ Config file already exists (.devver.yaml)");
      return;
    }
    const detection = yield* Effect.tryPromise(async () => detectProject());
    yield* Console.log("\nProject detection:");
    if (detection.results.length === 0) {
      yield* Console.log("  No frameworks detected");
    } else {
      for (const result of detection.results) {
        yield* Console.log(`  ✓ ${result.detected.displayName}`);
      }
    }
    yield* Effect.try(() => {
      writeConfigFile(detection);
    });
    if (detection.results.length === 0) {
      yield* Console.log("  (config file created anyway)");
    }
  })
);

export const config = Command.make("config").pipe(
  Command.withDescription("Manage CLI configuration"),
  Command.withSubcommands([get, set, unset, list])
);
