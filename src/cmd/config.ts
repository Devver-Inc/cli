import { cmd } from "./cmd";
import "../config/detectors";
import {
  readConfigFile,
  writeConfigFile,
} from "../config";
import { detectProject } from "../config/detect";
import {
  readConfig as readCliConfig,
  setConfigValue,
  unsetConfigValue,
} from "../config/api";

export const InitConfigCommand = cmd({
  command: "init",
  describe: "init devver config in current directory",
  async handler() {
    const existing = readConfigFile();
    if (existing) {
      console.log("✓ Config file already exists (.devver.yaml)");
      return;
    }

    const detection = await detectProject();

    console.log("\nProject detection:");
    if (detection.results.length === 0) {
      console.log("  No frameworks detected");
    } else {
      for (const result of detection.results) {
        console.log(`  ✓ ${result.detected.displayName}`);
      }
    }

    if (detection.results.length > 0) {
      writeConfigFile(detection);
    } else {
      writeConfigFile(detection);
      console.log("  (config file created anyway)");
    }
  },
});

const ConfigGetCommand = cmd({
  command: "get <key>",
  describe: "Get a config value",
  builder: (yargs) =>
    yargs.positional("key", {
      type: "string",
      demandOption: true,
      describe: "Config key (e.g. api-url)",
    }),
  async handler(args) {
    const config = await readCliConfig();
    const value = (config as Record<string, unknown>)[args.key];
    if (value === undefined) {
      console.log(`  Config key '${args.key}' is not set`);
    } else {
      console.log(value);
    }
  },
});

const ConfigSetCommand = cmd({
  command: "set <key> <value>",
  describe: "Set a config value",
  builder: (yargs) =>
    yargs
      .positional("key", {
        type: "string",
        demandOption: true,
        describe: "Config key (e.g. api-url)",
      })
      .positional("value", {
        type: "string",
        demandOption: true,
        describe: "Config value",
      }),
  async handler(args) {
    const validKeys = ["api-url"] as const;
    const key = args.key as string;

    if (!validKeys.includes(key as (typeof validKeys)[number])) {
      console.error(
        `✗ Invalid config key '${key}'. Valid keys: ${validKeys.join(", ")}`
      );
      process.exit(1);
    }

    await setConfigValue(
      key as (typeof validKeys)[number],
      args.value as string
    );
    console.log(`✓ Set ${key} = ${args.value}`);
  },
});


const ConfigUnsetCommand = cmd({
  command: "unset <key>",
  describe: "Remove a config value",
  builder: (yargs) =>
    yargs.positional("key", {
      type: "string",
      demandOption: true,
      describe: "Config key (e.g. api-url)",
    }),
  async handler(args) {
    await unsetConfigValue(args.key as "api-url");
    console.log(`✓ Unset ${args.key}`);
  },
});

const ConfigListCommand = cmd({
  command: "list",
  describe: "List all config values",
  async handler() {
    const config = await readCliConfig();
    const entries = Object.entries(config);

    if (entries.length === 0) {
      console.log("  No config values set. Using defaults:");
      console.log("    api-url: https://app.devver.app/api/v1");
      return;
    }

    for (const [key, value] of entries) {
      console.log(`  ${key} = ${value}`);
    }
  },
});


export const ConfigCommand = cmd({
  command: "config",
  describe: "Manage CLI configuration",
  builder: (yargs) =>
    yargs
      .command(ConfigGetCommand)
      .command(ConfigSetCommand)
      .command(ConfigUnsetCommand)
      .command(ConfigListCommand)
      .demandCommand(),
  async handler() {
    await new Promise(() => ({}));
  },
});
