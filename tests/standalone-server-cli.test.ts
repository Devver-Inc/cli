import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Schema } from "effect";

import pkg from "../package.json";

const repo = join(import.meta.dir, "..");
const cli = join(repo, "devver");
const packaged = join(repo, "servers", pkg.version, "devver-server");
// The standalone distribution carries its own runtime, so every process below
// runs with a PATH that holds neither Node nor Bun. /bin keeps launchctl
// reachable for the supervised creation path.
const NO_RUNTIME = "/usr/bin:/bin";
const CONTROL_URL = /http:\/\/127\.0\.0\.1:\d+\/api\/v1/u;
const decodeService = Schema.decodeUnknownSync(
  Schema.Struct({ label: Schema.String })
);
const decodeLinuxService = Schema.decodeUnknownSync(
  Schema.Struct({ unit: Schema.String })
);
const decodeIdentity = Schema.decodeUnknownSync(
  Schema.Struct({
    name: Schema.String,
    serverVersion: Schema.String,
    instanceId: Schema.String,
  })
);

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

// Supervision needs a reachable per-user launchd domain; headless CI may lack one.
function supervisableDomain() {
  if (process.platform !== "darwin") {
    return null;
  }
  const uid = process.getuid?.();
  if (uid === undefined) {
    return null;
  }
  const domain = `gui/${uid}`;
  return Bun.spawnSync(["launchctl", "print", domain]).exitCode === 0
    ? domain
    : null;
}

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
    // Detaching selects nothing: both packaged servers keep answering.
    expect((await fetch(`${first.url}/identity`)).status).toBe(200);
    expect((await fetch(`${second.url}/identity`)).status).toBe(200);
  } finally {
    await Promise.all(children.map(stop));
    rmSync(ws.root, { recursive: true, force: true });
  }
}, 30_000);

test("the Linux standalone artifact creates, lists and selects two instances without Node or Bun", () => {
  if (process.platform !== "linux") {
    return;
  }
  const ws = workspace();
  const fake = join(ws.root, "fake-bin");
  mkdirSync(fake);
  writeFileSync(
    join(fake, "systemd-run"),
    '#!/bin/sh\nfor arg do case "$arg" in --unit=*) unit="$(printf "%s" "$arg" | /usr/bin/cut -d= -f2)";; esac; done\nwhile [ "$1" != "--" ]; do shift; done\nshift\n"$@" >/dev/null 2>&1 &\necho "$!" > "$XDG_DATA_HOME/$unit.pid"\n',
    { mode: 0o700 }
  );
  writeFileSync(
    join(fake, "systemctl"),
    '#!/bin/sh\ncase "$2" in is-active) read pid < "$XDG_DATA_HOME/$4.pid"; kill -0 "$pid";; stop) read pid < "$XDG_DATA_HOME/$3.pid"; kill "$pid";; esac\n',
    { mode: 0o700 }
  );
  ws.env.PATH = fake;
  expect(Bun.which("node", { PATH: ws.env.PATH })).toBeNull();
  expect(Bun.which("bun", { PATH: ws.env.PATH })).toBeNull();
  try {
    const urls: string[] = [];
    for (const name of ["alpha", "beta"]) {
      const created = ws.run("new", "server", name);
      expect(created.status, created.output).toBe(0);
      const url = CONTROL_URL.exec(created.output)?.[0];
      if (url === undefined) {
        throw new Error("No control URL");
      }
      urls.push(url);
    }
    const listed = ws.run("server", "list");
    expect(listed.status, listed.output).toBe(0);
    expect(listed.output).toContain(
      `${urls[0]} — version ${pkg.version}: reachable`
    );
    expect(listed.output).toContain(
      `${urls[1]} — version ${pkg.version}: reachable`
    );
    expect(listed.output).not.toContain("[selected]");
    expect(ws.run("attach", urls[0] ?? "").status).toBe(0);
    expect(ws.run("server", "list").output).toContain(
      `${urls[0]} — version ${pkg.version}: reachable [selected]`
    );
    expect(ws.run("server", "status").output).toContain("alpha");
  } finally {
    for (const name of ["alpha", "beta"]) {
      try {
        const service = decodeLinuxService(
          JSON.parse(
            readFileSync(
              join(ws.root, "data", "devver", "servers", name, "service.json"),
              "utf-8"
            )
          )
        );
        const pid = Number(
          readFileSync(join(ws.root, "data", `${service.unit}.pid`), "utf-8")
        );
        if (Number.isSafeInteger(pid) && pid > 0) {
          process.kill(pid);
        }
      } catch {
        // Failed creation or an already stopped child needs no cleanup.
      }
    }
    rmSync(ws.root, { recursive: true, force: true });
  }
}, 60_000);

test("the standalone CLI supervises the server copy it packages, without attaching", async () => {
  const domain = supervisableDomain();
  if (domain === null) {
    return;
  }
  expect(Bun.which("node", { PATH: NO_RUNTIME })).toBeNull();
  expect(Bun.which("bun", { PATH: NO_RUNTIME })).toBeNull();
  const ws = workspace();
  const labels: string[] = [];
  try {
    const created = ws.run("new", "server", "packaged");
    const instance = join(ws.root, "data", "devver", "servers", "packaged");
    try {
      labels.push(
        decodeService(
          JSON.parse(readFileSync(join(instance, "service.json"), "utf-8"))
        ).label
      );
    } catch {
      /* no registration */
    }
    expect(created.status, created.output).toBe(0);
    const url = CONTROL_URL.exec(created.output)?.[0];
    if (url === undefined) {
      throw new Error("No control URL");
    }
    expect(created.output).toContain(`devver attach ${url}`);

    // The supervised job runs the pinned copy of the packaged executable, so
    // the instance never depends on an installed runtime or on this build tree.
    const pinned = join(
      ws.root,
      "data",
      "devver",
      "installations",
      pkg.version,
      "devver-server"
    );
    expect(statSync(pinned).mode % 0o1000).toBe(0o700);
    expect(statSync(pinned).size).toBe(statSync(packaged).size);
    expect(readFileSync(join(instance, "service.plist"), "utf-8")).toContain(
      `<string>${pinned}</string>`
    );

    const identity = decodeIdentity(
      await (await fetch(`${url}/identity`)).json()
    );
    expect(identity.name).toBe("packaged");
    expect(identity.serverVersion).toBe(pkg.version);
    const other = ws.run("new", "server", "other");
    const otherInstance = join(ws.root, "data", "devver", "servers", "other");
    try {
      labels.push(
        decodeService(
          JSON.parse(readFileSync(join(otherInstance, "service.json"), "utf-8"))
        ).label
      );
    } catch {
      /* no registration */
    }
    expect(other.status, other.output).toBe(0);
    const otherUrl = CONTROL_URL.exec(other.output)?.[0];
    if (otherUrl === undefined) {
      throw new Error("No second control URL");
    }
    const listed = ws.run("server", "list");
    expect(listed.status, listed.output).toBe(0);
    expect(listed.output).toContain(
      `${url} — version ${pkg.version}: reachable`
    );
    expect(listed.output).toContain(
      `${otherUrl} — version ${pkg.version}: reachable`
    );
    expect(listed.output).not.toContain("[selected]");
    expect(ws.run("server", "status").output).toContain("No server attached");
    expect(ws.run("attach", url).status).toBe(0);
    const selected = ws.run("server", "list");
    expect(selected.output).toContain(
      `${url} — version ${pkg.version}: reachable [selected]`
    );
    expect(selected.output).toContain(
      `${otherUrl} — version ${pkg.version}: reachable`
    );
    expect(ws.run("server", "status").output).toContain("packaged");
    Bun.spawnSync(["launchctl", "bootout", `${domain}/${labels.at(-1) ?? ""}`]);
    expect(ws.run("server", "list").output).toContain(
      `${otherUrl} — version ${pkg.version}: unreachable`
    );

    const duplicate = ws.run("new", "server", "packaged");
    expect(duplicate.status).not.toBe(0);
    expect(duplicate.output).toContain("already exists");
    expect(
      decodeIdentity(await (await fetch(`${url}/identity`)).json()).instanceId
    ).toBe(identity.instanceId);
  } finally {
    for (const label of labels) {
      Bun.spawnSync(["launchctl", "bootout", `${domain}/${label}`]);
    }
    rmSync(ws.root, { recursive: true, force: true });
  }
}, 60_000);
