#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Schema } from "effect";

const root = Schema.decodeUnknownSync(
  Schema.Struct({ version: Schema.String })
)(JSON.parse(readFileSync("package.json", "utf-8")));
if (!/^\d+\.\d+\.\d+$/u.test(root.version)) {
  throw new Error("The development baseline must be a stable version");
}
const [major, minor, patch] = Schema.decodeUnknownSync(
  Schema.Tuple([
    Schema.FiniteFromString,
    Schema.FiniteFromString,
    Schema.FiniteFromString,
  ])
)(root.version.split("."));
const hasChangesets = readdirSync(".changeset").some(
  (file) => file.endsWith(".md") && file !== "README.md"
);
if (hasChangesets) {
  const directory = mkdtempSync(join(tmpdir(), "devver-version-"));
  try {
    const output = join(directory, "status.json");
    const status = spawnSync(
      "bunx",
      ["changeset", "status", "--output", output],
      { stdio: "pipe" }
    );
    if (status.status !== 0) {
      throw new Error("Cannot calculate the pending release version");
    }
    const result = Schema.decodeUnknownSync(
      Schema.Struct({
        releases: Schema.Array(
          Schema.Struct({ name: Schema.String, newVersion: Schema.String })
        ),
      })
    )(JSON.parse(readFileSync(output, "utf-8")));
    const cli = result.releases.find(
      (release) => release.name === "@devver/cli"
    );
    if (cli === undefined && result.releases.length > 0) {
      throw new Error("Changesets do not describe a CLI release");
    }
    console.info(
      cli?.newVersion ??
        (process.argv.includes("--local")
          ? root.version
          : `${major}.${minor}.${patch + 1}`)
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
} else {
  console.info(
    process.argv.includes("--local")
      ? root.version
      : `${major}.${minor}.${patch + 1}`
  );
}
