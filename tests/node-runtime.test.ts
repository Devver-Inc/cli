import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

const repo = join(import.meta.dir, "..");
const driver = join(import.meta.dir, "fixtures", "node-runtime-driver.ts");
const BUN_API = /\bBun\s*\.\s*(serve|spawn|stderr|stdout|file|color|build)\b/;
const NPM_VERSION =
  /^devver v\d+\.\d+\.\d+ \(npm, (?:[0-9a-f]{7}(?:-dirty)?|unknown)\)$/;

function nodeEnvironment() {
  const node = Bun.which("node");
  if (!node) {
    throw new Error("node is required: the npm CLI must run without Bun");
  }
  const git = Bun.which("git");
  if (!git) {
    throw new Error("git is required: the Node runtime check invokes git");
  }
  return { node, path: [dirname(node), dirname(git)].join(delimiter) };
}

test("the npm bundle runs under Node without eagerly loading the TUI", () => {
  const { node, path } = nodeEnvironment();
  const build = Bun.spawnSync(["bun", "run", "scripts/build-npm.ts"], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(build.exitCode, build.stderr.toString()).toBe(0);

  const bundle = join(repo, "dist", "cli.mjs");
  const run = (...args: string[]) => {
    const result = Bun.spawnSync([node, bundle, ...args], {
      cwd: repo,
      env: { HOME: process.env.HOME ?? repo, PATH: path },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      code: result.exitCode,
      output: `${result.stdout.toString()}${result.stderr.toString()}`,
    };
  };

  const version = run("--version");
  expect(version.code, version.output).toBe(0);
  expect(version.output.trim()).toMatch(NPM_VERSION);

  const help = run("--help");
  expect(help.code, help.output).toBe(0);
  expect(help.output).toContain("SUBCOMMANDS");

  expect(run("nope").code).not.toBe(0);
});

test("auth callback and git run under Node with Bun absent", () => {
  const { node, path } = nodeEnvironment();
  const out = mkdtempSync(join(tmpdir(), "devver-node-"));
  const bundle = join(out, "driver.mjs");
  try {
    const build = Bun.spawnSync(
      [
        "bun",
        "build",
        driver,
        "--target=node",
        "--format=esm",
        `--outfile=${bundle}`,
      ],
      { cwd: repo, stdout: "pipe", stderr: "pipe" }
    );
    expect(build.exitCode, build.stderr.toString()).toBe(0);

    const code = readFileSync(bundle, "utf-8");
    expect(code).not.toMatch(BUN_API);

    const run = Bun.spawnSync([node, bundle], {
      cwd: out,
      env: { HOME: process.env.HOME ?? out, PATH: path },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.exitCode, run.stderr.toString()).toBe(0);

    const lines = run.stdout.toString().trim().split("\n");
    const summary = JSON.parse(lines.at(-1) ?? "null");

    expect(summary.bunGlobal).toBe(false);
    expect(summary.callback.ipv4).toBe(404);
    expect(summary.callback.ipv6).toBe(404);
    expect(summary.callback.page).toEqual({ status: 200, complete: true });
    expect(summary.callback.seen).toEqual([
      "http://localhost:9999/callback?code=abc",
    ]);
    expect(summary.rejected.status).toBe(400);
    expect(summary.rejected.message).toContain("callback rejected");
    expect(summary.gitFailure).toContain("rev-parse");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
