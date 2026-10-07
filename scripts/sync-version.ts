#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const root = JSON.parse(readFileSync("package.json", "utf8"));
const check = process.argv.includes("--check");
const version = root.version;
const cliPath = "packages/cli/package.json";
const serverPath = "packages/server/package.json";
const cli = JSON.parse(readFileSync(cliPath, "utf8"));
const server = JSON.parse(readFileSync(serverPath, "utf8"));
const bin = `dist/servers/${version}/server.mjs`;

if (check) {
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  const bunLock = readFileSync("bun.lock", "utf8");
  if (
    cli.version !== version ||
    server.version !== version ||
    cli.bin?.["devver-server"] !== bin ||
    cli.dependencies?.["@devver/server"] !== undefined ||
    lock.version !== version ||
    lock.packages?.[""]?.version !== version ||
    lock.packages?.["packages/cli"]?.version !== version ||
    lock.packages?.["packages/cli"]?.bin?.["devver-server"] !== bin ||
    lock.packages?.["packages/server"]?.version !== version ||
    !bunLock.includes(`"@devver/cli": ["@devver/cli@workspace:packages/cli"]`)
  ) {
    throw new Error(
      "Workspace versions, bins or locks differ; run bun run sync:version"
    );
  }
} else {
  cli.version = version;
  cli.bin["devver-server"] = bin;
  server.version = version;
  writeFileSync(cliPath, `${JSON.stringify(cli, null, 2)}\n`);
  writeFileSync(serverPath, `${JSON.stringify(server, null, 2)}\n`);
  const installed = spawnSync("bun", ["install"], { stdio: "inherit" });
  if (installed.status !== 0) {
    process.exitCode = installed.status ?? 1;
  } else {
    const npmLock = spawnSync(
      "npm",
      [
        "install",
        "--package-lock-only",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
      ],
      { stdio: "inherit" }
    );
    if (npmLock.status !== 0) {
      process.exitCode = npmLock.status ?? 1;
    }
  }
}
