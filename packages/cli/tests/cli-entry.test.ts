import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import pkg from "../../../package.json" with { type: "json" };

const entry = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

function run(...args: string[]) {
  return spawnSync(process.execPath, ["run", entry, ...args], {
    encoding: "utf8",
  });
}

test("CLI entry provides help and version without starting the TUI", () => {
  const help = run("tui", "--help");
  expect(help.status).toBe(0);
  expect(help.stdout).toContain("Start the terminal UI");
  expect(help.stdout).toContain("devver tui");

  const version = run("--version");
  expect(version.status).toBe(0);
  expect(version.stdout).toContain(`devver v${pkg.version} (`);
});
