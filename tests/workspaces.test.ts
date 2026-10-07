import { expect, test } from "bun:test";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (file: string) =>
  JSON.parse(readFileSync(join(root, file), "utf8"));

test("one release version synchronizes the publishable CLI and offline server", () => {
  const workspace = read("package.json");
  const cli = read("packages/cli/package.json");
  const server = read("packages/server/package.json");
  const lock = read("package-lock.json");
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
  const original = readFileSync(join(root, "bun.lock"), "utf8");
  const version = read("package.json").version;
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

test("stable and nightly publish the CLI workspace, not the private root", () => {
  for (const channel of ["release", "nightly"]) {
    const workflow = readFileSync(
      join(root, `.github/workflows/${channel}.yml`),
      "utf8"
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
    const cli = JSON.parse(
      readFileSync(join(temp, "packages/cli/package.json"), "utf8")
    );
    cli.bin["devver-server"] = "dist/servers/outdated/server.mjs";
    writeFileSync(join(temp, "packages/cli/package.json"), JSON.stringify(cli));
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
