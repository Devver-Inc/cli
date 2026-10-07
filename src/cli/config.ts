import { Console, Effect, Schema } from "effect";
import { Argument, Command } from "effect/cli";
import "../config/detectors";
import { readConfigFile, writeConfigFile } from "../config";
import { getConfigValue, readConfig, unsetConfigValue } from "../config/api";
import { detectProject } from "../config/detect";

const key = Argument.String("key").pipe(
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

const get = Command.make("get", { key }, ({ key }) =>
  key === "api-url"
    ? Effect.tryPromise(() => getConfigValue(key)).pipe(
        Effect.flatMap((value) =>
          Console.log(
            value === undefined
              ? `  Config key '${key}' is not set`
              : `${value} ${INACTIVE}`
          )
        )
      )
    : Effect.fail(new Error(`Invalid config key '${key}'`))
);

const set = Command.make(
  "set",
  { key, value: Argument.String("value") },
  ({ key }) =>
    Effect.fail(
      new Error(
        key === "api-url" ? INACTIVE_API_URL : `Invalid config key '${key}'`
      )
    )
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
            "  No config values set. Attach a local server or use an explicit --api-url for cloud commands."
          )
        : Effect.forEach(
            entries,
            ([key, value]) =>
              Console.log(
                key === "local-target" && target
                  ? `  ${key} = ${target.name} at ${target.url}`
                  : `  ${key} = ${value} ${INACTIVE}`
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
