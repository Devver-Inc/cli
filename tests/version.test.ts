import { expect, test } from "bun:test";
import { join } from "node:path";
import pkg from "../package.json";
import { buildDefines } from "../scripts/stamp";

const repo = join(import.meta.dir, "..");
const entry = join(repo, "src", "cli", "index.ts");
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

test("running from source reports the dev channel and the devver commit", () => {
  const result = Bun.spawnSync(["bun", "run", entry, "--version"], {
    cwd: "/",
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(result.stdout.toString().trim()).toMatch(DEV_VERSION);
});
