import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pkg from "../package.json";

const repo = join(import.meta.dir, "..");
const cli = join(repo, "devver");
const packaged = join(repo, "servers", pkg.version, "devver-server");
const NO_RUNTIME = "/usr/bin:/bin";
const CONTROL_URL = /http:\/\/127\.0\.0\.1:\d+\/api\/v1/u;

if (process.platform !== "win32") {
  const built = Bun.spawnSync(["bun", "run", "build"], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (built.exitCode !== 0) {
    throw new Error(built.stderr.toString());
  }
}

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "devver-standalone-"));
  const env = {
    ...process.env,
    PATH: NO_RUNTIME,
    XDG_DATA_HOME: join(root, "data"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"),
  };
  const run = (...args: string[]) => {
    const result = Bun.spawnSync([cli, ...args], {
      cwd: root,
      env,
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

async function launch(env: Record<string, string | undefined>, name: string) {
  const child = Bun.spawn([packaged, name, "0"], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const reader = child.stdout.getReader();
    const announced = await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error("Server did not start"));
        }, 10_000);
      }),
    ]);
    reader.releaseLock();
    const url = new TextDecoder().decode(announced.value).trim();
    if (!CONTROL_URL.test(url)) {
      throw new Error("Server did not announce a control URL");
    }
    return { child, url };
  } catch (error) {
    child.kill();
    await child.exited;
    throw error;
  }
}

const stop = async (child: ReturnType<typeof Bun.spawn>) => {
  child.kill();
  await child.exited;
};

test("the standalone CLI switches between its packaged servers with no runtime installed", async () => {
  if (process.platform === "win32") {
    return;
  }
  expect(Bun.which("node", { PATH: NO_RUNTIME })).toBeNull();
  expect(Bun.which("bun", { PATH: NO_RUNTIME })).toBeNull();
  const ws = workspace();
  const children: ReturnType<typeof Bun.spawn>[] = [];
  try {
    const first = await launch(ws.env, "alpha");
    children.push(first.child);
    const second = await launch(ws.env, "beta");
    children.push(second.child);
    expect(first.url).not.toBe(second.url);
    expect(ws.run("server", "status").output).toContain("No server attached");

    const attached = ws.run("attach", first.url);
    expect(attached.status, attached.output).toBe(0);
    expect(attached.output).toContain(`version ${pkg.version}`);
    const selected = ws.run("server", "status");
    expect(selected.output).toContain("alpha");
    expect(selected.output).toContain(": reachable");

    expect(ws.run("attach", second.url).status).toBe(0);
    const switched = ws.run("server", "status");
    expect(switched.output).toContain("beta");
    expect(switched.output).toContain(second.url);
    expect(switched.output).not.toContain(first.url);

    const failed = ws.run("attach", "http://127.0.0.1:1/api/v1");
    expect(failed.status).not.toBe(0);
    expect(ws.run("server", "status").output).toContain(second.url);

    expect(ws.run("detach").status).toBe(0);
    expect(ws.run("server", "status").output).toContain("No server attached");
    expect((await fetch(`${first.url}/identity`)).status).toBe(200);
    expect((await fetch(`${second.url}/identity`)).status).toBe(200);
  } finally {
    await Promise.all(children.map(stop));
    rmSync(ws.root, { recursive: true, force: true });
  }
}, 30_000);
