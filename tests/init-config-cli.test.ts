import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(
  import.meta.dir,
  "..",
  "packages",
  "cli",
  "src",
  "cli",
  "index.ts"
);

const localTarget = {
  "local-target": {
    url: "http://127.0.0.1:49152/api/v1",
    instanceId: "75758c56-340d-44a2-a709-a52066752456",
    name: "test",
    serverVersion: "0.0.0",
    controlProtocolVersion: 1,
  },
};

test("init and cloud deploy reject unsupported or missing configs without writing or connecting", async () => {
  const root = mkdtempSync(join(tmpdir(), "devver-init-config-"));
  const project = join(root, "project");
  const configDir = join(root, "devver", "config");
  const configPath = join(configDir, "cli");
  const env = {
    ...process.env,
    XDG_DATA_HOME: root,
    XDG_CONFIG_HOME: root,
    XDG_CACHE_HOME: root,
    XDG_STATE_HOME: root,
    HTTP_PROXY: "http://127.0.0.1:1",
    HTTPS_PROXY: "http://127.0.0.1:1",
  };
  const run = async (command: string) => {
    const child = Bun.spawn(["bun", "run", cli, command], {
      cwd: project,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { status, output: stdout + stderr };
  };
  try {
    mkdirSync(project);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({ "cloud-target": true }));
    const missing = await run("deploy");
    expect(missing.status).not.toBe(0);
    expect(missing.output).toContain(
      "Config file not found. Run 'devver init'"
    );
    expect(missing.output).not.toContain("fetch failed");
    expect(existsSync(join(project, ".devver.yaml"))).toBe(false);
    expect(existsSync(join(project, ".gitignore"))).toBe(false);

    const cloudInit = await run("init");
    expect(cloudInit.status).not.toBe(0);
    expect(cloudInit.output).toContain(
      "Cloud config generation requires a reviewed deployment recipe"
    );
    expect(existsSync(join(project, ".devver.yaml"))).toBe(false);
    expect(readFileSync(configPath, "utf-8")).toBe('{"cloud-target":true}');

    writeFileSync(configPath, "{}");
    const noTarget = await run("init");
    expect(noTarget.status).not.toBe(0);
    expect(noTarget.output).toContain(
      "No target selected. Run 'devver attach <url>'"
    );
    expect(readFileSync(configPath, "utf-8")).toBe("{}");

    writeFileSync(
      join(project, "package.json"),
      JSON.stringify({
        dependencies: { next: "1" },
        scripts: { build: "next build", start: "next start" },
      })
    );
    writeFileSync(configPath, JSON.stringify(localTarget));
    const before = readFileSync(configPath, "utf-8");
    const unsupported = await run("init");
    expect(unsupported.status).not.toBe(0);
    expect(unsupported.output).toContain(".: next (meta)");
    expect(unsupported.output).toContain(
      "Only a single root static source is supported"
    );
    expect(existsSync(join(project, ".devver.yaml"))).toBe(false);
    expect(existsSync(join(project, ".gitignore"))).toBe(false);
    expect(readFileSync(configPath, "utf-8")).toBe(before);

    rmSync(join(project, "package.json"));
    writeFileSync(join(project, "index.html"), "<h1>ok</h1>");
    const staticInit = await run("init");
    expect(staticInit.status).toBe(0);
    expect(readFileSync(join(project, ".devver.yaml"), "utf-8")).toBe(
      "static:\n  directory: .\n"
    );
    expect(readFileSync(configPath, "utf-8")).toBe(before);

    const preserved = await run("init");
    expect(preserved.status).toBe(0);
    expect(readFileSync(join(project, ".devver.yaml"), "utf-8")).toBe(
      "static:\n  directory: .\n"
    );
    writeFileSync(join(project, ".devver.yaml"), "not: valid config\n");
    const invalid = await run("init");
    expect(invalid.status).not.toBe(0);
    expect(invalid.output).toContain("Invalid devver config");
    expect(readFileSync(join(project, ".devver.yaml"), "utf-8")).toBe(
      "not: valid config\n"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
