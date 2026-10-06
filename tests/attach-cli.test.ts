import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(import.meta.dir, "..", "src", "cli", "index.ts");
const server = join(import.meta.dir, "..", "src", "server", "index.ts");
const CONTROL_URL = /^http:\/\/127\.0\.0\.1:\d+\/api\/v1$/;

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
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Server did not start")), 5000)
      ),
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
  const service = createServer((_request, response) =>
    response.writeHead(status, headers).end(body)
  );
  await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
  const address = service.address();
  if (!address || typeof address === "string") {
    throw new Error("Not listening");
  }
  return { service, url: `http://127.0.0.1:${address.port}/api/v1` };
}

const stop = async (child: ReturnType<typeof Bun.spawn>) => {
  child.kill();
  await child.exited;
};

test("config list renders the attached target without object coercion and keeps api-url readable", async () => {
  if (process.platform === "win32") {
    return;
  }
  const ws = workspace();
  let running: Awaited<ReturnType<typeof foreground>> | undefined;
  try {
    running = await foreground(ws.env, "listed");
    expect(
      (await ws.run("config", "set", "api-url", "https://example.org/api/v1"))
        .status
    ).toBe(0);
    expect((await ws.run("attach", running.url)).status).toBe(0);
    const listed = await ws.run("config", "list");
    expect(listed.status).toBe(0);
    expect(listed.output).toContain("api-url = https://example.org/api/v1");
    expect(listed.output).toContain(`local-target = listed at ${running.url}`);
    expect(listed.output).not.toContain("[object Object]");
  } finally {
    if (running) {
      await stop(running.child);
    }
    rmSync(ws.root, { recursive: true, force: true });
  }
});

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
    const stalled = createServer(() => undefined);
    services.push(stalled);
    await new Promise<void>((resolve) =>
      stalled.listen(0, "127.0.0.1", resolve)
    );
    const stalledAddress = stalled.address();
    if (!stalledAddress || typeof stalledAddress === "string") {
      throw new Error("Not listening");
    }
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
    const saved = readFileSync(configFile, "utf8");
    writeFileSync(configFile, '{"local-target":{"url":"broken"}}');
    expect((await ws.run("server", "status")).status).not.toBe(0);
    expect((await ws.run("attach", first.url)).status).not.toBe(0);
    expect((await ws.run("detach")).status).not.toBe(0);
    expect(readFileSync(configFile, "utf8")).toBe(
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
      services.map((service) => {
        service.closeAllConnections();
        return new Promise<void>((resolve) => service.close(() => resolve()));
      })
    );
    rmSync(ws.root, { recursive: true, force: true });
  }
}, 15_000);
