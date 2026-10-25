import { expect, test } from "bun:test";
import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Schema } from "effect";

import pkg from "../package.json";

const repo = join(import.meta.dir, "..");
const CONTROL_URL = /http:\/\/127\.0\.0\.1:\d+\/api\/v1/u;
const decodeIdentity = Schema.decodeUnknownSync(
  Schema.Struct({ name: Schema.String, instanceId: Schema.String })
);
const decodeService = Schema.decodeUnknownSync(
  Schema.Struct({ unit: Schema.String })
);

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "devver-create-"));
  const env = {
    ...process.env,
    PATH: process.env.PATH ?? "",
    XDG_DATA_HOME: join(root, "data"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"),
  };
  return { root, env };
}

test("installed npm bin pins and starts its server after the CLI exits", async () => {
  if (process.platform !== "linux") {
    return;
  }
  const ws = workspace();
  let foreign: Server | undefined;
  try {
    const installed = join(ws.root, "installed");
    const packed = Bun.spawnSync(
      [
        "npm",
        "pack",
        "--workspace",
        "@devver-inc/cli",
        "--workspace",
        `@devver-inc/cli-${process.platform}-${process.arch}`,
        "--ignore-scripts",
        "--offline",
        "--pack-destination",
        ws.root,
      ],
      {
        cwd: repo,
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    expect(packed.exitCode, packed.stderr.toString()).toBe(0);
    const archives = packed.stdout
      .toString()
      .trim()
      .split("\n")
      .map((name) => join(ws.root, name));
    expect(archives).toHaveLength(2);
    const install = Bun.spawnSync(
      [
        "npm",
        "install",
        "--ignore-scripts",
        "--offline",
        "--no-audit",
        "--no-fund",
        "--prefix",
        installed,
        ...archives,
      ],
      {
        cwd: ws.root,
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    expect(install.exitCode, install.stderr.toString()).toBe(0);
    const bin = join(installed, "node_modules", ".bin", "devver");
    expect(lstatSync(bin).isSymbolicLink()).toBe(true);
    const fake = join(ws.root, "fake-bin");
    mkdirSync(fake);
    writeFileSync(
      join(fake, "systemd-run"),
      '#!/bin/sh\nfor arg do case "$arg" in --unit=*) unit="$(printf "%s" "$arg" | cut -d= -f2)";; esac; done\nwhile [ "$1" != "--" ]; do shift; done\nshift\n"$@" >/dev/null 2>&1 &\necho "$!" > "$XDG_DATA_HOME/$unit.pid"\n',
      { mode: 0o700 }
    );
    writeFileSync(
      join(fake, "systemctl"),
      '#!/bin/sh\ncase "$2" in is-active) kill -0 "$(cat "$XDG_DATA_HOME/$4.pid")";; stop) kill "$(cat "$XDG_DATA_HOME/$3.pid")";; esac\n',
      { mode: 0o700 }
    );
    ws.env.PATH = `${fake}:/usr/bin:/bin`;
    expect(Bun.which("bun", { PATH: ws.env.PATH })).toBeNull();
    expect(Bun.which("node", { PATH: ws.env.PATH })).toBeNull();
    const runInstalled = (...args: string[]) => {
      const result = Bun.spawnSync([bin, ...args], {
        env: ws.env,
        cwd: ws.root,
        stdout: "pipe",
        stderr: "pipe",
      });
      return {
        status: result.exitCode,
        output: result.stdout.toString() + result.stderr.toString(),
      };
    };
    const urls: string[] = [];
    const instanceIds: string[] = [];
    const packagedServer = join(
      installed,
      "node_modules",
      "@devver-inc",
      `cli-${process.platform}-${process.arch}`,
      "servers",
      pkg.version,
      "devver-server"
    );
    for (const name of ["installed", "second"]) {
      const created = runInstalled("new", "server", name);
      expect(created.status, created.output).toBe(0);
      const url = CONTROL_URL.exec(created.output)?.[0];
      if (url === undefined) {
        throw new Error("No control URL");
      }
      urls.push(url);
      expect(created.output).toContain(`Server ready and attached at ${url}`);
      expect(created.output).not.toContain("devver attach");
      expect(runInstalled("server", "status").output).toContain(`${name} (`);
      const identity = decodeIdentity(
        await (await fetch(`${url}/identity`)).json()
      );
      expect(identity.name).toBe(name);
      instanceIds.push(identity.instanceId);
      const pinned = join(
        ws.root,
        "data",
        "devver",
        "installations",
        pkg.version,
        identity.instanceId,
        "devver-server"
      );
      expect(readFileSync(pinned).equals(readFileSync(packagedServer))).toBe(
        true
      );
      if (name === "installed") {
        appendFileSync(packagedServer, "\n// subsequent local build\n");
      }
    }
    const listed = runInstalled("server", "list");
    expect(listed.status, listed.output).toBe(0);
    expect(listed.output).toContain(`installed (`);
    expect(listed.output).toContain(
      `${urls[0]} — version ${pkg.version}: reachable`
    );
    expect(listed.output).toContain(`second (`);
    expect(listed.output).toContain(
      `${urls[1]} — version ${pkg.version}: reachable`
    );
    expect(runInstalled("server", "status").output).not.toContain(
      "No server attached"
    );
    expect(runInstalled("attach", urls[0] ?? "").status).toBe(0);
    const selected = runInstalled("server", "list");
    expect(selected.output).toContain(
      `${urls[0]} — version ${pkg.version}: reachable [selected]`
    );
    expect(selected.output).toContain(
      `${urls[1]} — version ${pkg.version}: reachable`
    );
    expect(runInstalled("server", "status").output).toContain("installed");
    const serviceFile = join(
      ws.root,
      "data",
      "devver",
      "servers",
      "second",
      "service.json"
    );
    const secondService = Schema.decodeUnknownSync(
      Schema.Struct({ unit: Schema.String })
    )(JSON.parse(readFileSync(serviceFile, "utf-8")));
    const secondPid = Number(
      readFileSync(join(ws.root, "data", `${secondService.unit}.pid`), "utf-8")
    );
    process.kill(secondPid);
    expect(runInstalled("server", "list").output).toContain(
      `${urls[1]} — version ${pkg.version}: unreachable`
    );
    foreign = createServer((_request, response) => {
      response.end(
        JSON.stringify({
          instanceId: crypto.randomUUID(),
          name: "second",
          serverVersion: pkg.version,
          controlProtocolVersion: 1,
        })
      );
    });
    await new Promise<void>((resolve) => {
      foreign?.listen(0, "127.0.0.1", resolve);
    });
    const address = Schema.decodeUnknownSync(
      Schema.Struct({ port: Schema.Finite })
    )(foreign.address());
    writeFileSync(
      serviceFile,
      JSON.stringify({
        ...secondService,
        port: address.port,
        serverVersion: pkg.version,
      })
    );
    const probing = Bun.spawn([bin, "server", "list"], {
      env: ws.env,
      cwd: ws.root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = `${await new Response(probing.stdout).text()}${await new Response(probing.stderr).text()}`;
    expect(await probing.exited, output).toBe(0);
    expect(output).toContain("mismatched identity");
    expect(runInstalled("server", "status").output).toContain("installed");
    const pinned = join(
      ws.root,
      "data",
      "devver",
      "installations",
      pkg.version,
      instanceIds[0] ?? "",
      "devver-server"
    );
    expect(statSync(pinned).mode % 0o1000).toBe(0o700);
    expect(readFileSync(pinned).equals(readFileSync(packagedServer))).toBe(
      false
    );
  } finally {
    if (foreign !== undefined) {
      await new Promise<void>((resolve) => {
        foreign?.close(() => {
          resolve();
        });
      });
    }
    const servers = join(ws.root, "data", "devver", "servers");
    for (const name of ["installed", "second"]) {
      try {
        const service = decodeService(
          JSON.parse(readFileSync(join(servers, name, "service.json"), "utf-8"))
        );
        const pid = Number(
          readFileSync(join(ws.root, "data", `${service.unit}.pid`), "utf-8")
        );
        if (Number.isSafeInteger(pid) && pid > 0) {
          process.kill(pid);
        }
      } catch {
        continue;
      }
    }
    rmSync(ws.root, { recursive: true, force: true });
  }
}, 60_000);
