import { expect, test } from "bun:test";
import { join } from "node:path";
import pkg from "../package.json";

function cli(...args: string[]) {
  const child = Bun.spawnSync(
    ["bun", "run", "packages/cli/src/cli/index.ts", ...args],
    {
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  return {
    status: child.exitCode,
    output: `${child.stdout.toString()}${child.stderr.toString()}`,
  };
}

test("Effect CLI provides help and version", () => {
  expect(cli("--help").output).toContain("config");
  expect(cli("--help").output).toContain("secret");
  expect(cli("--version").output).toContain(pkg.version);
});

test("Effect CLI rejects invalid arguments and unsupported commands", () => {
  expect(cli("config", "get").status).not.toBe(0);
  const result = cli("config", "get", "unsupported");
  expect(result.status).not.toBe(0);
  expect(result.output).toContain("Invalid config key");
  const secret = cli("secret", "set", "KEY", "private-value");
  expect(secret.status).not.toBe(0);
  expect(secret.output).toContain("not supported yet");
  expect(secret.output).not.toContain("private-value");
});
