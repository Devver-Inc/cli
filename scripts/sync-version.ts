#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

import { Schema } from "effect";

const decodeDocument = Schema.decodeUnknownSync(
  Schema.Record(Schema.String, Schema.Unknown)
);
const decodeVersion = Schema.decodeUnknownSync(
  Schema.Struct({ version: Schema.String })
);
const decodeCli = Schema.decodeUnknownSync(
  Schema.Struct({
    version: Schema.String,
    bin: Schema.Record(Schema.String, Schema.String),
    dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  })
);
const root = decodeVersion(JSON.parse(readFileSync("package.json", "utf-8")));
const check = process.argv.includes("--check");
const { version } = root;
const cliPath = "packages/cli/package.json";
const serverPath = "packages/server/package.json";
const cliDocument = decodeDocument(JSON.parse(readFileSync(cliPath, "utf-8")));
const cli = decodeCli(cliDocument);
const serverDocument = decodeDocument(
  JSON.parse(readFileSync(serverPath, "utf-8"))
);
const server = decodeVersion(serverDocument);
const bin = `dist/servers/${version}/server.mjs`;

if (check) {
  const lock = Schema.decodeUnknownSync(
    Schema.Struct({
      version: Schema.String,
      packages: Schema.Struct({
        "": Schema.Struct({ version: Schema.String }),
        "packages/cli": Schema.Struct({
          version: Schema.String,
          bin: Schema.Struct({ "devver-server": Schema.String }),
        }),
        "packages/server": Schema.Struct({ version: Schema.String }),
      }),
    })
  )(JSON.parse(readFileSync("package-lock.json", "utf-8")));
  const bunLock = Schema.decodeUnknownSync(
    Schema.Struct({
      workspaces: Schema.Struct({
        "packages/cli": Schema.Struct({
          version: Schema.String,
          bin: Schema.Struct({ "devver-server": Schema.String }),
        }),
        "packages/server": Schema.Struct({ version: Schema.String }),
      }),
      packages: Schema.Struct({
        "@devver/cli": Schema.Tuple([Schema.String]),
        "@devver/server": Schema.Tuple([Schema.String]),
      }),
    })
  )(Bun.JSONC.parse(readFileSync("bun.lock", "utf-8")));
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
    bunLock.workspaces?.["packages/cli"]?.version !== version ||
    bunLock.workspaces?.["packages/cli"]?.bin?.["devver-server"] !== bin ||
    bunLock.workspaces?.["packages/server"]?.version !== version ||
    bunLock.packages?.["@devver/cli"]?.[0] !==
      "@devver/cli@workspace:packages/cli" ||
    bunLock.packages?.["@devver/server"]?.[0] !==
      "@devver/server@workspace:packages/server"
  ) {
    throw new Error(
      "Workspace versions, bins or locks differ; run bun run sync:version"
    );
  }
} else {
  writeFileSync(
    cliPath,
    `${JSON.stringify({ ...cliDocument, version, bin: { ...cli.bin, "devver-server": bin } }, null, 2)}\n`
  );
  writeFileSync(
    serverPath,
    `${JSON.stringify({ ...serverDocument, version }, null, 2)}\n`
  );
  const installed = spawnSync("bun", ["install"], { stdio: "inherit" });
  if (installed.status === 0) {
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
  } else {
    process.exitCode = installed.status ?? 1;
  }
}
