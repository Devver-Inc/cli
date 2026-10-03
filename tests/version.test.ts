import { expect, test } from "bun:test";
import { join } from "node:path";

const repo = join(import.meta.dir, "..");
const entry = join(repo, "src", "cli", "index.ts");
const DEV_VERSION =
  /^devver v\d+\.\d+\.\d+ \(dev, (?:[0-9a-f]{7}(?:-dirty)?|unknown)\)$/;

test("running from source reports the dev channel and the devver commit", () => {
  const result = Bun.spawnSync(["bun", "run", entry, "--version"], {
    cwd: "/",
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(result.stdout.toString().trim()).toMatch(DEV_VERSION);
});
