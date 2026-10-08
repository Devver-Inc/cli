import fs from "node:fs";
import path from "node:path";
import { cwd } from "node:process";

import { Schema } from "effect";
import { dump, load } from "js-yaml";

import { detectProject } from "./detect";
import type { ProjectDetection } from "./detect";

const regex = /\r?\n/u;

const ServiceConfigSchema = Schema.Struct({
  root: Schema.optional(Schema.String),
  install: Schema.optional(Schema.String),
  skipInstall: Schema.optional(Schema.Boolean),
  build: Schema.String,
  start: Schema.String,
  depends: Schema.optional(Schema.Array(Schema.String)),
});

const DevverConfigFileSchema = Schema.Struct({
  project: Schema.String,
  services: Schema.Struct({
    web: Schema.optional(ServiceConfigSchema),
    api: Schema.optional(ServiceConfigSchema),
  }),
  databases: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

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

  const isWebFramework = detection.results.find(
    (r) => r.detected.name === "react" || r.detected.name === "next"
  );
  const isApiFramework = detection.results.find(
    (r) => r.detected.name === "nestjs" || r.detected.name === "express"
  );

  const serviceName =
    isWebFramework === undefined && isApiFramework !== undefined
      ? "api"
      : "web";

  const detectedTypes = new Set(detection.results.map((r) => r.detected.name));
  const hasMongo =
    detectedTypes.has("mongoose") || detectedTypes.has("mongodb");
  const config = {
    project: path.basename(targetDir),
    services: {
      [serviceName]: {
        root: ".",
        build: "bun run build",
        start: "bun run start",
        depends: serviceName === "api" && hasMongo ? ["mongodb"] : undefined,
      },
    },
    databases: hasMongo ? { mongodb: { type: "mongodb" } } : undefined,
    env: { NODE_ENV: "production" },
  };
  fs.writeFileSync(configPath, dump(config));
  console.log(`\nConfig written to ${configPath}`);
}

export function ensureGitignore(targetDir?: string): void {
  const dir = targetDir ?? cwd();
  const gitignorePath = path.join(dir, ".gitignore");

  const ENTRY = ".devver/";

  let content = "";
  if (fs.existsSync(gitignorePath)) {
    content = fs.readFileSync(gitignorePath, "utf-8");
    // Already present — nothing to do
    const lines = content.split(regex);
    if (lines.some((line) => line.trim() === ENTRY)) {
      return;
    }
    // Ensure trailing newline before appending
    if (content !== "" && !content.endsWith("\n")) {
      content += "\n";
    }
  }

  const block = [
    "",
    "# devver local secrets (deployment-specific env vars)",
    ENTRY,
  ].join("\n");

  fs.writeFileSync(gitignorePath, `${content}${block}\n`);
  console.log(`  Added \`${ENTRY}\` to .gitignore`);
}

export async function checkForConfigFile() {
  const targetDir = cwd();
  const configPath = path.join(targetDir, ".devver.yaml");
  if (!fs.existsSync(configPath)) {
    const detection = await detectProject();
    console.log("No Config file found, generating...");
    if (detection.results.length === 0) {
      console.log("  No frameworks detected");
    } else {
      for (const result of detection.results) {
        console.log(`  ✓ ${result.detected.displayName}`);
      }
    }
    writeConfigFile(detection);
  }

  ensureGitignore(targetDir);
}

export const DevverConfig = {
  writeConfigFile,
  readConfigFile,
  checkForConfigFile,
};
