import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pkg from "../../../package.json";

const repo = join(import.meta.dir, "../../..");

test("npm and standalone artifacts serve a loopback-only static site without runtime downloads", async () => {
  // Windows' actual owner-only state root is exercised only in the isolated CI job.
  if (
    process.platform === "win32" &&
    process.env.DEVVER_WINDOWS_STATE_TESTS !== "1"
  ) {
    return;
  }
  const node = Bun.which("node");
  if (node === null) {
    throw new Error("Node is required for the npm artifact check");
  }
  for (const distribution of ["npm", "standalone"]) {
    const build = Bun.spawnSync(
      ["bun", "run", distribution === "npm" ? "build:npm" : "build"],
      { cwd: repo, stdout: "pipe", stderr: "pipe" }
    );
    expect(build.exitCode, build.stderr.toString()).toBe(0);
    const directory =
      distribution === "npm"
        ? join(repo, "packages/cli/dist/servers", pkg.version)
        : join(repo, "servers", pkg.version);
    const temp = await mkdtemp(join(tmpdir(), "devver-artifact-probe-"));
    try {
      const probe = join(
        temp,
        distribution === "npm"
          ? "probe.mjs"
          : `probe${process.platform === "win32" ? ".exe" : ""}`
      );
      const result = await Bun.build({
        entrypoints: [
          join(repo, "packages/server/tests/static-artifact-probe.ts"),
        ],
        ...(distribution === "npm"
          ? {
              target: "node",
              packages: "bundle",
              outdir: temp,
              naming: { entry: "probe.mjs" },
            }
          : { compile: { outfile: probe } }),
      });
      expect(
        result.success,
        result.logs.map((log) => log.message).join("\n")
      ).toBe(true);
      const child = Bun.spawnSync(
        [
          distribution === "npm" ? node : probe,
          ...(distribution === "npm" ? [probe] : []),
          directory,
        ],
        {
          cwd: temp,
          env: {
            ...process.env,
            PATH:
              process.platform === "win32"
                ? "C:\\Windows\\System32;C:\\Windows\\System32\\WindowsPowerShell\\v1.0"
                : "/usr/bin:/bin",
          },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 30_000,
        }
      );
      expect(child.exitCode, child.stderr.toString()).toBe(0);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
}, 120_000);
