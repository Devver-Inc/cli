import { Console, Effect, Schema } from "effect";
import { Argument, Command } from "effect/cli";
import "../config/detectors";
import { readConfigFile, writeConfigFile } from "../config";
import {
  getConfigValue,
  readConfig,
  setConfigValue,
  unsetConfigValue,
} from "../config/api";
import { detectProject } from "../config/detect";

const key = Argument.String("key").pipe(
  Argument.withSchema(Schema.NonEmptyString)
);

const get = Command.make("get", { key }, ({ key }) =>
  key === "api-url"
    ? Effect.tryPromise(() => getConfigValue(key)).pipe(
        Effect.flatMap((value) =>
          Console.log(value ?? `  Config key '${key}' is not set`)
        )
      )
    : Effect.fail(new Error(`Invalid config key '${key}'`))
);

const set = Command.make(
  "set",
  { key, value: Argument.String("value") },
  ({ key, value }) =>
    key === "api-url"
      ? Effect.tryPromise(() => setConfigValue(key, value)).pipe(
          Effect.flatMap(() => Console.log(`✓ Set ${key} = ${value}`))
        )
      : Effect.fail(new Error(`Invalid config key '${key}'`))
);

const unset = Command.make("unset", { key }, ({ key }) =>
  key === "api-url"
    ? Effect.tryPromise(() => unsetConfigValue(key)).pipe(
        Effect.flatMap(() => Console.log(`✓ Unset ${key}`))
      )
    : Effect.fail(new Error(`Invalid config key '${key}'`))
);

const list = Command.make("list", {}, () =>
  Effect.tryPromise(readConfig).pipe(
    Effect.flatMap((config) => {
      const entries = Object.entries(config);
      const target = config["local-target"];
      return entries.length === 0
        ? Console.log(
            "  No config values set. Using defaults:\n    api-url: https://app.devver.app/api/v1"
          )
        : Effect.forEach(
            entries,
            ([key, value]) =>
              Console.log(
                key === "local-target" && target
                  ? `  ${key} = ${target.name} at ${target.url}`
                  : `  ${key} = ${value}`
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
    if (yield* Effect.try(() => readConfigFile())) {
      yield* Console.log("✓ Config file already exists (.devver.yaml)");
      return;
    }
    const detection = yield* Effect.tryPromise(() => detectProject());
    yield* Console.log("\nProject detection:");
    if (detection.results.length === 0) {
      yield* Console.log("  No frameworks detected");
    } else {
      for (const result of detection.results) {
        yield* Console.log(`  ✓ ${result.detected.displayName}`);
      }
    }
    yield* Effect.try(() => writeConfigFile(detection));
    if (detection.results.length === 0) {
      yield* Console.log("  (config file created anyway)");
    }
  })
);

export const config = Command.make("config").pipe(
  Command.withDescription("Manage CLI configuration"),
  Command.withSubcommands([get, set, unset, list])
);
