import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "../package.json";
import { buildDefines, commitStamp } from "../scripts/stamp";

const repo = join(import.meta.dir, "..");
const entry = join(repo, "packages", "cli", "src", "cli", "index.ts");
const DEV_VERSION =
  /^devver v\d+\.\d+\.\d+ \(dev, (?:[0-9a-f]{7}(?:-dirty)?|unknown)\)$/;
const COMMIT = /^(?:[0-9a-f]{7}(?:-dirty)?|unknown)$/;

test("nightly stamp keeps the package version and marks the release channel", () => {
  const previous = process.env.DEVVER_RELEASE_CHANNEL;
  try {
    process.env.DEVVER_RELEASE_CHANNEL = "nightly";
    const stamp = buildDefines("npm");
    expect(JSON.parse(stamp.DEVVER_CHANNEL)).toBe("nightly");
    expect(JSON.parse(stamp.DEVVER_VERSION)).toBe(pkg.version);
    expect(JSON.parse(stamp.DEVVER_COMMIT)).toMatch(COMMIT);
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, "DEVVER_RELEASE_CHANNEL");
    } else {
      process.env.DEVVER_RELEASE_CHANNEL = previous;
    }
  }
});

test("nightly CI stamps the tested commit despite versioning changes", () => {
  const directory = mkdtempSync(join(repo, "nightly-stamp-test-"));
  const previousChannel = process.env.DEVVER_RELEASE_CHANNEL;
  const previousCommit = process.env.DEVVER_RELEASE_COMMIT;
  try {
    writeFileSync(join(directory, "changed"), "dirty");
    const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
      cwd: repo,
      stdout: "pipe",
    });
    expect(result.exitCode).toBe(0);
    const sha = result.stdout.toString().trim();
    Reflect.deleteProperty(process.env, "DEVVER_RELEASE_CHANNEL");
    expect(commitStamp()).toBe(`${sha.slice(0, 7)}-dirty`);
    process.env.DEVVER_RELEASE_CHANNEL = "nightly";
    process.env.DEVVER_RELEASE_COMMIT = sha;
    expect(commitStamp()).toBe(sha.slice(0, 7));
    process.env.DEVVER_RELEASE_COMMIT = "wrong";
    expect(() => commitStamp()).toThrow("Nightly checkout does not match");
  } finally {
    rmSync(directory, { recursive: true, force: true });
    if (previousChannel === undefined) {
      Reflect.deleteProperty(process.env, "DEVVER_RELEASE_CHANNEL");
    } else {
      process.env.DEVVER_RELEASE_CHANNEL = previousChannel;
    }
    if (previousCommit === undefined) {
      Reflect.deleteProperty(process.env, "DEVVER_RELEASE_COMMIT");
    } else {
      process.env.DEVVER_RELEASE_COMMIT = previousCommit;
    }
  }
});

test("running from source reports the dev channel and the devver commit", () => {
  const result = Bun.spawnSync(["bun", "run", entry, "--version"], {
    cwd: "/",
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(result.stdout.toString().trim()).toMatch(DEV_VERSION);
});
