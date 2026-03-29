import fs from "node:fs";
import path from "node:path";
import { cwd } from "node:process";
import yaml from "js-yaml";

import type { ProjectDetection } from "./detect";

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

  let serviceName = "web";
  if (isWebFramework) {
    serviceName = "web";
  } else if (isApiFramework) {
    serviceName = "api";
  }

  const config: Record<string, unknown> = {
    project: path.basename(targetDir),
    services: {} as Record<string, unknown>,
  };
  const detectedTypes = detection.results.map((r) => r.detected.name);
  const hasMongo =
    detectedTypes.includes("mongoose") || detectedTypes.includes("mongodb");
  if (hasMongo) {
    config.databases = {
      mongodb: {
        type: "mongodb",
      },
    };
  }
  const serviceConfig: Record<string, unknown> = {
    root: ".",
    build: "bun run build",
    start: "bun run start",
  };
  if (serviceName === "api" && hasMongo) {
    serviceConfig.depends = ["mongodb"];
  }
  config.services = {
    [serviceName]: serviceConfig,
  };
  fs.writeFileSync(configPath, yaml.dump(config));
  console.log(`\nConfig written to ${configPath}`);
}

export const DevverConfig = { writeConfigFile };
