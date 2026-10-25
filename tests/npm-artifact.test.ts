import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Schema } from "effect";

import pkg from "../package.json";

const repo = join(import.meta.dir, "..");
const cli = join(repo, "packages/cli");
const target = `${process.platform}-${process.arch}`;
const supported = target === "darwin-arm64" || target === "linux-x64";
const decodePack = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ filename: Schema.String }))
);

test("local cross-platform fixture cannot be published", () => {
  if (!existsSync(join(cli, "dist", "fixture"))) {
    return;
  }
  const result = Bun.spawnSync(["npm", "pack", cli, "--dry-run", "--offline"], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).not.toBe(0);
}, 120_000);

test("packed npm CLI and server run without Node or Bun", () => {
  if (!supported) {
    throw new Error("npm artifact test requires a published POSIX target");
  }
  const root = mkdtempSync(join(tmpdir(), "devver-npm-"));
  try {
    const npm = Bun.which("npm");
    if (npm === null) {
      throw new Error("npm is required to pack and install the artifact");
    }
    const pack = Bun.spawnSync(
      [npm, "pack", cli, "--pack-destination", root, "--json", "--offline"],
      {
        cwd: repo,
        env: { ...process.env, DEVVER_ALLOW_NPM_FIXTURE: "1" },
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    expect(pack.exitCode, pack.stderr.toString()).toBe(0);
    const parsed = decodePack(JSON.parse(pack.stdout.toString()));
    const filename = parsed[0]?.filename;
    if (filename === undefined) {
      throw new Error("npm pack did not produce an archive");
    }
    const archive = join(root, filename);
    const install = Bun.spawnSync(
      [
        npm,
        "install",
        "--prefix",
        join(root, "prefix"),
        "--offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        archive,
      ],
      {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    expect(install.exitCode, install.stderr.toString()).toBe(0);
    const path = "/usr/bin:/bin";
    expect(Bun.which("node", { PATH: path })).toBeNull();
    expect(Bun.which("bun", { PATH: path })).toBeNull();
    const bin = join(root, "prefix", "node_modules", ".bin");
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
    expect(readFileSync(join(cli, "dist", "version"), "utf-8")).toBe(
      `${pkg.version}\n`
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 300_000);
