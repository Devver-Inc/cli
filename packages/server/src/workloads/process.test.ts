import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { processKind } from "./process";

async function resolveDevCommand(dev: string) {
  const root = mkdtempSync(join(tmpdir(), "devver-process-launch-"));
  try {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ scripts: { dev } })
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
    return daemon.command;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("Astro stays in the foreground on its reserved loopback port", async () => {
  expect(await resolveDevCommand("astro dev")).toEqual([
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
});

test("a dev script keeps its reserved port when it already carries arguments", async () => {
  expect(await resolveDevCommand("vite dev --open")).toEqual([
    "npm",
    "run",
    "dev",
    "--",
    "--host",
    "127.0.0.1",
    "--port",
    "45678",
  ]);
});

test("Next binds with its own host flag", async () => {
  expect(await resolveDevCommand("next dev --turbo")).toEqual([
    "npm",
    "run",
    "dev",
    "--",
    "--hostname",
    "127.0.0.1",
    "--port",
    "45678",
  ]);
});

test("a custom dev script binds itself instead of receiving flags", async () => {
  expect(await resolveDevCommand("node server.js")).toEqual([
    "npm",
    "run",
    "dev",
  ]);
});
