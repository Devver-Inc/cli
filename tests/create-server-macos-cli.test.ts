import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Schema } from "effect";

import pkg from "../package.json";

const repo = join(import.meta.dir, "..");
const cli = join(repo, "packages/cli/dist", "cli.mjs");
const node = Bun.which("node");
const NODE_ONLY = node === null ? "" : `${dirname(node)}:/usr/bin:/bin`;
const CONTROL_URL = /http:\/\/127\.0\.0\.1:\d+\/api\/v1/u;
const decodeIdentity = Schema.decodeUnknownSync(
  Schema.Struct({ name: Schema.String, instanceId: Schema.String })
);
const decodeService = Schema.decodeUnknownSync(
  Schema.Struct({ label: Schema.String })
);

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "devver-macos-"));
  const env = {
    ...process.env,
    PATH: NODE_ONLY,
    XDG_DATA_HOME: join(root, "data"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"),
  };
  const run = (...args: string[]) => {
    if (node === null) {
      throw new Error("Node required for CLI process test");
    }
    const result = Bun.spawnSync([node, cli, ...args], {
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

function launchctl(...args: string[]) {
  const result = Bun.spawnSync(["launchctl", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return { status: result.exitCode, output: result.stdout.toString() };
}

function supervisableDomain() {
  if (process.platform !== "darwin") {
    return null;
  }
  const uid = process.getuid?.();
  if (uid === undefined) {
    return null;
  }
  const domain = `gui/${uid}`;
  return launchctl("print", domain).status === 0 ? domain : null;
}

function describeJob(domain: string, label: string) {
  return launchctl("print", `${domain}/${label}`).output;
}

function bootout(domain: string, label: string) {
  launchctl("bootout", `${domain}/${label}`);
}

async function reachable(url: string) {
  try {
    const response = await fetch(`${url}/identity`, {
      signal: AbortSignal.timeout(2000),
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

if (process.platform === "darwin") {
  const built = Bun.spawnSync(["bun", "run", "build:npm"], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (built.exitCode !== 0) {
    throw new Error(built.stderr.toString());
  }
}

test("macOS launchd keeps named servers ready after CLI exits and attachment is explicit", async () => {
  const domain = supervisableDomain();
  if (domain === null || node === null) {
    return;
  }
  expect(Bun.which("bun", { PATH: NODE_ONLY })).toBeNull();
  const ws = workspace();
  const labels: string[] = [];
  try {
    const urls: string[] = [];
    for (const name of ["default", "other"]) {
      const created =
        name === "default"
          ? ws.run("new", "server")
          : ws.run("new", "server", name);
      const directory = join(ws.root, "data", "devver", "servers", name);
      const service = join(directory, "service.json");
      try {
        labels.push(
          decodeService(JSON.parse(readFileSync(service, "utf-8"))).label
        );
      } catch {
        throw new Error("Could not read service label");
      }
      expect(created.status, created.output).toBe(0);
      const url = CONTROL_URL.exec(created.output)?.[0];
      expect(url).toBeDefined();
      if (url === undefined) {
        throw new Error("No control URL");
      }
      urls.push(url);
      expect(created.output).toContain(`devver attach ${url}`);
      expect(statSync(directory).mode % 0o1000).toBe(0o700);
      expect(statSync(service).mode % 0o1000).toBe(0o600);
      expect(statSync(join(directory, "service.plist")).mode % 0o1000).toBe(
        0o600
      );
      const manifest = readFileSync(join(directory, "service.plist"), "utf-8");
      expect(manifest).toContain(
        "<key>ThrottleInterval</key><integer>30</integer>"
      );
      expect(manifest).toContain("<key>SuccessfulExit</key><false/>");
      expect(manifest).not.toContain("RunAtLoad");
      expect(
        statSync(
          join(
            ws.root,
            "data",
            "devver",
            "installations",
            pkg.version,
            decodeIdentity(await (await fetch(`${url}/identity`)).json())
              .instanceId,
            "server.mjs"
          )
        ).mode % 0o1000
      ).toBe(0o700);
      expect(describeJob(domain, labels.at(-1) ?? "")).toContain(
        "state = running"
      );
      const identity = decodeIdentity(
        await (await fetch(`${url}/identity`)).json()
      );
      expect(identity.name).toBe(name);
      expect(ws.run("new", "server", name).status).not.toBe(0);
      expect(
        decodeIdentity(await (await fetch(`${url}/identity`)).json()).instanceId
      ).toBe(identity.instanceId);
    }
    expect(urls[0]).not.toBe(urls[1]);
    const listed = ws.run("server", "list");
    expect(listed.status, listed.output).toBe(0);
    expect(listed.output).toContain(
      `${urls[0]} — version ${pkg.version}: reachable`
    );
    expect(listed.output).toContain(
      `${urls[1]} — version ${pkg.version}: reachable`
    );
    expect(listed.output).not.toContain("[selected]");
    expect(ws.run("server", "status").output).toContain("No server attached");
    expect(ws.run("attach", urls[0] ?? "").status).toBe(0);
    const selected = ws.run("server", "list");
    expect(selected.output).toContain(
      `${urls[0]} — version ${pkg.version}: reachable [selected]`
    );
    expect(selected.output).toContain(
      `${urls[1]} — version ${pkg.version}: reachable`
    );
    expect(ws.run("server", "status").output).toContain("reachable");
    expect(ws.run("attach", urls[1] ?? "").status).toBe(0);
    expect(ws.run("server", "status").output).toContain("other");
    expect(ws.run("detach").status).toBe(0);
    expect((await fetch(`${urls[1]}/identity`)).ok).toBe(true);
    const failed = ws.run("attach", "http://127.0.0.1:1/api/v1");
    expect(failed.status).not.toBe(0);
    expect(ws.run("server", "status").output).toContain("No server attached");
    bootout(domain, labels.at(-1) ?? "");
    expect(await reachable(urls[1] ?? "")).toBe(false);
    expect(ws.run("server", "list").output).toContain(
      `${urls[1]} — version ${pkg.version}: unreachable`
    );
  } finally {
    for (const label of labels) {
      bootout(domain, label);
    }
    rmSync(ws.root, { recursive: true, force: true });
  }
}, 60_000);
