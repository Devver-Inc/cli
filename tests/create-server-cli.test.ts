import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json";

const repo = join(import.meta.dir, "..");
const cli = join(repo, "dist", "cli.mjs");
const node = Bun.which("node");
const CONTROL_URL = /http:\/\/127\.0\.0\.1:\d+\/api\/v1/;

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "devver-create-"));
  const env: Record<string, string | undefined> = {
    ...process.env,
    XDG_DATA_HOME: join(root, "data"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"),
  };
  const run = (...args: string[]) => {
    if (!node) {
      throw new Error("Node required for CLI process test");
    }
    const result = Bun.spawnSync([node, cli, ...args], {
      env,
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      status: result.exitCode,
      output: result.stdout.toString() + result.stderr.toString(),
    };
  };
  return { root, env, run };
}

const built = Bun.spawnSync(["bun", "run", "build:npm"], {
  cwd: repo,
  stdout: "pipe",
  stderr: "pipe",
});
if (built.exitCode !== 0) {
  throw new Error(built.stderr.toString());
}

test("new server fails clearly on platforms without Linux user supervision", () => {
  if (process.platform === "linux") {
    return;
  }
  const ws = workspace();
  try {
    const result = ws.run("new", "server");
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("Linux");
    expect(ws.run("server", "status").output).toContain("No server attached");
  } finally {
    rmSync(ws.root, { recursive: true, force: true });
  }
});

test("failed user manager registration does not report readiness or leave a named instance", () => {
  if (process.platform !== "linux") {
    return;
  }
  const ws = workspace();
  try {
    const fake = join(ws.root, "fake-bin");
    mkdirSync(fake);
    writeFileSync(join(fake, "systemd-run"), "#!/bin/sh\nexit 1\n", {
      mode: 0o700,
    });
    writeFileSync(join(fake, "systemctl"), "#!/bin/sh\nexit 0\n", {
      mode: 0o700,
    });
    ws.env.PATH = `${fake}:${process.env.PATH}`;
    const result = ws.run("new", "server", "failed");
    expect(result.status).not.toBe(0);
    expect(result.output).not.toContain("devver attach ");
    expect(ws.run("server", "status").output).toContain("No server attached");
    expect(() =>
      readFileSync(
        join(ws.root, "data", "devver", "servers", "failed", "identity.json")
      )
    ).toThrow();
  } finally {
    rmSync(ws.root, { recursive: true, force: true });
  }
});

test("a native user manager keeps distinct named servers reachable after creation exits", async () => {
  if (process.platform !== "linux" || !node || !Bun.which("systemctl")) {
    return;
  }
  const manager = Bun.spawnSync(["systemctl", "--user", "show-environment"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (manager.exitCode !== 0) {
    return;
  }
  const ws = workspace();
  const units: string[] = [];
  const urls: string[] = [];
  try {
    for (const name of ["default", "other"]) {
      const created =
        name === "default"
          ? ws.run("new", "server")
          : ws.run("new", "server", name);
      const serviceFile = join(
        ws.root,
        "data",
        "devver",
        "servers",
        name,
        "service.json"
      );
      if (created.status === 0) {
        units.push(JSON.parse(readFileSync(serviceFile, "utf8")).unit);
      }
      expect(created.status, created.output).toBe(0);
      const url = created.output.match(CONTROL_URL)?.[0];
      expect(url).toBeDefined();
      expect(created.output).toContain(`devver attach ${url}`);
      if (url) {
        urls.push(url);
      }
      const identity = await (await fetch(`${url}/identity`)).json();
      expect(identity.name).toBe(name);
      const state = JSON.parse(
        readFileSync(
          join(ws.root, "data", "devver", "servers", name, "service.json"),
          "utf8"
        )
      );
      expect(state.unit).toBe(units.at(-1));
      expect(
        statSync(join(ws.root, "data", "devver", "servers", name)).mode % 0o1000
      ).toBe(0o700);
      expect(
        statSync(
          join(ws.root, "data", "devver", "servers", name, "service.json")
        ).mode % 0o1000
      ).toBe(0o600);
      expect(
        statSync(
          join(
            ws.root,
            "data",
            "devver",
            "installations",
            pkg.version,
            "server.mjs"
          )
        ).mode % 0o1000
      ).toBe(0o700);
      const duplicate = ws.run("new", "server", name);
      expect(duplicate.status).not.toBe(0);
      expect((await (await fetch(`${url}/identity`)).json()).instanceId).toBe(
        identity.instanceId
      );
    }
    expect(urls[0]).not.toBe(urls[1]);
    expect(ws.run("server", "status").output).toContain("No server attached");
  } finally {
    for (const unit of units) {
      Bun.spawnSync(["systemctl", "--user", "stop", unit]);
    }
    rmSync(ws.root, { recursive: true, force: true });
  }
}, 40_000);
