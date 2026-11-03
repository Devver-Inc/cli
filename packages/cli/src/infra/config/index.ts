import fs from "node:fs";
import path from "node:path";
import { cwd } from "node:process";

import { Data, Schema } from "effect";
import { dump, load } from "js-yaml";

import type { ProjectDetection } from "./detect";

const CommandSchema = Schema.String.pipe(
  Schema.check(
    Schema.isNonEmpty(),
    Schema.isTrimmed(),
    Schema.isPattern(/\S/u),
    Schema.isPattern(/^[^"'`$;&|<>(){}\\\r\n]+$/u)
  )
);
const RunCommandSchema = Schema.String.pipe(
  Schema.check(
    Schema.isNonEmpty(),
    Schema.isTrimmed(),
    Schema.isPattern(/\S/u),
    Schema.isPattern(/^(?:[^"'`$;&|<>(){}\\\r\n]|\$\{PORT\})+$/u)
  )
);

const ServiceConfigSchema = Schema.Struct({
  root: Schema.optional(Schema.String),
  install: Schema.optional(Schema.String),
  skipInstall: Schema.optional(Schema.Boolean),
  build: Schema.String,
  start: Schema.String,
  depends: Schema.optional(Schema.Array(Schema.String)),
});

const CloudConfigFileSchema = Schema.Struct({
  project: Schema.String,
  services: Schema.Struct({
    web: Schema.optional(ServiceConfigSchema),
    api: Schema.optional(ServiceConfigSchema),
  }),
  databases: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

const StaticConfigFileSchema = Schema.Struct({
  static: Schema.Struct({
    directory: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
  }),
});

const ProcessConfigFileSchema = Schema.Struct({
  process: Schema.Struct({
    install: Schema.optional(CommandSchema),
    build: Schema.optional(CommandSchema),
    run: RunCommandSchema,
  }),
});

const DevverConfigFileSchema = Schema.Union([
  CloudConfigFileSchema,
  StaticConfigFileSchema,
  ProcessConfigFileSchema,
]);

export type ServiceConfig = typeof ServiceConfigSchema.Type;
export type DevverConfigFile = typeof DevverConfigFileSchema.Type;
export type LocalConfigFile =
  | typeof StaticConfigFileSchema.Type
  | typeof ProcessConfigFileSchema.Type;

interface ProcessRecipeDraft {
  readonly process: { readonly run: string };
}

type LocalConfigSuggestion =
  | typeof StaticConfigFileSchema.Type
  | ProcessRecipeDraft;

export class InitAbortError extends Data.TaggedError("InitAbortError")<{
  message: string;
}> {}

const decodeDevverConfigFile = Schema.decodeUnknownSync(DevverConfigFileSchema);

export function readConfigFile(root?: string): DevverConfigFile | null {
  const targetDir = root ?? cwd();
  const configPath = path.join(targetDir, ".devver.yaml");

  if (!fs.existsSync(configPath)) {
    return null;
  }

  const content = fs.readFileSync(configPath, "utf-8");
  let parsed: unknown;
  try {
    parsed = load(content);
  } catch {
    throw new Error(`Invalid YAML in ${configPath}`);
  }
  try {
    return decodeDevverConfigFile(parsed);
  } catch {
    throw new Error(`Invalid devver config in ${configPath}`);
  }
}

export function suggestedLocalConfig(
  detection: ProjectDetection
): LocalConfigSuggestion {
  const [project] = detection.projects;
  if (detection.projects.length !== 1 || project?.root !== ".") {
    throw new InitAbortError({
      message:
        "This workspace has multiple projects. Devver can't create a local config for them yet. No config was written.",
    });
  }
  if (project.stack.category === "static") {
    return { static: { directory: "." } };
  }
  const { packageManager, scripts } = project;
  if (packageManager === undefined || project.stack.framework === null) {
    throw new InitAbortError({
      message:
        "Devver couldn't derive a complete process recipe from this project. Add a reviewed .devver.yaml manually. No config was written.",
    });
  }
  return {
    process: {
      run: scripts?.dev === undefined ? "" : `${packageManager} run dev`,
    },
  };
}

export function writeConfigFile(
  config: LocalConfigFile | ProjectDetection,
  root?: string
): void {
  const targetDir = root ?? cwd();
  const configPath = path.join(targetDir, ".devver.yaml");

  if (fs.existsSync(configPath)) {
    readConfigFile(targetDir);
    return;
  }
  const localConfig =
    "projects" in config ? suggestedLocalConfig(config) : config;
  if ("process" in localConfig) {
    if (localConfig.process.run.trim() === "") {
      throw new InitAbortError({
        message: "A run command is required. No config was written.",
      });
    }
    try {
      Schema.decodeSync(ProcessConfigFileSchema)(localConfig);
    } catch {
      throw new InitAbortError({
        message:
          "Process commands must be plain executable arguments without shell operators or quoting. No config was written.",
      });
    }
  }
  fs.writeFileSync(configPath, dump(localConfig, { noRefs: true }), {
    flag: "wx",
  });
  console.log(`\nConfig written to ${configPath}`);
}
