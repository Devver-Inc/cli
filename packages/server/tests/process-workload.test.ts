import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { processKind } from "../src/workloads/process";

test("Astro stays in the foreground on its reserved loopback port", async () => {
  const root = mkdtempSync(join(tmpdir(), "devver-astro-process-"));
  try {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ scripts: { dev: "astro dev" } })
    );
    writeFileSync(
      join(root, ".devver.yaml"),
      "process:\n  install: git --version\n  run: npm run dev\n"
    );
    const daemon = await processKind.resolve({
      worktree: root,
      directory: root,
      port: 45_678,
    });
    expect(daemon.command).toEqual([
      "npm",
      "run",
      "dev",
      "--",
      "--host",
      "127.0.0.1",
      "--port",
      "45678",
      "--ignore-lock",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
