import { expect, test } from "bun:test";
import { join } from "node:path";

test("resource engine durable proof passes across real processes", () => {
  const result = Bun.spawnSync(
    ["bun", "run", "scripts/verify-resource-engine.ts"],
    {
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(result.stdout.toString()).toContain(
    "resource engine durable proof passed"
  );
  expect(result.stdout.toString()).toContain("PROOF_DIR:");
}, 120_000);
