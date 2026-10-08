import { expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { Schema } from "effect";

import pkg from "../package.json";

const repo = join(import.meta.dir, "..");
const cli = join(repo, "packages/cli/dist", "cli.mjs");
const node = Bun.which("node");
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
  const invoke = (preload: string[], args: string[]) => {
    if (node === null) {
      throw new Error("Node required for CLI process test");
    }
    const result = Bun.spawnSync([node, ...preload, cli, ...args], {
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
  const run = (...args: string[]) => invoke([], args);
  // Reports the platform the CLI dispatches on before its entry point runs.
  // This proves which creator a platform reaches; it proves nothing about
  // whether that platform's service manager works on this host.
  const runAs = (platform: string, ...args: string[]) => {
    const preload = join(root, `platform-${platform}.mjs`);
    writeFileSync(
      preload,
      `Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });\n`
    );
    return invoke(["--import", pathToFileURL(preload).href], args);
  };
  return { root, env, run, runAs };
}

const built = Bun.spawnSync(["bun", "run", "build:npm"], {
  cwd: repo,
  stdout: "pipe",
  stderr: "pipe",
});
if (built.exitCode !== 0) {
  throw new Error(built.stderr.toString());
}

test("npm server bundle does not enter the source TypeScript program", () => {
  const result = Bun.spawnSync(["bun", "run", "typecheck"], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
});

test("new server routes every supported platform to its own creator and fails clearly elsewhere", () => {
  const ws = workspace();
  try {
    const fake = join(ws.root, "fake-bin");
    mkdirSync(fake);
    // Every service manager fails, so each platform's creator is identified by
    // its own failure without registering supervision on this host.
    writeFileSync(
      join(fake, "launchctl"),
      '#!/bin/sh\ncase "$1" in print) case "$2" in */*/*) exit 1;; *) exit 0;; esac;; esac\nexit 1\n',
      { mode: 0o700 }
    );
    writeFileSync(join(fake, "systemd-run"), "#!/bin/sh\nexit 1\n", {
      mode: 0o700,
    });
    writeFileSync(
      join(fake, "systemctl"),
      '#!/bin/sh\ncase "$*" in *show*) echo not-found; exit 0;; esac\nexit 1\n',
      { mode: 0o700 }
    );
    ws.env.PATH = `${fake}:${process.env.PATH ?? ""}`;
    const creators = {
      darwin: "macOS launchd user supervision",
      linux: "Linux systemd user supervision",
      // The Windows creator keeps instance state under %LOCALAPPDATA%, so it
      // refuses this workspace's overridden root before reaching Task
      // Scheduler; no other creator rejects that override.
      win32: "does not accept XDG_DATA_HOME overrides",
    };
    // The POSIX managers are replaced by shell scripts, so their own failures
    // are only observable off Windows; a reached creator is proven everywhere
    // by the absence of the unsupported-platform error.
    const shellManagers = process.platform !== "win32";
    for (const [platform, reported] of Object.entries(creators)) {
      const created = ws.runAs(platform, "new", "server", `on-${platform}`);
      expect(created.status, created.output).not.toBe(0);
      expect(created.output).not.toContain("devver attach ");
      expect(created.output).not.toContain("unsupported on");
      if (shellManagers || platform === "win32") {
        expect(created.output).toContain(reported);
      }
    }
    const unsupported = ws.runAs("freebsd", "new", "server", "elsewhere");
    expect(unsupported.status).not.toBe(0);
    expect(unsupported.output).toContain("unsupported on freebsd");
    expect(ws.run("server", "status").output).toContain("No server attached");
  } finally {
    rmSync(ws.root, { recursive: true, force: true });
  }
}, 30_000);

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
    ws.env.PATH = `${fake}:${process.env.PATH ?? ""}`;
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

test("failed registration with no unit cleans only the new instance", () => {
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
    writeFileSync(
      join(fake, "systemctl"),
      '#!/bin/sh\ncase "$*" in *show*) echo not-found; exit 0;; esac\nexit 1\n',
      { mode: 0o700 }
    );
    ws.env.PATH = `${fake}:${process.env.PATH ?? ""}`;
    const result = ws.run("new", "server", "absent");
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("state removed");
    expect(() =>
      readFileSync(
        join(ws.root, "data", "devver", "servers", "absent", "identity.json")
      )
    ).toThrow();
  } finally {
    rmSync(ws.root, { recursive: true, force: true });
  }
});

test("installed npm bin pins and starts its server after the CLI exits", async () => {
  if (process.platform !== "linux" || node === null) {
    return;
  }
  const ws = workspace();
  try {
    const installed = join(ws.root, "installed");
    const packed = Bun.spawnSync(
      [
        "npm",
        "pack",
        "--workspace",
        "@devver/cli",
        "--ignore-scripts",
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
    const archive = join(ws.root, packed.stdout.toString().trim());
    const install = Bun.spawnSync(
      [
        "npm",
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--prefix",
        installed,
        archive,
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
      '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\n"$@" >/dev/null 2>&1 &\necho "$!" > "$XDG_DATA_HOME/server.pid"\n',
      { mode: 0o700 }
    );
    writeFileSync(
      join(fake, "systemctl"),
      '#!/bin/sh\ncase "$2" in is-active) kill -0 "$(cat "$XDG_DATA_HOME/server.pid")";; stop) kill "$(cat "$XDG_DATA_HOME/server.pid")";; esac\n',
      { mode: 0o700 }
    );
    ws.env.PATH = `${fake}:${dirname(node)}:${process.env.PATH ?? ""}`;
    const runInstalled = (...args: string[]) => {
      const result = Bun.spawnSync([node, bin, ...args], {
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
    const created = runInstalled("new", "server", "installed");
    expect(created.status, created.output).toBe(0);
    const url = CONTROL_URL.exec(created.output)?.[0];
    expect(url).toBeDefined();
    expect(created.output).toContain(`devver attach ${url}`);
    const identity = decodeIdentity(
      await (await fetch(`${url}/identity`)).json()
    );
    expect(identity.name).toBe("installed");
    const pinned = join(
      ws.root,
      "data",
      "devver",
      "installations",
      pkg.version,
      "server.mjs"
    );
    expect(statSync(pinned).mode % 0o1000).toBe(0o700);
    expect(
      readFileSync(pinned).equals(
        readFileSync(
          join(
            installed,
            "node_modules",
            "@devver",
            "cli",
            "dist",
            "servers",
            pkg.version,
            "server.mjs"
          )
        )
      )
    ).toBe(true);
    expect(runInstalled("server", "status").output).toContain(
      "No server attached"
    );
  } finally {
    const pidFile = join(ws.root, "data", "server.pid");
    try {
      const pid = Number(readFileSync(pidFile, "utf-8"));
      if (Number.isSafeInteger(pid) && pid > 0) {
        process.kill(pid);
      }
    } catch {
      // Registration can fail before the simulated manager starts a process.
    }
    rmSync(ws.root, { recursive: true, force: true });
  }
}, 30_000);

test("a native user manager keeps distinct named servers reachable after creation exits", async () => {
  if (
    process.platform !== "linux" ||
    node === null ||
    Bun.which("systemctl") === null
  ) {
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
        units.push(
          decodeService(JSON.parse(readFileSync(serviceFile, "utf-8"))).unit
        );
      }
      expect(created.status, created.output).toBe(0);
      const url = CONTROL_URL.exec(created.output)?.[0];
      expect(url).toBeDefined();
      expect(created.output).toContain(`devver attach ${url}`);
      if (url !== undefined) {
        urls.push(url);
      }
      const identity = decodeIdentity(
        await (await fetch(`${url}/identity`)).json()
      );
      expect(identity.name).toBe(name);
      const state = decodeService(
        JSON.parse(
          readFileSync(
            join(ws.root, "data", "devver", "servers", name, "service.json"),
            "utf-8"
          )
        )
      );
      expect(units.at(-1)).toBe(state.unit);
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
      expect(
        decodeIdentity(await (await fetch(`${url}/identity`)).json()).instanceId
      ).toBe(identity.instanceId);
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
