import { expect, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json";

const entry = join(import.meta.dir, "..", "src", "server", "index.ts");
const CONTROL_URL = /^http:\/\/127\.0\.0\.1:\d+\/api\/v1$/;

function dataEnvironment(root: string) {
  return { ...process.env, XDG_DATA_HOME: root };
}

function run(root: string, name: string) {
  const result = Bun.spawnSync(["bun", "run", entry, name, "0"], {
    env: dataEnvironment(root),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    status: result.exitCode,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
  };
}

async function launch(root: string, name: string) {
  const child = Bun.spawn(["bun", "run", entry, name, "0"], {
    env: dataEnvironment(root),
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = child.stdout.getReader();
  try {
    const output = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("Server did not announce its URL")),
          5000
        )
      ),
    ]);
    const url = new TextDecoder().decode(output.value).trim();
    reader.releaseLock();
    return { child, url };
  } catch (error) {
    child.kill();
    await child.exited;
    throw error;
  }
}

test("a foreground server serves identity on loopback and rejects browser cross-site requests", async () => {
  if (process.platform === "win32") {
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "devver-server-"));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const running = await launch(root, "demo");
    child = running.child;
    expect(running.url).toMatch(CONTROL_URL);
    const publicListener = await new Promise<boolean>((resolve) => {
      const socket = createConnection({
        host: "127.0.0.2",
        port: Number(new URL(running.url).port),
      });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
      socket.setTimeout(500, () => {
        socket.destroy();
        resolve(false);
      });
    });
    expect(publicListener).toBe(false);
    const identity = await fetch(`${running.url}/identity`);
    expect(identity.status).toBe(200);
    expect(await identity.json()).toEqual({
      instanceId: expect.any(String),
      name: "demo",
      serverVersion: pkg.version,
      controlProtocolVersion: 1,
    });
    expect(
      (
        await fetch(`${running.url}/identity`, {
          headers: { Host: "evil.example" },
        })
      ).status
    ).toBe(403);
    expect(
      (
        await fetch(`${running.url}/identity`, {
          headers: { Origin: "https://evil.example" },
        })
      ).status
    ).toBe(403);
    expect(
      (
        await fetch(`${running.url}/identity`, {
          headers: { "Sec-Fetch-Site": "cross-site" },
        })
      ).status
    ).toBe(403);
    expect(
      (
        await fetch(`${running.url}/identity`, {
          headers: { Origin: new URL(running.url).origin },
        })
      ).status
    ).toBe(200);
    expect(
      (await fetch(`${running.url}/identity`, { method: "POST" })).status
    ).toBe(405);
    expect((await fetch(`${running.url}/missing`)).status).toBe(404);
  } finally {
    child?.kill();
    if (child) {
      await child.exited;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("named server identities survive restarts without sharing or replacing corrupt state", async () => {
  if (process.platform === "win32") {
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "devver-server-state-"));
  const file = (name: string) =>
    join(root, "devver", "servers", name, "identity.json");
  const id = async (url: string) => {
    const result: unknown = await (await fetch(`${url}/identity`)).json();
    if (
      typeof result !== "object" ||
      result === null ||
      !("instanceId" in result) ||
      typeof result.instanceId !== "string"
    ) {
      throw new Error("Invalid identity response");
    }
    return result.instanceId;
  };
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const first = await launch(root, "first");
    child = first.child;
    expect(first.url).toMatch(CONTROL_URL);
    const firstId = await id(first.url);
    child.kill();
    await child.exited;
    child = undefined;

    const restarted = await launch(root, "first");
    child = restarted.child;
    expect(await id(restarted.url)).toBe(firstId);
    child.kill();
    await child.exited;
    child = undefined;

    const second = await launch(root, "second");
    child = second.child;
    expect(await id(second.url)).not.toBe(firstId);
    expect(statSync(join(root, "devver")).mode % 0o1000).toBe(0o700);
    expect(statSync(join(root, "devver", "servers")).mode % 0o1000).toBe(0o700);
    expect(
      statSync(join(root, "devver", "servers", "first")).mode % 0o1000
    ).toBe(0o700);
    expect(statSync(file("first")).mode % 0o1000).toBe(0o600);
    child.kill();
    await child.exited;
    child = undefined;

    writeFileSync(file("first"), "invalid JSON");
    const corrupted = run(root, "first");
    expect(corrupted.status).not.toBe(0);
    expect(corrupted.output).toContain("invalid state");
    expect(readFileSync(file("first"), "utf8")).toBe("invalid JSON");
    writeFileSync(
      file("first"),
      JSON.stringify({ instanceId: firstId, name: "first" })
    );
    chmodSync(file("first"), 0o644);
    const exposed = run(root, "first");
    expect(exposed.status).not.toBe(0);
    expect(exposed.output).toContain("owner-only");
    expect(statSync(file("first")).mode % 0o1000).toBe(0o644);
    expect(run(root, "../escape").status).not.toBe(0);
  } finally {
    child?.kill();
    if (child) {
      await child.exited;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy read-only data roots work; writable or symlinked roots cannot replace state", async () => {
  if (process.platform === "win32") {
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "devver-server-root-"));
  const data = join(root, "data");
  const real = join(root, "real");
  const state = JSON.stringify({
    instanceId: "031fdbdf-3c42-4d19-8909-9a2cf4690cb0",
    name: "demo",
  });
  const putState = (directory: string) => {
    const instance = join(directory, "servers", "demo");
    mkdirSync(instance, { recursive: true, mode: 0o700 });
    writeFileSync(join(instance, "identity.json"), state, { mode: 0o600 });
    return join(instance, "identity.json");
  };
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    mkdirSync(data);
    const dataRoot = join(data, "devver");
    mkdirSync(dataRoot, { mode: 0o700 });
    const file = putState(dataRoot);
    chmodSync(dataRoot, 0o755);
    const legacy = await launch(data, "demo");
    child = legacy.child;
    expect(await (await fetch(`${legacy.url}/identity`)).json()).toMatchObject({
      instanceId: "031fdbdf-3c42-4d19-8909-9a2cf4690cb0",
      name: "demo",
    });
    child.kill();
    await child.exited;
    child = undefined;
    expect(statSync(dataRoot).mode % 0o1000).toBe(0o755);
    expect(readFileSync(file, "utf8")).toBe(state);

    chmodSync(dataRoot, 0o777);
    const writable = run(data, "demo");
    expect(writable.status).not.toBe(0);
    expect(writable.output).toContain("not group/other writable");
    expect(statSync(dataRoot).mode % 0o1000).toBe(0o777);
    expect(readFileSync(file, "utf8")).toBe(state);

    rmSync(dataRoot, { recursive: true });
    mkdirSync(real, { mode: 0o700 });
    const linkedFile = putState(real);
    symlinkSync(real, dataRoot);
    const linked = run(data, "demo");
    expect(linked.status).not.toBe(0);
    expect(linked.output).toContain("not a symlink");
    expect(lstatSync(dataRoot).isSymbolicLink()).toBe(true);
    expect(readFileSync(linkedFile, "utf8")).toBe(state);
  } finally {
    child?.kill();
    if (child) {
      await child.exited;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows rejects untrusted XDG data overrides instead of storing server state there", () => {
  if (process.platform !== "win32") {
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "devver-server-win-"));
  try {
    const result = run(root, "demo");
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("does not accept XDG_DATA_HOME overrides");
    expect(() => statSync(join(root, "devver", "servers", "demo"))).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
