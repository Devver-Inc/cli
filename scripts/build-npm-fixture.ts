#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} failed while building the local npm fixture`);
  }
}

console.warn(
  "Local test fixture only: the second platform contains the host executable. Do not publish this package."
);
const directory = mkdtempSync(join(tmpdir(), "devver-npm-fixture-"));
try {
  run("bun", ["run", "build"]);
  for (const target of ["aarch64-apple-darwin", "x86_64-unknown-linux-gnu"]) {
    const filename = `devver-cli-${target}.tar.gz`;
    const archive = join(directory, filename);
    run("tar", ["czf", archive, "devver", "servers"]);
    const checksum = createHash("sha256")
      .update(readFileSync(archive))
      .digest("hex");
    writeFileSync(`${archive}.sha256`, `${checksum}  ${filename}\n`);
  }
  const assemble = spawnSync("bun", ["run", "build:npm", directory], {
    stdio: "inherit",
    env: { ...process.env, DEVVER_TEST_ONLY_NPM_FIXTURE: "1" },
  });
  if (assemble.status !== 0) {
    throw new Error("Could not assemble the local npm fixture");
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
