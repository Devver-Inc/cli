import { expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const script = join(root, "scripts/target-version.ts");

function target(directory: string, local = false) {
  return Bun.spawnSync(["bun", "run", script, ...(local ? ["--local"] : [])], {
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("the local baseline is stable; a no-changeset nightly has a provisional patch", () => {
  const directory = mkdtempSync(join(tmpdir(), "devver-plan-"));
  try {
    mkdirSync(join(directory, ".changeset"));
    writeFileSync(join(directory, "package.json"), '{"version":"1.2.0"}');
    expect(target(directory, true).stdout.toString().trim()).toBe("1.2.0");
    expect(target(directory).stdout.toString().trim()).toBe("1.2.1");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("release adoption copies the Changesets CLI version without losing root metadata", () => {
  const directory = mkdtempSync(join(tmpdir(), "devver-adopt-"));
  try {
    mkdirSync(join(directory, "packages/cli"), { recursive: true });
    writeFileSync(
      join(directory, "package.json"),
      '{"version":"1.2.0","private":true}'
    );
    writeFileSync(
      join(directory, "packages/cli/package.json"),
      '{"version":"1.3.0"}'
    );
    const result = Bun.spawnSync(
      ["bun", "run", join(root, "scripts/adopt-cli-version.ts")],
      { cwd: directory, stderr: "pipe" }
    );
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(
      JSON.parse(readFileSync(join(directory, "package.json"), "utf-8"))
    ).toEqual({
      version: "1.3.0",
      private: true,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("pending changesets determine the development target", () => {
  const directory = mkdtempSync(join(tmpdir(), "devver-plan-"));
  try {
    for (const file of [
      "package.json",
      "bun.lock",
      "packages/cli/package.json",
      "packages/server/package.json",
      ".changeset/config.json",
    ]) {
      mkdirSync(join(directory, file, ".."), { recursive: true });
      cpSync(join(root, file), join(directory, file));
    }
    symlinkSync(join(root, "node_modules"), join(directory, "node_modules"));
    expect(
      Bun.spawnSync(["git", "init", "-b", "develop"], { cwd: directory })
        .exitCode
    ).toBe(0);
    expect(
      Bun.spawnSync(["git", "add", "."], { cwd: directory }).exitCode
    ).toBe(0);
    expect(
      Bun.spawnSync(
        [
          "git",
          "-c",
          "user.name=test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "-m",
          "baseline",
        ],
        { cwd: directory }
      ).exitCode
    ).toBe(0);
    writeFileSync(
      join(directory, ".changeset", "feature.md"),
      '---\n"@devver/cli": minor\n---\n\nA test feature.\n'
    );
    const result = target(directory, true);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString().trim()).toBe("1.3.0");
    writeFileSync(
      join(directory, ".changeset", "feature.md"),
      "---\n---\n\nNo release intended.\n"
    );
    expect(target(directory, true).stdout.toString().trim()).toBe("1.2.0");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
