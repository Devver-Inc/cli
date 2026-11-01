import fs from "node:fs";
import path from "node:path";
import { cwd } from "node:process";

import { Data, Schema } from "effect";
import { dump, load } from "js-yaml";

import "./detectors";
import type { PrimaryStack, ProjectDetection } from "./detect";

const localInitSupport: Partial<
  Record<PrimaryStack["category"], { label: string; config: unknown }>
> = {
  static: { label: "static sites", config: { static: { directory: "." } } },
};

const supportedLabels = Object.values(localInitSupport)
  .map((entry) => entry.label)
  .join(", ");

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

const DevverConfigFileSchema = Schema.Union([
  CloudConfigFileSchema,
  StaticConfigFileSchema,
]);

export type ServiceConfig = typeof ServiceConfigSchema.Type;
export type DevverConfigFile = typeof DevverConfigFileSchema.Type;

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

export function writeConfigFile(
  detection: ProjectDetection,
  root?: string
): void {
  const targetDir = root ?? cwd();
  const configPath = path.join(targetDir, ".devver.yaml");

  if (fs.existsSync(configPath)) {
    readConfigFile(targetDir);
    return;
  }

  const [project] = detection.projects;
  if (detection.projects.length !== 1 || project?.root !== ".") {
    throw new InitAbortError({
      message:
        "This workspace has multiple projects. Devver can't create a local config for them yet. No config was written.",
    });
  }

  const supported = localInitSupport[project.stack.category];
  if (supported === undefined) {
    const found =
      project.stack.framework === null
        ? "Devver didn't recognize an app it can configure here."
        : `Devver init can't configure ${project.stack.framework} yet.`;
    throw new InitAbortError({
      message: `${found} It currently supports ${supportedLabels}. Add a verified .devver.yaml to deploy anything else. No config was written.`,
    });
  }
  fs.writeFileSync(configPath, dump(supported.config, { noRefs: true }), {
    flag: "wx",
  });
  console.log(`\nConfig written to ${configPath}`);
}
