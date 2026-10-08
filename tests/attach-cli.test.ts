import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Schema } from "effect";

import pkg from "../package.json" with { type: "json" };

const cli = join(
  import.meta.dir,
  "..",
  "packages",
  "cli",
  "src",
  "cli",
  "index.ts"
);
const server = join(
  import.meta.dir,
  "..",
  "packages",
  "server",
  "src",
  "index.ts"
);
const CONTROL_URL = /^http:\/\/127\.0\.0\.1:\d+\/api\/v1$/u;
const decodeAddress = Schema.decodeUnknownSync(
  Schema.Struct({ port: Schema.Finite })
);

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "devver-attach-"));
  const env = {
    ...process.env,
    XDG_DATA_HOME: root,
    XDG_CONFIG_HOME: root,
    XDG_CACHE_HOME: root,
    XDG_STATE_HOME: root,
  };
  const run = async (...args: string[]) => {
    const result = Bun.spawn(["bun", "run", cli, ...args], {
      cwd: root,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      status: await result.exited,
      output: `${await new Response(result.stdout).text()}${await new Response(result.stderr).text()}`,
    };
  };
  return { root, env, run };
}

async function foreground(
  env: Record<string, string | undefined>,
  name: string
) {
  const child = Bun.spawn(["bun", "run", server, name, "0"], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const reader = child.stdout.getReader();
    const output = await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error("Server did not start"));
        }, 5000);
      }),
    ]);
    reader.releaseLock();
    const url = new TextDecoder().decode(output.value).trim();
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

async function responder(
  status: number,
  body: string,
  headers: Record<string, string> = {}
) {
  const service = createServer((_request, response) => {
    response.writeHead(status, headers).end(body);
  });
  await new Promise<void>((resolve) => {
    service.listen(0, "127.0.0.1", resolve);
  });
  const address = decodeAddress(service.address());
  return { service, url: `http://127.0.0.1:${address.port}/api/v1` };
}

const stop = async (child: ReturnType<typeof Bun.spawn>) => {
  child.kill();
  await child.exited;
};

test("storing api-url fails instead of reporting a routing change it cannot make", async () => {
  if (process.platform === "win32") {
    return;
  }
  const ws = workspace();
  try {
    const stored = await ws.run(
      "config",
      "set",
      "api-url",
      "https://example.org/api/v1"
    );
    expect(stored.status).not.toBe(0);
    expect(stored.output).toContain("no longer selects a target");
    expect(stored.output).toContain("devver attach");
    expect(stored.output).not.toContain("✓");
    // Nothing was persisted, so no later command can read it back as a target.
    const read = await ws.run("config", "get", "api-url");
    expect(read.status).toBe(0);
    expect(read.output).toContain("is not set");
  } finally {
    rmSync(ws.root, { recursive: true, force: true });
  }
});

test("config list renders the attached target without object coercion and marks a legacy api-url inactive", async () => {
  if (process.platform === "win32") {
    return;
  }
  const ws = workspace();
  let running: Awaited<ReturnType<typeof foreground>> | undefined;
  try {
    running = await foreground(ws.env, "listed");
    // A value stored by an older CLI must still decode and stay readable.
    mkdirSync(join(ws.root, "devver", "config"), { recursive: true });
    writeFileSync(
      join(ws.root, "devver", "config", "cli"),
      JSON.stringify({ "api-url": "https://example.org/api/v1" })
    );
    expect((await ws.run("attach", running.url)).status).toBe(0);
    const listed = await ws.run("config", "list");
    expect(listed.status).toBe(0);
    expect(listed.output).toContain(
      "api-url = https://example.org/api/v1 (inactive)"
    );
    expect(listed.output).toContain(`local-target = listed at ${running.url}`);
    expect(listed.output).not.toContain("[object Object]");
    const read = await ws.run("config", "get", "api-url");
    expect(read.status).toBe(0);
    expect(read.output).toContain("https://example.org/api/v1 (inactive)");
    // Clearing a stale value still works, and leaves the verified target alone.
    expect((await ws.run("config", "unset", "api-url")).status).toBe(0);
    const cleared = await ws.run("config", "list");
    expect(cleared.output).not.toContain("api-url");
    expect(cleared.output).toContain(`local-target = listed at ${running.url}`);
  } finally {
    if (running !== undefined) {
      await stop(running.child);
    }
    rmSync(ws.root, { recursive: true, force: true });
  }
});

test("server list reads sorted instances, verifies responders and preserves selection and state", async () => {
  if (process.platform === "win32") {
    return;
  }
  const ws = workspace();
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const services: Server[] = [];
  try {
    const empty = await ws.run("server", "list");
    expect(empty.status).toBe(0);
    expect(empty.output).toContain("No server instances found");
    expect(existsSync(join(ws.root, "devver", "servers"))).toBe(false);
    const second = await foreground(ws.env, "zeta");
    children.push(second.child);
    const first = await foreground(ws.env, "alpha");
    children.push(first.child);
    const uuid = "031fdbdf-3c42-4d19-8909-9a2cf4690cb0";
    const serviceFile = (name: string) =>
      join(ws.root, "devver", "servers", name, "service.json");
    const save = (
      name: string,
      url: string,
      serverVersion = pkg.version,
      port = Number(new URL(url).port)
    ) => {
      const service =
        process.platform === "darwin"
          ? { label: `com.devver.server.${uuid}`, port, serverVersion }
          : { unit: `devver-${uuid}.service`, port, serverVersion };
      writeFileSync(serviceFile(name), JSON.stringify(service), {
        mode: 0o600,
      });
    };
    save("zeta", second.url);
    save("alpha", first.url);
    expect((await ws.run("attach", first.url)).status).toBe(0);
    const configFile = join(ws.root, "devver", "config", "cli");
    const selectedConfig = readFileSync(configFile, "utf-8");
    const listed = await ws.run("server", "list");
    expect(listed.status).toBe(0);
    expect(listed.output.indexOf("alpha (")).toBeLessThan(
      listed.output.indexOf("zeta (")
    );
    expect(listed.output).toContain(
      `${first.url} — version ${pkg.version}: reachable [selected]`
    );
    expect(listed.output).toContain(
      `${second.url} — version ${pkg.version}: reachable`
    );
    save("alpha", first.url, "0.1.0");
    expect((await ws.run("server", "list")).output).toContain(
      `${first.url} — version 0.1.0: mismatched version [selected]`
    );
    save("alpha", first.url);
    expect(readFileSync(configFile, "utf-8")).toBe(selectedConfig);

    await stop(second.child);
    children.pop();
    expect((await ws.run("server", "list")).output).toContain(
      `${second.url} — version ${pkg.version}: unreachable`
    );
    const foreign = await responder(
      200,
      JSON.stringify({
        instanceId: uuid,
        name: "foreign",
        serverVersion: pkg.version,
        controlProtocolVersion: 1,
      })
    );
    services.push(foreign.service);
    save("zeta", foreign.url);
    expect((await ws.run("server", "list")).output).toContain(
      "mismatched identity"
    );
    const older = await responder(
      200,
      JSON.stringify({
        instanceId: uuid,
        name: "zeta",
        serverVersion: "0.1.0",
        controlProtocolVersion: 1,
      })
    );
    services.push(older.service);
    save("zeta", older.url, "0.1.0");
    expect((await ws.run("server", "list")).output).toContain("incompatible");
    const redirect = await responder(302, "", { Location: first.url });
    services.push(redirect.service);
    save("zeta", redirect.url);
    expect((await ws.run("server", "list")).output).toContain(
      `${redirect.url} — version ${pkg.version}: unreachable`
    );

    writeFileSync(serviceFile("zeta"), "private invalid JSON");
    const unsafe = await ws.run("server", "list");
    expect(unsafe.status).not.toBe(0);
    expect(unsafe.output).toContain("zeta");
    expect(unsafe.output).not.toContain("private invalid JSON");
    expect(readFileSync(serviceFile("zeta"), "utf-8")).toBe(
      "private invalid JSON"
    );
    save("zeta", redirect.url, pkg.version, 99_999);
    expect((await ws.run("server", "list")).status).not.toBe(0);
    save("zeta", redirect.url);
    chmodSync(serviceFile("zeta"), 0o644);
    const exposed = await ws.run("server", "list");
    expect(exposed.status).not.toBe(0);
    expect(exposed.output).toContain("zeta");
    chmodSync(serviceFile("zeta"), 0o600);
    expect(readFileSync(configFile, "utf-8")).toBe(selectedConfig);
    writeFileSync(configFile, '{"local-target":{"url":"broken"}}');
    expect((await ws.run("server", "list")).status).not.toBe(0);
    expect(readFileSync(configFile, "utf-8")).toBe(
      '{"local-target":{"url":"broken"}}'
    );
  } finally {
    await Promise.all(children.map(stop));
    await Promise.all(
      services.map(async (service) => {
        await new Promise<void>((resolve) => {
          service.close(() => {
            resolve();
          });
        });
      })
    );
    rmSync(ws.root, { recursive: true, force: true });
  }
}, 30_000);

test("attach switches verified foreground servers across CLI processes and detach leaves them running", async () => {
  if (process.platform === "win32") {
    return;
  }
  const ws = workspace();
  const children: ReturnType<typeof Bun.spawn>[] = [];
  try {
    expect((await ws.run("server", "status")).output).toContain(
      "No server attached"
    );
    const first = await foreground(ws.env, "first");
    children.push(first.child);
    const second = await foreground(ws.env, "second");
    children.push(second.child);
    expect((await ws.run("attach", first.url)).status).toBe(0);
    expect((await ws.run("server", "status")).output).toContain("first");
    expect((await ws.run("server", "status")).output).toContain("reachable");
    expect((await ws.run("attach", second.url)).status).toBe(0);
    const selected = await ws.run("server", "status");
    expect(selected.output).toContain("second");
    expect(selected.output).toContain(second.url);
    expect(selected.output).not.toContain(first.url);
    await stop(second.child);
    children.pop();
    expect((await ws.run("server", "status")).output).toContain("unreachable");
    expect((await ws.run("detach")).status).toBe(0);
    expect((await ws.run("server", "status")).output).toContain(
      "No server attached"
    );
    expect((await fetch(`${first.url}/identity`)).status).toBe(200);
  } finally {
    await Promise.all(children.map(stop));
    rmSync(ws.root, { recursive: true, force: true });
  }
});

test("invalid and incompatible attachments fail without replacing a selected server", async () => {
  if (process.platform === "win32") {
    return;
  }
  const ws = workspace();
  const first = await foreground(ws.env, "original");
  const services: Server[] = [];
  try {
    expect((await ws.run("attach")).status).not.toBe(0);
    expect((await ws.run("attach", first.url)).status).toBe(0);
    const bad = [
      "http://example.com:9000/api/v1",
      "http://localhost:9000/api/v1",
      "http://127.0.0.1:80/api/v1?x=1",
      "http://user@127.0.0.1:80/api/v1",
      "http://127.0.0.1:80/api/v1#fragment",
      "https://127.0.0.1:80/api/v1",
      "http://127.0.0.1:80/api/v1/other",
    ];
    for (const url of bad) {
      expect((await ws.run("attach", url)).status).not.toBe(0);
    }
    const redirect = await responder(302, "", { Location: first.url });
    services.push(redirect.service);
    expect((await ws.run("attach", redirect.url)).status).not.toBe(0);
    // A redirect is never followed, so the responder on the attached URL cannot
    // hand control of the CLI target to any other host.
    const offsite = await responder(302, "", {
      Location: "http://example.com/api/v1/identity",
    });
    services.push(offsite.service);
    const redirected = await ws.run("attach", offsite.url);
    expect(redirected.status).not.toBe(0);
    expect(redirected.output).toContain("HTTP 302");
    const other = await responder(200, "<html><body>hello</body></html>", {
      "Content-Type": "text/html",
    });
    services.push(other.service);
    const foreign = await ws.run("attach", other.url);
    expect(foreign.status).not.toBe(0);
    expect(foreign.output).toContain("identity response is invalid");
    const fake = await responder(
      200,
      JSON.stringify({
        instanceId: "bad",
        name: "fake",
        serverVersion: "0.0.0",
        controlProtocolVersion: 1,
      })
    );
    services.push(fake.service);
    expect((await ws.run("attach", fake.url)).status).not.toBe(0);
    const oversized = await responder(200, "x".repeat(9000));
    services.push(oversized.service);
    expect((await ws.run("attach", oversized.url)).status).not.toBe(0);
    const incompatible = await responder(
      200,
      JSON.stringify({
        instanceId: "031fdbdf-3c42-4d19-8909-9a2cf4690cb0",
        name: "other",
        serverVersion: "0.0.0",
        controlProtocolVersion: 1,
      })
    );
    services.push(incompatible.service);
    expect((await ws.run("attach", incompatible.url)).status).not.toBe(0);
    const wrongProtocol = await responder(
      200,
      JSON.stringify({
        instanceId: "031fdbdf-3c42-4d19-8909-9a2cf4690cb0",
        name: "other",
        serverVersion: "1.2.0",
        controlProtocolVersion: 2,
      })
    );
    services.push(wrongProtocol.service);
    expect((await ws.run("attach", wrongProtocol.url)).status).not.toBe(0);
    expect(
      (await ws.run("attach", "http://127.0.0.1:1/api/v1")).status
    ).not.toBe(0);
    const stalled = createServer(() => {});
    services.push(stalled);
    await new Promise<void>((resolve) => {
      stalled.listen(0, "127.0.0.1", resolve);
    });
    const stalledAddress = decodeAddress(stalled.address());
    const started = Date.now();
    expect(
      (await ws.run("attach", `http://127.0.0.1:${stalledAddress.port}/api/v1`))
        .status
    ).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(6000);
    const selected = await ws.run("server", "status");
    expect(selected.output).toContain("original");
    expect(selected.output).toContain(first.url);

    const configFile = join(ws.root, "devver", "config", "cli");
    const saved = readFileSync(configFile, "utf-8");
    writeFileSync(configFile, '{"local-target":{"url":"broken"}}');
    expect((await ws.run("server", "status")).status).not.toBe(0);
    expect((await ws.run("attach", first.url)).status).not.toBe(0);
    expect((await ws.run("detach")).status).not.toBe(0);
    expect(readFileSync(configFile, "utf-8")).toBe(
      '{"local-target":{"url":"broken"}}'
    );
    writeFileSync(
      configFile,
      saved.replace(first.url, "http://127.0.0.1:99999/api/v1")
    );
    expect((await ws.run("server", "status")).status).not.toBe(0);
    expect((await ws.run("detach")).status).not.toBe(0);
    writeFileSync(configFile, saved);
    expect((await ws.run("server", "status")).output).toContain("original");
  } finally {
    await stop(first.child);
    await Promise.all(
      services.map(async (service) => {
        service.closeAllConnections();
        return new Promise<void>((resolve) => {
          service.close(() => {
            resolve();
          });
        });
      })
    );
    rmSync(ws.root, { recursive: true, force: true });
  }
  // Each rejected responder costs a CLI spawn plus up to the probe timeout, so
  // this budget is well above the ~13s a loaded CI runner needs.
}, 60_000);
