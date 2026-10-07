import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import pkg from "../package.json";

const repo = join(import.meta.dir, "..");
const cli = join(repo, "packages/cli/dist", "cli.mjs");
const node = Bun.which("node");
// The npm distribution must create and supervise its packaged server on Node
// alone, so the CLI under test runs with Bun absent from PATH.
const NODE_ONLY = node ? `${dirname(node)}:/usr/bin:/bin` : "";
const CONTROL_URL = /http:\/\/127\.0\.0\.1:\d+\/api\/v1/;
const JOB_PID = /\tpid = (\d+)/;

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "devver-macos-"));
  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: NODE_ONLY,
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

// Supervision needs a reachable per-user launchd domain; headless CI may lack one.
function supervisableDomain() {
  if (process.platform !== "darwin") {
    return;
  }
  const uid = process.getuid?.();
  if (uid === undefined) {
    return;
  }
  const domain = `gui/${uid}`;
  return launchctl("print", domain).status === 0 ? domain : undefined;
}

// Empty output means the job is not registered, which every caller asserts against.
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

test("macOS unavailable launchd registration fails without claiming readiness or replacing a name", () => {
  if (process.platform !== "darwin") {
    return;
  }
  const ws = workspace();
  try {
    const fake = join(ws.root, "fake-bin");
    mkdirSync(fake);
    writeFileSync(
      join(fake, "launchctl"),
      '#!/bin/sh\ncase "$1" in bootstrap) exit 1;; print) case "$2" in gui/*/*) exit 1;; gui/*) exit 0;; esac;; bootout) exit 1;; esac\nexit 1\n',
      { mode: 0o700 }
    );
    ws.env.PATH = `${fake}:${process.env.PATH}`;
    const failed = ws.run("new", "server", "failure");
    expect(failed.status).not.toBe(0);
    expect(failed.output).not.toContain("devver attach ");
    expect(failed.output).toContain("macOS launchd user supervision");
    expect(ws.run("server", "status").output).toContain("No server attached");
    const state = join(
      ws.root,
      "data",
      "devver",
      "servers",
      "failure",
      "identity.json"
    );
    expect(existsSync(state)).toBe(false);
  } finally {
    rmSync(ws.root, { recursive: true, force: true });
  }
});

test("macOS failed startup retains state when launchd cannot confirm job removal", () => {
  if (process.platform !== "darwin") {
    return;
  }
  const ws = workspace();
  try {
    const fake = join(ws.root, "fake-bin");
    mkdirSync(fake);
    writeFileSync(
      join(fake, "launchctl"),
      '#!/bin/sh\ncase "$1" in bootstrap) exit 0;; kickstart) exit 1;; print) exit 0;; bootout) exit 1;; esac\nexit 1\n',
      { mode: 0o700 }
    );
    ws.env.PATH = `${fake}:${process.env.PATH}`;
    const failed = ws.run("new", "server", "recover");
    expect(failed.status).not.toBe(0);
    expect(failed.output).toContain("may need recovery");
    expect(failed.output).not.toContain("devver attach ");
    const state = join(
      ws.root,
      "data",
      "devver",
      "servers",
      "recover",
      "identity.json"
    );
    const identity = readFileSync(state, "utf8");
    const duplicate = ws.run("new", "server", "recover");
    expect(duplicate.status).not.toBe(0);
    expect(readFileSync(state, "utf8")).toBe(identity);
  } finally {
    rmSync(ws.root, { recursive: true, force: true });
  }
});

test("macOS cleanup confirms job removal against a verbose launchd domain listing", () => {
  if (process.platform !== "darwin") {
    return;
  }
  const ws = workspace();
  try {
    const fake = join(ws.root, "fake-bin");
    mkdirSync(fake);
    // A real `launchctl print <domain>` dumps every registered service.
    writeFileSync(
      join(fake, "launchctl"),
      '#!/bin/sh\ncase "$1" in bootstrap) exit 0;; kickstart) exit 1;; print) case "$2" in */*/*) exit 113;; *) tr "\\0" "x" < /dev/zero | head -c 120000; exit 0;; esac;; bootout) exit 3;; esac\nexit 1\n',
      { mode: 0o700 }
    );
    ws.env.PATH = `${fake}:${process.env.PATH}`;
    const failed = ws.run("new", "server", "verbose");
    expect(failed.status).not.toBe(0);
    expect(failed.output).not.toContain("devver attach ");
    expect(failed.output).not.toContain("may need recovery");
    expect(failed.output).toContain("state removed");
    const directory = join(ws.root, "data", "devver", "servers", "verbose");
    expect(existsSync(directory)).toBe(false);
  } finally {
    rmSync(ws.root, { recursive: true, force: true });
  }
});

test("macOS registration without a listening server reports failed readiness and removes its job", () => {
  if (process.platform !== "darwin") {
    return;
  }
  const ws = workspace();
  try {
    const fake = join(ws.root, "fake-bin");
    mkdirSync(fake);
    // Registration succeeds but nothing listens, as a crash-on-start job would.
    writeFileSync(
      join(fake, "launchctl"),
      '#!/bin/sh\njob="$XDG_DATA_HOME/registered"\ncase "$1" in bootstrap) : > "$job";; bootout) rm -f "$job";; kickstart) ;; print) case "$2" in */*/*) [ -f "$job" ] || exit 113;; esac;; *) exit 1;; esac\nexit 0\n',
      { mode: 0o700 }
    );
    ws.env.PATH = `${fake}:${process.env.PATH}`;
    const failed = ws.run("new", "server", "silent");
    expect(failed.status).not.toBe(0);
    expect(failed.output).not.toContain("devver attach ");
    expect(failed.output).toContain("failed readiness");
    expect(existsSync(join(ws.root, "data", "registered"))).toBe(false);
    expect(
      existsSync(join(ws.root, "data", "devver", "servers", "silent"))
    ).toBe(false);
  } finally {
    rmSync(ws.root, { recursive: true, force: true });
  }
}, 30_000);

test("macOS launchd keeps named servers ready after CLI exits and attachment is explicit", async () => {
  const domain = supervisableDomain();
  if (!(domain && node)) {
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
        labels.push(JSON.parse(readFileSync(service, "utf8")).label);
      } catch {
        /* no registration */
      }
      expect(created.status, created.output).toBe(0);
      const url = created.output.match(CONTROL_URL)?.[0];
      expect(url).toBeDefined();
      if (!url) {
        throw new Error("No control URL");
      }
      urls.push(url);
      expect(created.output).toContain(`devver attach ${url}`);
      expect(statSync(directory).mode % 0o1000).toBe(0o700);
      expect(statSync(service).mode % 0o1000).toBe(0o600);
      expect(statSync(join(directory, "service.plist")).mode % 0o1000).toBe(
        0o600
      );
      const manifest = readFileSync(join(directory, "service.plist"), "utf8");
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
            "server.mjs"
          )
        ).mode % 0o1000
      ).toBe(0o700);
      // Readiness is only truthful if launchd, not the exited CLI, owns the process.
      expect(describeJob(domain, labels.at(-1) ?? "")).toContain(
        "state = running"
      );
      const identity = await (await fetch(`${url}/identity`)).json();
      expect(identity.name).toBe(name);
      expect(ws.run("new", "server", name).status).not.toBe(0);
      expect((await (await fetch(`${url}/identity`)).json()).instanceId).toBe(
        identity.instanceId
      );
    }
    expect(urls[0]).not.toBe(urls[1]);
    expect(ws.run("server", "status").output).toContain("No server attached");
    expect(ws.run("attach", urls[0] ?? "").status).toBe(0);
    expect(ws.run("server", "status").output).toContain("reachable");
    expect(ws.run("attach", urls[1] ?? "").status).toBe(0);
    expect(ws.run("server", "status").output).toContain("other");
    expect(ws.run("detach").status).toBe(0);
    expect((await fetch(`${urls[1]}/identity`)).ok).toBe(true);
  } finally {
    for (const label of labels) {
      bootout(domain, label);
    }
    rmSync(ws.root, { recursive: true, force: true });
  }
}, 60_000);

test("macOS launchd restarts an unsuccessful server exit at a bounded rate", async () => {
  const domain = supervisableDomain();
  if (!(domain && node)) {
    return;
  }
  const ws = workspace();
  let label = "";
  try {
    const created = ws.run("new", "server", "restarted");
    expect(created.status, created.output).toBe(0);
    const url = created.output.match(CONTROL_URL)?.[0];
    if (!url) {
      throw new Error("No control URL");
    }
    label = JSON.parse(
      readFileSync(
        join(ws.root, "data", "devver", "servers", "restarted", "service.json"),
        "utf8"
      )
    ).label;
    const identity = await (await fetch(`${url}/identity`)).json();
    const pid = Number(describeJob(domain, label).match(JOB_PID)?.[1]);
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    process.kill(pid, "SIGKILL");
    await Bun.sleep(5000);
    // ThrottleInterval=30 rate-bounds relaunch: no instant respawn loop.
    expect(await reachable(url)).toBe(false);
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !(await reachable(url))) {
      await Bun.sleep(1000);
    }
    expect(await reachable(url)).toBe(true);
    expect((await (await fetch(`${url}/identity`)).json()).instanceId).toBe(
      identity.instanceId
    );
    expect(describeJob(domain, label)).toContain("state = running");
  } finally {
    if (label) {
      bootout(domain, label);
    }
    rmSync(ws.root, { recursive: true, force: true });
  }
}, 120_000);
