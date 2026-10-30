import fs from "node:fs";
import path from "node:path";
import { cwd } from "node:process";

import { Schema } from "effect";
import { dump, load } from "js-yaml";

import "./detectors";
import type { ProjectDetection } from "./detect";

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
    throw new Error(
      "Cannot generate a config for a workspace with nested projects. Add a verified .devver.yaml manually."
    );
  }

  if (project.stack.category !== "static") {
    throw new Error(
      `Cannot generate a deployable config for ${project.stack.framework ?? "this project"}. Only a single root static source is supported by local init; add a verified .devver.yaml for other workloads.`
    );
  }
  fs.writeFileSync(
    configPath,
    dump({ static: { directory: "." } }, { noRefs: true }),
    { flag: "wx" }
  );
  console.log(`\nConfig written to ${configPath}`);
}
