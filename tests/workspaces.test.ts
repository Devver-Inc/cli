import { expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Schema } from "effect";

const root = join(import.meta.dir, "..");
const decodeDocument = Schema.decodeUnknownSync(
  Schema.Record(Schema.String, Schema.Unknown)
);
const readDocument = (file: string) =>
  decodeDocument(JSON.parse(readFileSync(join(root, file), "utf-8")));
const decodeWorkspace = Schema.decodeUnknownSync(
  Schema.Struct({
    version: Schema.String,
    private: Schema.Boolean,
    workspaces: Schema.Array(Schema.String),
  })
);
const decodeCli = Schema.decodeUnknownSync(
  Schema.Struct({
    version: Schema.String,
    bin: Schema.Struct({
      devver: Schema.String,
      "devver-server": Schema.String,
    }),
    dependencies: Schema.Record(Schema.String, Schema.String),
  })
);
const decodeVersion = Schema.decodeUnknownSync(
  Schema.Struct({ version: Schema.String })
);
const decodeLock = Schema.decodeUnknownSync(
  Schema.Struct({
    packages: Schema.Struct({
      "packages/cli": Schema.Struct({
        version: Schema.String,
        bin: Schema.Struct({
          devver: Schema.String,
          "devver-server": Schema.String,
        }),
      }),
      "packages/server": Schema.Struct({ version: Schema.String }),
    }),
  })
);

test("one release version synchronizes the publishable CLI and offline server", () => {
  const workspace = decodeWorkspace(readDocument("package.json"));
  const cli = decodeCli(readDocument("packages/cli/package.json"));
  const server = decodeVersion(readDocument("packages/server/package.json"));
  const lock = decodeLock(readDocument("package-lock.json"));
  expect(workspace.private).toBe(true);
  expect(workspace.workspaces).toEqual(["packages/cli", "packages/server"]);
  expect(cli.version).toBe(workspace.version);
  expect(server.version).toBe(workspace.version);
  expect(cli.bin).toEqual({
    devver: "dist/cli.mjs",
    "devver-server": `dist/servers/${workspace.version}/server.mjs`,
  });
  expect(cli.dependencies["@devver/server"]).toBeUndefined();
  expect(lock.packages["packages/cli"].version).toBe(workspace.version);
  expect(lock.packages["packages/cli"].bin).toEqual(cli.bin);
  expect(lock.packages["packages/server"].version).toBe(workspace.version);
});

test("release version check rejects Bun workspace version and server bin drift", () => {
  const original = readFileSync(join(root, "bun.lock"), "utf-8");
  const { version } = decodeVersion(readDocument("package.json"));
  const temp = mkdtempSync(join(tmpdir(), "devver-bun-lock-check-"));
  try {
    for (const file of [
      "package.json",
      "packages/cli/package.json",
      "packages/server/package.json",
      "package-lock.json",
    ]) {
      cpSync(join(root, file), join(temp, file), { recursive: true });
    }
    for (const [field, originalValue, driftedValue] of [
      ["CLI version", `"version": "${version}"`, '"version": "0.0.0"'],
      ["server version", `"version": "${version}"`, '"version": "0.0.0"'],
      [
        "CLI server bin",
        `"devver-server": "dist/servers/${version}/server.mjs"`,
        '"devver-server": "dist/servers/0.0.0/server.mjs"',
      ],
    ] as const) {
      const start = original.indexOf(
        field === "server version"
          ? '"packages/server": {'
          : '"packages/cli": {'
      );
      const target = original.indexOf(originalValue, start);
      expect(target).toBeGreaterThan(start);
      writeFileSync(
        join(temp, "bun.lock"),
        `${original.slice(0, target)}${driftedValue}${original.slice(target + originalValue.length)}`
      );
      const result = Bun.spawnSync(
        ["bun", "run", join(root, "scripts/sync-version.ts"), "--check"],
        { cwd: temp, stdout: "pipe", stderr: "pipe" }
      );
      expect(result.exitCode, field).not.toBe(0);
      expect(result.stderr.toString()).toContain(
        "Workspace versions, bins or locks differ"
      );
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("version check rejects malformed manifests without rewriting them", () => {
  const temp = mkdtempSync(join(tmpdir(), "devver-invalid-manifest-"));
  try {
    cpSync(join(root, "package.json"), join(temp, "package.json"));
    cpSync(
      join(root, "packages/server/package.json"),
      join(temp, "packages/server/package.json"),
      { recursive: true }
    );
    const cliPath = join(temp, "packages/cli/package.json");
    mkdirSync(join(temp, "packages/cli"), { recursive: true });
    const invalid = '{"version":"not-a-version","bin":"not-an-object"}';
    writeFileSync(cliPath, invalid);
    const result = Bun.spawnSync(
      ["bun", "run", join(root, "scripts/sync-version.ts"), "--check"],
      { cwd: temp, stdout: "pipe", stderr: "pipe" }
    );
    expect(result.exitCode).not.toBe(0);
    expect(readFileSync(cliPath, "utf-8")).toBe(invalid);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("stable and nightly publish the CLI workspace, not the private root", () => {
  for (const channel of ["release", "nightly"]) {
    const workflow = readFileSync(
      join(root, `.github/workflows/${channel}.yml`),
      "utf-8"
    );
    expect(workflow).toContain("bun run sync:version");
    expect(workflow).toContain("npm publish --workspace @devver/cli");
  }
});

test("release version check detects drift without rewriting tracked manifests", () => {
  const result = Bun.spawnSync(
    ["bun", "run", "scripts/sync-version.ts", "--check"],
    {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  expect(result.exitCode, result.stderr.toString()).toBe(0);

  const temp = mkdtempSync(join(tmpdir(), "devver-version-check-"));
  try {
    for (const file of [
      "package.json",
      "packages/cli/package.json",
      "packages/server/package.json",
      "package-lock.json",
      "bun.lock",
    ]) {
      cpSync(join(root, file), join(temp, file), { recursive: true });
    }
    const cliPath = join(temp, "packages/cli/package.json");
    const original = readFileSync(cliPath, "utf-8");
    const expectedBin = `dist/servers/${decodeVersion(readDocument("package.json")).version}/server.mjs`;
    expect(original).toContain(expectedBin);
    writeFileSync(
      cliPath,
      original.replace(expectedBin, "dist/servers/outdated/server.mjs")
    );
    const drift = Bun.spawnSync(
      ["bun", "run", join(root, "scripts/sync-version.ts"), "--check"],
      { cwd: temp, stdout: "pipe", stderr: "pipe" }
    );
    expect(drift.exitCode).not.toBe(0);
    expect(drift.stderr.toString()).toContain(
      "Workspace versions, bins or locks differ"
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
