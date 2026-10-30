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
    optionalDependencies: Schema.Record(Schema.String, Schema.String),
  })
);
const root = decodeVersion(JSON.parse(readFileSync("package.json", "utf-8")));
const check = process.argv.includes("--check");
const { version } = root;
const cliPath = "packages/cli/package.json";
const serverPath = "packages/server/package.json";
const platforms = [
  { name: "@devver-inc/cli-darwin-arm64", home: "packages/cli-darwin-arm64" },
  { name: "@devver-inc/cli-linux-x64", home: "packages/cli-linux-x64" },
] as const;
const platformDocuments = platforms.map((platform) => ({
  ...platform,
  path: `${platform.home}/package.json`,
  document: decodeDocument(
    JSON.parse(readFileSync(`${platform.home}/package.json`, "utf-8"))
  ),
}));
const pins = Object.fromEntries(
  platforms.map((platform) => [platform.name, version])
);
const cliDocument = decodeDocument(JSON.parse(readFileSync(cliPath, "utf-8")));
const cli = decodeCli(cliDocument);
const serverDocument = decodeDocument(
  JSON.parse(readFileSync(serverPath, "utf-8"))
);
const server = decodeVersion(serverDocument);
const bin = "bin/devver-server";

const Workspace = Schema.Struct({ version: Schema.String });
const Pins = Schema.Record(Schema.String, Schema.String);

const workspaceOf = (name: string) =>
  name === "@devver/server"
    ? "packages/server"
    : `packages/${name.slice("@devver-inc/".length)}`;

const pinned = (declared: Record<string, string>) =>
  platforms.every((platform) => declared[platform.name] === version) &&
  Object.keys(declared).length === platforms.length;

if (check) {
  const lock = Schema.decodeUnknownSync(
    Schema.Struct({
      version: Schema.String,
      packages: Schema.Struct({
        "": Schema.Struct({ version: Schema.String }),
        "packages/cli": Schema.Struct({
          version: Schema.String,
          bin: Schema.Struct({ "devver-server": Schema.String }),
          optionalDependencies: Pins,
        }),
        "packages/cli-darwin-arm64": Workspace,
        "packages/cli-linux-x64": Workspace,
        "packages/server": Workspace,
      }),
    })
  )(JSON.parse(readFileSync("package-lock.json", "utf-8")));
  const bunLock = Schema.decodeUnknownSync(
    Schema.Struct({
      workspaces: Schema.Struct({
        "packages/cli": Schema.Struct({
          version: Schema.String,
          bin: Schema.Struct({ "devver-server": Schema.String }),
          optionalDependencies: Pins,
        }),
        "packages/cli-darwin-arm64": Workspace,
        "packages/cli-linux-x64": Workspace,
        "packages/server": Workspace,
      }),
      packages: Schema.Struct({
        "@devver-inc/cli": Schema.Tuple([Schema.String]),
        "@devver-inc/cli-darwin-arm64": Schema.Tuple([Schema.String]),
        "@devver-inc/cli-linux-x64": Schema.Tuple([Schema.String]),
        "@devver/server": Schema.Tuple([Schema.String]),
      }),
    })
  )(Bun.JSONC.parse(readFileSync("bun.lock", "utf-8")));
  const resolved = Object.entries(bunLock.packages);
  if (
    cli.version !== version ||
    server.version !== version ||
    cli.bin?.["devver-server"] !== bin ||
    cli.dependencies?.["@devver/server"] !== undefined ||
    !pinned(cli.optionalDependencies) ||
    platformDocuments.some(
      ({ document }) => decodeVersion(document).version !== version
    ) ||
    lock.version !== version ||
    lock.packages[""].version !== version ||
    lock.packages["packages/cli"].version !== version ||
    lock.packages["packages/cli"].bin["devver-server"] !== bin ||
    !pinned(lock.packages["packages/cli"].optionalDependencies) ||
    lock.packages["packages/cli-darwin-arm64"].version !== version ||
    lock.packages["packages/cli-linux-x64"].version !== version ||
    lock.packages["packages/server"].version !== version ||
    bunLock.workspaces["packages/cli"].version !== version ||
    bunLock.workspaces["packages/cli"].bin["devver-server"] !== bin ||
    !pinned(bunLock.workspaces["packages/cli"].optionalDependencies) ||
    bunLock.workspaces["packages/cli-darwin-arm64"].version !== version ||
    bunLock.workspaces["packages/cli-linux-x64"].version !== version ||
    bunLock.workspaces["packages/server"].version !== version ||
    resolved.some(
      ([name, [target]]) => target !== `${name}@workspace:${workspaceOf(name)}`
    )
  ) {
    throw new Error(
      "Workspace versions, bins, platform pins or locks differ; run bun run sync:version"
    );
  }
} else {
  writeFileSync(
    cliPath,
    `${JSON.stringify({ ...cliDocument, version, bin: { ...cli.bin, "devver-server": bin }, optionalDependencies: pins }, null, 2)}\n`
  );
  writeFileSync(
    serverPath,
    `${JSON.stringify({ ...serverDocument, version }, null, 2)}\n`
  );
  for (const { path, document } of platformDocuments) {
    writeFileSync(
      path,
      `${JSON.stringify({ ...document, version }, null, 2)}\n`
    );
  }
  const bunLockPath = "bun.lock";
  const bunLockSource = readFileSync(bunLockPath, "utf-8");
  const workspaceVersions =
    /(?<prefix>"packages\/(?:cli|cli-darwin-arm64|cli-linux-x64|server)": \{\s*"name": "[^"]+",\s*"version": ")[^"]+/gu;
  const platformPins =
    /(?<prefix>"@devver-inc\/cli-(?:darwin-arm64|linux-x64)": ")[^"]+/gu;
  if (
    [...bunLockSource.matchAll(workspaceVersions)].length !== 4 ||
    [...bunLockSource.matchAll(platformPins)].length !== 2
  ) {
    throw new Error("Cannot synchronize Bun workspace versions");
  }
  writeFileSync(
    bunLockPath,
    bunLockSource
      .replaceAll(
        workspaceVersions,
        (_match, prefix: string) => `${prefix}${version}`
      )
      .replaceAll(
        platformPins,
        (_match, prefix: string) => `${prefix}${version}`
      )
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
        "--force",
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
