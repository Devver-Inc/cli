import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Schema } from "effect";

import pkg from "../package.json";

const entry = join(
  import.meta.dir,
  "..",
  "packages",
  "server",
  "src",
  "index.ts"
);
const CONTROL_URL = /^http:\/\/127\.0\.0\.1:\d+\/api\/v1$/u;
const decodeIdentity = Schema.decodeUnknownSync(
  Schema.Struct({
    instanceId: Schema.String,
    name: Schema.String,
    serverVersion: Schema.String,
    controlProtocolVersion: Schema.Finite,
  }),
  { onExcessProperty: "error" }
);

function dataEnvironment(root: string) {
  return { ...process.env, XDG_DATA_HOME: root };
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
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error("Server did not announce its URL"));
        }, 5000);
      }),
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
    ({ child } = running);
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
      socket.once("error", () => {
        resolve(false);
      });
      socket.setTimeout(500, () => {
        socket.destroy();
        resolve(false);
      });
    });
    expect(publicListener).toBe(false);
    const identity = await fetch(`${running.url}/identity`);
    expect(identity.status).toBe(200);
    expect(identity.headers.get("cache-control")).toBe("no-store");
    const details = decodeIdentity(await identity.json());
    expect(details.instanceId).toBeString();
    expect(details.name).toBe("demo");
    expect(details.serverVersion).toBe(pkg.version);
    expect(details.controlProtocolVersion).toBe(1);
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
    const duplicateHostStatus = await new Promise<string>((resolve, reject) => {
      const socket = createConnection({
        host: "127.0.0.1",
        port: Number(new URL(running.url).port),
      });
      socket.once("connect", () => {
        socket.write(
          `GET /api/v1/identity HTTP/1.1\r\nHost: ${new URL(running.url).host}\r\nHost: evil.example\r\nConnection: close\r\n\r\n`
        );
      });
      socket.once("data", (data: Buffer) => {
        resolve(data.toString().split("\r\n")[0] ?? "");
        socket.destroy();
      });
      socket.once("error", reject);
      socket.setTimeout(1000, () => {
        socket.destroy();
        reject(new Error("duplicate Host probe timed out"));
      });
    });
    expect(duplicateHostStatus).not.toContain(" 200 ");
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
    const methodNotAllowed = await fetch(`${running.url}/identity`, {
      method: "POST",
    });
    expect(methodNotAllowed.status).toBe(405);
    expect(methodNotAllowed.headers.get("allow")).toBe("GET");
    expect((await fetch(`${running.url}/missing`)).status).toBe(404);
    expect(
      (
        await fetch(`${running.url}/missing`, {
          headers: { Host: "evil.example" },
        })
      ).status
    ).toBe(403);
    for (const path of [
      "/identity",
      "/api/v1/identity/",
      "/api/v1/identity?x=1",
    ]) {
      expect((await fetch(new URL(path, running.url))).status, path).toBe(404);
    }
  } finally {
    child?.kill();
    if (child !== undefined) {
      await child.exited;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
