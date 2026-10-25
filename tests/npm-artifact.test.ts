import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Schema } from "effect";

import pkg from "../package.json";

const repo = join(import.meta.dir, "..");
const cli = join(repo, "packages/cli");
const target = `${process.platform}-${process.arch}`;
const supported = target === "darwin-arm64" || target === "linux-x64";
const platform = join(repo, "packages", `cli-${target}`);
const decodePack = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ filename: Schema.String }))
);

const npmExecutable = () => {
  const npm = Bun.which("npm");
  if (npm === null) {
    throw new Error("npm is required to pack and install the artifact");
  }
  return npm;
};

const pack = (
  npm: string,
  destination: string,
  packages: readonly string[]
) => {
  const result = Bun.spawnSync(
    [
      npm,
      "pack",
      ...packages,
      "--pack-destination",
      destination,
      "--json",
      "--offline",
    ],
    {
      cwd: repo,
      env: { ...process.env, DEVVER_ALLOW_NPM_FIXTURE: "1" },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return decodePack(JSON.parse(result.stdout.toString())).map(({ filename }) =>
    join(destination, filename)
  );
};

const install = (
  npm: string,
  prefix: string,
  archives: readonly string[],
  extra: readonly string[] = []
) => {
  mkdirSync(prefix, { recursive: true });
  const result = Bun.spawnSync(
    [
      npm,
      "install",
      "--prefix",
      prefix,
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      ...extra,
      ...archives,
    ],
    { cwd: prefix, stdout: "pipe", stderr: "pipe" }
  );
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return join(prefix, "node_modules", ".bin");
};

test("local cross-platform fixture cannot be published", () => {
  if (!existsSync(join(platform, "fixture"))) {
    return;
  }
  const result = Bun.spawnSync(
    ["npm", "pack", platform, "--dry-run", "--offline"],
    {
      cwd: repo,
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  expect(result.exitCode).not.toBe(0);
}, 120_000);

test("packed npm CLI and server run without Node or Bun", () => {
  if (!supported) {
    throw new Error("npm artifact test requires a published POSIX target");
  }
  const root = mkdtempSync(join(tmpdir(), "devver-npm-"));
  try {
    const npm = npmExecutable();
    const archives = pack(npm, root, [cli, platform]);
    expect(archives).toHaveLength(2);
    const path = "/usr/bin:/bin";
    expect(Bun.which("node", { PATH: path })).toBeNull();
    expect(Bun.which("bun", { PATH: path })).toBeNull();
    const bin = install(npm, join(root, "prefix"), archives);
    const environment = { HOME: root, PATH: path };
    const version = Bun.spawnSync([join(bin, "devver"), "--version"], {
      env: environment,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(version.exitCode, version.stderr.toString()).toBe(0);
    expect(version.stdout.toString()).toContain(`devver v${pkg.version}`);
    const server = Bun.spawnSync([join(bin, "devver-server")], {
      env: environment,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(server.stdout.toString() + server.stderr.toString()).toContain(
      "Usage: devver-server"
    );
    expect(readFileSync(join(platform, "version"), "utf-8")).toBe(
      `${pkg.version}\n`
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 300_000);

test("commands fail when the platform package is absent", () => {
  if (!supported) {
    throw new Error("npm artifact test requires a published POSIX target");
  }
  const root = mkdtempSync(join(tmpdir(), "devver-npm-bare-"));
  try {
    const npm = npmExecutable();
    const archives = pack(npm, root, [cli]);
    const bin = install(npm, join(root, "prefix"), archives, [
      "--omit=optional",
    ]);
    const environment = { HOME: root, PATH: "/usr/bin:/bin" };
    for (const command of ["devver", "devver-server"]) {
      const result = Bun.spawnSync([join(bin, command)], {
        env: environment,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain(
        `${command}: missing platform package @devver-inc/cli-${target}`
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 300_000);
