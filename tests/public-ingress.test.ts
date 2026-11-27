import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Schema } from "effect";

import { openPublicIngress } from "../packages/server/public-ingress";

const isTcpAddress = (
  address: AddressInfo | string | null
): address is AddressInfo => address !== null && typeof address !== "string";

const decodeSummary = Schema.decodeUnknownSync(
  Schema.Struct({
    bunGlobal: Schema.Boolean,
    switched: Schema.Boolean,
    forwardedHost: Schema.NullOr(Schema.String),
    wrongHostRejected: Schema.Boolean,
    revoked: Schema.Boolean,
  })
);

const servers: Server[] = [];
const ingresses: Awaited<ReturnType<typeof openPublicIngress>>[] = [];

afterEach(async () => {
  for (const ingress of ingresses.splice(0)) {
    await ingress.close();
  }
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
      server.closeAllConnections();
    });
  }
});

const app = async () => {
  const server = createServer((incoming, response) => {
    response.end(`${incoming.headers.host} ${incoming.url}`);
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!isTcpAddress(address)) {
    throw new Error("App listener did not bind");
  }
  return `http://deployment.instance.localhost:${address.port}/`;
};

const get = async (target: string, host: string | string[]) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const incoming = request(`http://${target}/path`, {
      headers: Array.isArray(host)
        ? host.flatMap((value) => ["Host", value])
        : { Host: host },
    });
    incoming.on("response", (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      response.on("end", () => {
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString(),
        });
      });
    });
    incoming.on("error", reject);
    incoming.end();
  });

test("only registered public hostnames reach their app", async () => {
  const first = await app();
  const second = await app();
  const ingress = await openPublicIngress();
  ingresses.push(ingress);
  ingress.add("a.identity.tunnels.devver.app", first);
  ingress.add("b.identity.tunnels.devver.app", second);
  expect(await get(ingress.target, "a.identity.tunnels.devver.app")).toEqual({
    status: 200,
    body: `${new URL(first).host} /path`,
  });
  expect(await get(ingress.target, "b.identity.tunnels.devver.app")).toEqual({
    status: 200,
    body: `${new URL(second).host} /path`,
  });
  ingress.remove("b.identity.tunnels.devver.app");
  expect(await get(ingress.target, "b.identity.tunnels.devver.app")).toEqual({
    status: 404,
    body: "",
  });
  expect(
    await get(ingress.target, "other.identity.tunnels.devver.app")
  ).toEqual({
    status: 404,
    body: "",
  });
  expect(
    await get(ingress.target, [
      "preview.identity.tunnels.devver.app",
      "other.identity.tunnels.devver.app",
    ])
  ).toEqual({ status: 404, body: "" });
});

test("removing a host disconnects its active HTTP stream", async () => {
  const server = createServer((_incoming, response) => {
    response.writeHead(200);
    response.write("streaming");
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!isTcpAddress(address)) {
    throw new Error("Stream app did not bind");
  }
  const ingress = await openPublicIngress();
  ingresses.push(ingress);
  ingress.add(
    "stream.identity.tunnels.devver.app",
    `http://app.localhost:${address.port}/`
  );
  const closed = Promise.withResolvers<undefined>();
  const incoming = request(`http://${ingress.target}/`, {
    headers: { Host: "stream.identity.tunnels.devver.app" },
    agent: false,
  });
  const started = new Promise<void>((resolve, reject) => {
    incoming.on("error", reject);
    incoming.on("response", (response) => {
      response.on("error", () => undefined);
      response.on("close", () => {
        closed.resolve(undefined);
      });
      response.once("data", () => {
        resolve();
      });
    });
  });
  incoming.end();
  await started;
  ingress.remove("stream.identity.tunnels.devver.app");
  await closed.promise;
  expect(
    await get(ingress.target, "stream.identity.tunnels.devver.app")
  ).toEqual({ status: 404, body: "" });
});

test("upgrade traffic is forwarded and host-isolated (Node runtime)", () => {
  const node = Bun.which("node");
  if (node === null) {
    throw new Error("node is required for the WebSocket upgrade proxy test");
  }
  const driver = join(
    import.meta.dir,
    "fixtures",
    "public-ingress-upgrade-driver.ts"
  );
  const out = mkdtempSync(join(tmpdir(), "devver-ingress-"));
  try {
    const bundle = join(out, "driver.mjs");
    const build = Bun.spawnSync(
      [
        "bun",
        "build",
        driver,
        "--target=node",
        "--format=esm",
        `--outfile=${bundle}`,
      ],
      { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" }
    );
    expect(build.exitCode, build.stderr.toString()).toBe(0);
    const run = Bun.spawnSync([node, bundle], {
      cwd: out,
      env: { PATH: dirname(node) },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.exitCode, run.stderr.toString()).toBe(0);
    const summary = decodeSummary(
      JSON.parse(run.stdout.toString().trim().split("\n").at(-1) ?? "null")
    );
    expect(summary.bunGlobal).toBe(false);
    expect(summary.switched).toBe(true);
    expect(summary.forwardedHost).toMatch(
      /^deployment\.instance\.localhost:\d+$/u
    );
    expect(summary.wrongHostRejected).toBe(true);
    expect(summary.revoked).toBe(true);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
