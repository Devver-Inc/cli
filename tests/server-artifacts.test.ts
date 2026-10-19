import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pkg from "../package.json";

const repo = join(import.meta.dir, "..");

test("compiled standalone entrypoints run even when import.meta.main is false", async () => {
  const root = mkdtempSync(join(tmpdir(), "devver-entry-"));
  try {
    for (const [source, name, args, expected] of [
      [
        "packages/cli/src/cli/index.ts",
        "devver",
        ["--version"],
        `devver v${pkg.version}`,
      ],
      [
        "packages/server/src/index.ts",
        "devver-server",
        [],
        "Usage: devver-server",
      ],
    ] as const) {
      const outfile = join(root, name);
      const built = Bun.spawnSync(
        [
          "bun",
          "build",
          "--compile",
          source,
          "--outfile",
          outfile,
          "--define",
          "import.meta.main=false",
          "--define",
          "DEVVER_STANDALONE_ENTRY=true",
        ],
        { cwd: repo, stdout: "pipe", stderr: "pipe" }
      );
      expect(built.exitCode, built.stderr.toString()).toBe(0);
      const executable = existsSync(`${outfile}.exe`)
        ? `${outfile}.exe`
        : outfile;
      const invocation = Bun.spawnSync([executable, ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(
        invocation.stdout.toString() + invocation.stderr.toString()
      ).toContain(expected);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
