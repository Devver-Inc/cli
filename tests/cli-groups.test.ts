import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = join(
  import.meta.dir,
  "..",
  "packages",
  "cli",
  "src",
  "cli",
  "index.ts"
);

test("config, project, and repos work in an isolated workspace", () => {
  const root = mkdtempSync(join(tmpdir(), "devver-cli-"));
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
  };
  const run = (...args: string[]) => {
    const result = Bun.spawnSync(["bun", "run", entry, ...args], {
      cwd: root,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      status: result.exitCode,
      output: `${result.stdout.toString()}${result.stderr.toString()}`,
    };
  };
  try {
    expect(run("init").status).toBe(0);
    expect(existsSync(join(root, ".devver.yaml"))).toBe(true);
    // Storing api-url no longer selects a target, so it must fail rather than
    // report a change it cannot make.
    const stored = run("config", "set", "api-url", "https://example.org");
    expect(stored.status).not.toBe(0);
    expect(stored.output).toContain("no longer selects a target");
    expect(run("config", "get", "api-url").output).toContain("is not set");
    expect(
      run("project", "status", "--api-url", "http://localhost:9998").output
    ).toContain("No project selected");
    expect(run("repos", "list").output).toContain("No projects found");
    expect(run("project", "create", "demo", "--cpu", "3").status).not.toBe(0);
    const link = run(
      "project",
      "link",
      "https://example.org",
      "--name",
      "demo"
    );
    expect(link.status).not.toBe(0);
    expect(link.output).toContain("not supported yet");
    expect(run("deploy", "--unknown").status).not.toBe(0);
    expect(run("deploy", "--help").status).toBe(0);
    expect(run("auth", "status").output).toContain("Not logged in");
    expect(run("org", "list").output).toContain("Not part of any organization");
    expect(run("tui", "--help").status).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
