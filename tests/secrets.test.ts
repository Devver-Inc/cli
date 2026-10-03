import { expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSecretsFile, setDeploymentEnv } from "../src/config/secrets";

test("secrets are private and corrupt files are not overwritten", () => {
  const root = mkdtempSync(join(tmpdir(), "devver-secrets-"));
  try {
    setDeploymentEnv("app", { PASSWORD: "private" }, root);
    const file = join(root, ".devver", ".secrets");
    if (process.platform !== "win32") {
      expect(statSync(file).mode % 0o1000).toBe(0o600);
      expect(statSync(join(root, ".devver")).mode % 0o1000).toBe(0o700);
    }
    writeFileSync(file, "broken JSON");
    expect(() => readSecretsFile(root)).toThrow("Invalid secrets file");
    expect(() => setDeploymentEnv("app", { PASSWORD: "new" }, root)).toThrow();
    expect(readFileSync(file, "utf-8")).toBe("broken JSON");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unsupported secret command never echoes the value", () => {
  const child = Bun.spawnSync(
    ["bun", "run", "src/cli/index.ts", "secret", "set", "KEY", "private-value"],
    {
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const output = `${child.stdout.toString()}${child.stderr.toString()}`;
  expect(output).toContain("not supported yet");
  expect(output).not.toContain("private-value");
  expect(child.exitCode).not.toBe(0);
});
