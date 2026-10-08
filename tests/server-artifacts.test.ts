import { expect, test } from "bun:test";
import {
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Schema } from "effect";

import pkg from "../package.json";

const repo = join(import.meta.dir, "..");
const node = Bun.which("node");
const versioned = join("servers", pkg.version);
const CONTROL_URL = /^http:\/\/127\.0\.0\.1:\d+\/api\/v1$/u;
const BUN_API = /\bBun\s*\.\s*(?<api>serve|spawn|file|build)\b/u;
const EXTERNAL_SERVER = /(?:from\s*["']|import\s*\(["'])@devver\/server/u;
const FORMULA =
  /cat > Formula\/devver-cli\.rb << EOF\n(?<body>[\s\S]*?)\n {10}EOF/u;
const decodeIdentity = Schema.decodeUnknownSync(
  Schema.Struct({
    name: Schema.String,
    serverVersion: Schema.String,
    controlProtocolVersion: Schema.Finite,
  })
);
const decodePackedManifest = Schema.decodeUnknownSync(
  Schema.Struct({ dependencies: Schema.Record(Schema.String, Schema.String) })
);
const bin = Schema.Record(Schema.String, Schema.String);
const decodeCliManifest = Schema.decodeUnknownSync(Schema.Struct({ bin }));
const decodeLock = Schema.decodeUnknownSync(
  Schema.Struct({
    packages: Schema.Struct({ "packages/cli": Schema.Struct({ bin }) }),
  })
);

test("Homebrew installs the versioned server beside its CLI", () => {
  const workflow = readFileSync(
    join(repo, ".github", "workflows", "release.yml"),
    "utf-8"
  );
  const formula = FORMULA.exec(workflow)?.groups?.body;
  expect(formula).toBeDefined();
  expect(formula).toContain(
    'bin.install "devver"\n              bin.install "servers"'
  );
  expect(formula).toContain(
    'assert_predicate bin/"servers"/version.to_s/"devver-server", :executable?'
  );
});

async function smoke(executable: string, args: string[], path: string) {
  const root = mkdtempSync(join(tmpdir(), "devver-artifact-"));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    child = Bun.spawn([executable, ...args, "artifact", "0"], {
      cwd: repo,
      env: { ...process.env, XDG_DATA_HOME: root, PATH: path },
      stdout: "pipe",
      stderr: "pipe",
    });
    const { stdout } = child;
    if (!(stdout instanceof ReadableStream)) {
      throw new Error("Server stdout unavailable");
    }
    const reader = stdout.getReader();
    const output = await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error("Server did not announce URL"));
        }, 10_000);
      }),
    ]);
    reader.releaseLock();
    const url = new TextDecoder().decode(output.value).trim();
    const response = await fetch(`${url}/identity`);
    return {
      url,
      status: response.status,
      identity: decodeIdentity(await response.json()),
    };
  } finally {
    child?.kill();
    if (child !== undefined) {
      await child.exited;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

test("npm artifact includes a versioned Node server beside the lazy CLI", async () => {
  if (process.platform === "win32") {
    return;
  }
  if (node === null) {
    throw new Error("Node is required for npm artifact smoke");
  }
  const built = Bun.spawnSync(["bun", "run", "build:npm"], { cwd: repo });
  expect(built.exitCode).toBe(0);
  const file = join(repo, "packages/cli/dist", versioned, "server.mjs");
  const code = readFileSync(file, "utf-8");
  expect(code).toStartWith("#!/usr/bin/env node\n");
  expect(code).not.toMatch(BUN_API);
  const result = await smoke(node, [file], `${dirname(node)}:/usr/bin:/bin`);
  expect(result.url).toMatch(CONTROL_URL);
  expect(result.status).toBe(200);
  expect(result.identity).toMatchObject({
    name: "artifact",
    serverVersion: pkg.version,
    controlProtocolVersion: 1,
  });
  const packRoot = mkdtempSync(join(tmpdir(), "devver-pack-"));
  const nodePath = `${dirname(node)}:/usr/bin:/bin`;
  try {
    const bunProbe = Bun.spawnSync(["sh", "-c", "command -v bun"], {
      env: { PATH: nodePath },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(bunProbe.exitCode).not.toBe(0);
    const bundleFiles = readdirSync(join(repo, "packages/cli/dist")).filter(
      (name) => name.endsWith(".js") || name.endsWith(".mjs")
    );
    for (const name of bundleFiles) {
      expect(
        readFileSync(join(repo, "packages/cli/dist", name), "utf-8")
      ).not.toMatch(EXTERNAL_SERVER);
    }
    const pack = Bun.spawnSync(
      [
        "npm",
        "pack",
        "--workspace",
        "@devver/cli",
        "--ignore-scripts",
        "--pack-destination",
        packRoot,
      ],
      {
        cwd: repo,
        env: { ...process.env, PATH: nodePath },
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    expect(pack.exitCode, pack.stderr.toString()).toBe(0);
    const archive = join(packRoot, pack.stdout.toString().trim());
    const files = Bun.spawnSync(["tar", "-tzf", archive], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(files.exitCode, files.stderr.toString()).toBe(0);
    expect(files.stdout.toString()).toContain(
      `package/dist/servers/${pkg.version}/server.mjs`
    );
    const packedManifest = Bun.spawnSync(
      ["tar", "-xOf", archive, "package/package.json"],
      { stdout: "pipe", stderr: "pipe" }
    );
    expect(packedManifest.exitCode, packedManifest.stderr.toString()).toBe(0);
    expect(
      decodePackedManifest(JSON.parse(packedManifest.stdout.toString()))
        .dependencies
    ).not.toHaveProperty("@devver/server");
    const manifest = decodeCliManifest(
      JSON.parse(readFileSync(join(repo, "packages/cli/package.json"), "utf-8"))
    );
    expect(manifest.bin["devver-server"]).toBe(
      `dist/servers/${pkg.version}/server.mjs`
    );
    const lock = decodeLock(
      JSON.parse(readFileSync(join(repo, "package-lock.json"), "utf-8"))
    );
    expect(lock.packages["packages/cli"].bin).toEqual(manifest.bin);
    const installed = join(packRoot, "installed");
    const install = Bun.spawnSync(
      [
        "npm",
        "install",
        "--no-audit",
        "--no-fund",
        "--prefix",
        installed,
        archive,
      ],
      {
        cwd: packRoot,
        env: { ...process.env, PATH: nodePath },
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    expect(install.exitCode, install.stderr.toString()).toBe(0);
    expect(
      lstatSync(
        join(installed, "node_modules", ".bin", "devver-server")
      ).isSymbolicLink()
    ).toBe(true);
    const installedServer = join(
      installed,
      "node_modules",
      "@devver",
      "cli",
      "dist",
      versioned,
      "server.mjs"
    );
    const installedResult = await smoke(
      node,
      [installedServer],
      `${dirname(node)}:/usr/bin:/bin`
    );
    expect(installedResult.status).toBe(200);
    const npmCli = Bun.spawnSync(
      [
        node,
        join(installed, "node_modules", "@devver", "cli", "dist", "cli.mjs"),
        "--version",
      ],
      {
        cwd: packRoot,
        env: { PATH: dirname(node) },
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    expect(npmCli.exitCode, npmCli.stderr.toString()).toBe(0);
    expect(npmCli.stdout.toString()).toContain(`devver v${pkg.version}`);
    expect(installedResult.identity).toMatchObject({
      name: "artifact",
      serverVersion: pkg.version,
    });
  } finally {
    rmSync(packRoot, { recursive: true, force: true });
  }
}, 30_000);

test("standalone artifact includes an independently runnable versioned server", async () => {
  if (process.platform === "win32") {
    return;
  }
  const built = Bun.spawnSync(["bun", "run", "build"], { cwd: repo });
  expect(built.exitCode).toBe(0);
  const extracted = mkdtempSync(join(tmpdir(), "devver-archive-"));
  try {
    const archive = join(extracted, "devver.tar.gz");
    const packed = Bun.spawnSync(
      ["tar", "-czf", archive, "devver", "servers"],
      { cwd: repo, stderr: "pipe" }
    );
    expect(packed.exitCode, packed.stderr.toString()).toBe(0);
    const unpacked = Bun.spawnSync(["tar", "-xzf", archive, "-C", extracted], {
      stderr: "pipe",
    });
    expect(unpacked.exitCode, unpacked.stderr.toString()).toBe(0);
    const cli = Bun.spawnSync([join(extracted, "devver"), "--version"], {
      cwd: extracted,
      env: { PATH: "/nonexistent" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(cli.exitCode, cli.stderr.toString()).toBe(0);
    expect(cli.stdout.toString()).toContain(`devver v${pkg.version}`);
    const result = await smoke(
      join(extracted, versioned, "devver-server"),
      [],
      "/nonexistent"
    );
    expect(result.url).toMatch(CONTROL_URL);
    expect(result.status).toBe(200);
    expect(result.identity).toMatchObject({
      name: "artifact",
      serverVersion: pkg.version,
      controlProtocolVersion: 1,
    });
  } finally {
    rmSync(extracted, { recursive: true, force: true });
  }
}, 30_000);
