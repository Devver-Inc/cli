import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Schema } from "effect";

import pkg from "../package.json";
import {
  listInstances,
  readInstanceService,
} from "../packages/server/identity";
import {
  verifyWindowsPrivate,
  windowsServersDirectory,
} from "../packages/server/windows-acl";

const repo = join(import.meta.dir, "..");
const windows = process.platform === "win32";
// Windows instance state lives in the real per-user %LOCALAPPDATA% and the
// design deliberately refuses an XDG redirect, so these checks cannot isolate
// themselves: their result depends on what else touched that root, and under
// which identity. The dedicated CI job is that isolation, and sets this flag.
const realState = process.env.DEVVER_WINDOWS_STATE_TESTS === "1";
const CONTROL_URL = /http:\/\/127\.0\.0\.1:\d+\/api\/v1/u;
// Triggers|RestartCount|State, with State as either enum or CIM value.
const SUPERVISED = /^0\|3\|(?:Running|4)$/u;
const TASK_NAME = /^devver-[0-9a-f-]{36}$/u;
const decodeIdentity = Schema.decodeUnknownSync(
  Schema.Struct({
    instanceId: Schema.String,
    name: Schema.String,
    serverVersion: Schema.String,
  })
);
const unique = `win${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;

function powershell(script: string) {
  return execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf-8" }
  ).trim();
}

function build() {
  const node = Bun.which("node");
  if (node === null) {
    throw new Error("Node is required for the Windows server tests");
  }
  const built = Bun.spawnSync(["bun", "run", "build:npm"], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (built.exitCode !== 0) {
    throw new Error(built.stderr.toString());
  }
  const cli = join(repo, "packages/cli/dist", "cli.mjs");
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const noRuntimePath = [
    join(systemRoot, "System32"),
    join(systemRoot, "System32", "WindowsPowerShell", "v1.0"),
    systemRoot,
  ].join(";");
  const runtimePath = `${dirname(node)};${noRuntimePath}`;
  if (Bun.which("bun", { PATH: runtimePath }) !== null) {
    throw new Error("Bun must be absent from the npm CLI process PATH");
  }
  const run = (
    args: string[],
    env: Record<string, string | undefined> = {}
  ) => {
    const result = Bun.spawnSync([node, ...args], {
      cwd: repo,
      // Instance state must resolve from the OS known folder, never an override.
      env: {
        ...process.env,
        PATH: runtimePath,
        Path: runtimePath,
        XDG_DATA_HOME: undefined,
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      status: result.exitCode,
      output: result.stdout.toString() + result.stderr.toString(),
    };
  };
  const server = join(
    repo,
    "packages/cli/dist",
    "servers",
    pkg.version,
    "server.mjs"
  );
  return {
    node,
    /** Instance state deliberately shares the real per-user LOCALAPPDATA. */
    servers: join(
      powershell("[System.Environment]::GetFolderPath('LocalApplicationData')"),
      "devver",
      "servers"
    ),
    // Creation never reads or writes the CLI config, so it runs without an
    // XDG override; attachment never touches instance state, so it keeps one.
    create: (name: string, env?: Record<string, string | undefined>) =>
      run([cli, "new", "server", name], env),
    list: () => run([cli, "server", "list"]),
    attachment: (args: string[], data: string) =>
      run([cli, ...args], { XDG_DATA_HOME: data }),
    runServer: (name: string) => run([server, name, "0"]),
    noRuntimePath,
    launchServer: (name: string) =>
      Bun.spawn([node, server, name, "0"], {
        env: { ...process.env, XDG_DATA_HOME: undefined },
        stdout: "pipe",
        stderr: "pipe",
      }),
  };
}

let prepared: ReturnType<typeof build> | undefined;

function windowsState() {
  prepared ??= build();
  return prepared;
}

function removeInstance(servers: string, name: string) {
  try {
    const { task } = Schema.decodeUnknownSync(
      Schema.Struct({ task: Schema.String })
    )(JSON.parse(readFileSync(join(servers, name, "service.json"), "utf-8")));
    if (TASK_NAME.test(task)) {
      powershell(
        `Stop-ScheduledTask -TaskName '${task}' -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName '${task}' -Confirm:$false -ErrorAction SilentlyContinue`
      );
    }
  } catch {
    // A failed creation already removed its own task and state.
  }
  rmSync(join(servers, name), { recursive: true, force: true });
}

async function announcedUrl(child: Bun.Subprocess<"ignore", "pipe", "pipe">) {
  const reader = child.stdout.getReader();
  try {
    const announced = await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error("Server did not announce its URL"));
        }, 30_000);
      }),
    ]);
    return new TextDecoder().decode(announced.value).trim();
  } finally {
    reader.releaseLock();
  }
}

async function rejectsWithMessage(promise: Promise<unknown>, message: string) {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof Error)) {
      throw new Error("Expected an Error rejection", { cause: error });
    }
    expect(error.message).toContain(message);
    return;
  }
  throw new Error("Expected a rejection");
}

test("Windows instance state helpers refuse to run on other platforms", async () => {
  if (windows) {
    return;
  }
  await rejectsWithMessage(windowsServersDirectory(), "require Windows");
  await rejectsWithMessage(
    verifyWindowsPrivate({ path: repo, kind: "directory" }),
    "require Windows"
  );
  // Creation must never fall back to POSIX mode bits for Windows instance state.
  const { create } = await import("../packages/cli/windows-supervision");
  await rejectsWithMessage(create("other-platform"), "requires Windows");
});

test("Windows listing rejects untrusted XDG overrides without touching instance state", () => {
  if (!windows) {
    return;
  }
  const result = Bun.spawnSync(
    ["bun", "run", join(repo, "packages/server/tests/list-driver.ts"), "list"],
    {
      env: {
        ...process.env,
        XDG_DATA_HOME: join(tmpdir(), "untrusted-devver"),
      },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain(
    "does not accept XDG_DATA_HOME overrides"
  );
});

test("Windows supervision stays manual-start with bounded restart and no login or boot trigger", () => {
  const source = readFileSync(
    join(repo, "packages", "cli", "src", "cli", "windows-supervised-server.ts"),
    "utf-8"
  );
  // A task with no trigger can only be started on demand: nothing registers at
  // logon or boot, so supervision never outlives an explicit creation.
  expect(source).not.toContain("New-ScheduledTaskTrigger");
  expect(source).not.toContain("-Trigger");
  expect(source).toContain("-RestartCount 3");
  expect(source).toContain("-RestartInterval (New-TimeSpan -Minutes 1)");
  expect(source).toContain("-MultipleInstances IgnoreNew");
  // S4U runs as the creating user with no stored password and no interactive
  // desktop session; Interactive refuses to launch when the account is not
  // logged on at a console, and Password would require storing a credential.
  expect(source).toContain("-LogonType S4U -RunLevel Limited");
  expect(source).not.toContain("-LogonType Password");
  expect(source).not.toContain("-RunLevel Highest");
  // Creation only reports readiness once the registered task matches that
  // contract, and the trigger count filters $null: @($null).Count is 1, so an
  // unfiltered count would reject the trigger-free task this registers.
  expect(source).toContain("Where-Object { $null -ne $_ }");
  expect(source).toContain("@($triggers).Count -ne 0");
});

test("Windows creation fails closed when no service manager is reachable", () => {
  if (!windows) {
    return;
  }
  const state = windowsState();
  const name = `${unique}unmanaged`;
  try {
    // Without System32 on PATH, powershell.exe cannot be resolved. Windows
    // environment names are case-insensitive, so both spellings are replaced.
    const path = dirname(state.node);
    const created = state.create(name, { PATH: path, Path: path });
    expect(created.status).not.toBe(0);
    expect(created.output).not.toMatch(CONTROL_URL);
    expect(() => statSync(join(state.servers, name))).toThrow();
  } finally {
    removeInstance(state.servers, name);
  }
}, 180_000);

test("Windows refuses corrupt or widened instance state without replacing it", async () => {
  if (!(windows && realState)) {
    return;
  }
  const state = windowsState();
  const name = `${unique}guarded`;
  const directory = join(state.servers, name);
  const file = join(directory, "identity.json");
  try {
    const child = state.launchServer(name);
    try {
      expect(await announcedUrl(child)).toMatch(CONTROL_URL);
    } finally {
      child.kill();
      await child.exited;
    }

    writeFileSync(file, "invalid JSON");
    const corrupt = state.runServer(name);
    expect(corrupt.status).not.toBe(0);
    expect(corrupt.output).toContain("invalid state");
    expect(readFileSync(file, "utf-8")).toBe("invalid JSON");
    await rejectsWithMessage(listInstances(), name);

    // Everyone (S-1-1-0) is a well-known SID on every Windows language build.
    // GetAccessControl/SetAccessControl avoid Get-Acl and Set-Acl, whose module
    // autoload failed in CI and reported a missing command instead of a result.
    powershell(
      `$item = Get-Item -LiteralPath '${directory}' -Force; ` +
        "$acl = $item.GetAccessControl(); " +
        "$everyone = New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0'); " +
        "$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($everyone, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'); " +
        "$acl.AddAccessRule($rule); $item.SetAccessControl($acl)"
    );
    const widened = state.runServer(name);
    expect(widened.status).not.toBe(0);
    expect(widened.output).toContain("owner-only");
    await rejectsWithMessage(listInstances(), name);
    expect(readFileSync(file, "utf-8")).toBe("invalid JSON");
  } finally {
    removeInstance(state.servers, name);
  }
}, 180_000);

test("Windows standalone artifact lists two created instances without Node or Bun", () => {
  if (!(windows && realState)) {
    return;
  }
  const state = windowsState();
  const built = Bun.spawnSync(["bun", "run", "build"], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(built.exitCode, built.stderr.toString()).toBe(0);
  const exe = existsSync(join(repo, "devver.exe"))
    ? join(repo, "devver.exe")
    : join(repo, "devver");
  const names = [`${unique}standalone`, `${unique}standaloneb`];
  const config = mkdtempSync(join(tmpdir(), "devver-win-standalone-"));
  const env = {
    ...process.env,
    PATH: state.noRuntimePath,
    Path: state.noRuntimePath,
    XDG_DATA_HOME: undefined,
  };
  expect(Bun.which("node", { PATH: state.noRuntimePath })).toBeNull();
  expect(Bun.which("bun", { PATH: state.noRuntimePath })).toBeNull();
  const run = (args: string[], data?: string) => {
    const result = Bun.spawnSync([exe, ...args], {
      env: { ...env, XDG_DATA_HOME: data },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      status: result.exitCode,
      output: result.stdout.toString() + result.stderr.toString(),
    };
  };
  try {
    const urls: string[] = [];
    for (const name of names) {
      const created = run(["new", "server", name]);
      expect(created.status, created.output).toBe(0);
      const url = CONTROL_URL.exec(created.output)?.[0];
      if (url === undefined) {
        throw new Error("No control URL");
      }
      urls.push(url);
    }
    const listed = run(["server", "list"]);
    expect(listed.status, listed.output).toBe(0);
    for (const [index, name] of names.entries()) {
      expect(listed.output).toContain(`${name} (`);
      expect(listed.output).toContain(
        `${urls[index]} — version ${pkg.version}: reachable`
      );
    }
    expect(listed.output).not.toContain("[selected]");
    expect(run(["attach", urls[0] ?? ""], config).status).toBe(0);
    expect(run(["server", "status"], config).output).toContain("reachable");
    expect(run(["server", "list"]).output).toContain(
      `${urls[0]} — version ${pkg.version}: reachable`
    );
  } finally {
    for (const name of names) {
      removeInstance(state.servers, name);
    }
    rmSync(config, { recursive: true, force: true });
  }
}, 300_000);

test("Windows Task Scheduler keeps distinct instances alive after their creator exits", async () => {
  if (!(windows && realState)) {
    return;
  }
  const state = windowsState();
  const names = [unique, `${unique}b`];
  const config = mkdtempSync(join(tmpdir(), "devver-win-config-"));
  try {
    const identities: string[] = [];
    const urls: string[] = [];
    for (const name of names) {
      // S4U needs no console session, so creation has no excuse to fail here:
      // an earlier bail-out on a non-interactive host let real failures pass.
      const created = state.create(name);
      expect(created.status, created.output).toBe(0);
      const url = CONTROL_URL.exec(created.output)?.[0] ?? "";
      expect(url).toMatch(CONTROL_URL);
      expect(created.output).toContain(`devver attach ${url}`);
      urls.push(url);

      // A separate process reads the identity the exited creator announced.
      const identity = decodeIdentity(
        await (await fetch(`${url}/identity`)).json()
      );
      expect(identity.name).toBe(name);
      expect(identity.serverVersion).toBe(pkg.version);
      identities.push(identity.instanceId);

      const service = await readInstanceService(name);
      expect(service.serverVersion).toBe(pkg.version);
      if (!("task" in service)) {
        throw new Error("Windows service metadata must contain a task name");
      }
      expect(
        powershell(
          // A trigger-free task reports $null, and @($null).Count is 1, so the
          // count has to filter $null to observe the registered shape.
          `$t = Get-ScheduledTask -TaskName '${service.task}'; $g = @($t.Triggers) | Where-Object { $null -ne $_ }; "$(@($g).Count)|$($t.Settings.RestartCount)|$($t.State)"`
        )
      ).toMatch(SUPERVISED);

      const duplicate = state.create(name);
      expect(duplicate.status).not.toBe(0);
      expect(duplicate.output).toContain("already exists");
      expect(
        decodeIdentity(await (await fetch(`${url}/identity`)).json()).instanceId
      ).toBe(identity.instanceId);
    }
    expect(identities[0]).not.toBe(identities[1]);
    expect(urls[0]).not.toBe(urls[1]);
    const discovered = await listInstances();
    const listed = state.list();
    expect(listed.status, listed.output).toBe(0);
    for (const [index, name] of names.entries()) {
      expect(
        discovered.find((instance) => instance.name === name)?.instanceId
      ).toBe(identities[index]);
      expect(listed.output).toContain(
        `${name} (${identities[index]}) at ${urls[index]}`
      );
    }

    const [first] = urls;
    expect(state.attachment(["server", "status"], config).output).toContain(
      "No server attached"
    );
    const attached = state.attachment(["attach", first ?? ""], config);
    expect(attached.status, attached.output).toBe(0);
    const selected = state.list();
    expect(selected.status, selected.output).toBe(0);
    // The attach-time XDG override isolates the CLI target; Windows instance
    // enumeration deliberately rejects that override and stays read-only.
    expect(selected.output).toContain(
      `${first} — version ${pkg.version}: reachable`
    );
    expect(selected.output).toContain(
      `${urls[1]} — version ${pkg.version}: reachable`
    );
    expect(state.attachment(["server", "status"], config).output).toContain(
      ": reachable"
    );
    expect(state.attachment(["detach"], config).status).toBe(0);
    expect(state.attachment(["server", "status"], config).output).toContain(
      "No server attached"
    );
    // Detaching selects nothing: the supervised instance keeps answering.
    const [firstIdentity] = identities;
    if (firstIdentity === undefined) {
      throw new Error("No instance identity was recorded");
    }
    expect(
      decodeIdentity(await (await fetch(`${first}/identity`)).json()).instanceId
    ).toBe(firstIdentity);
    const serviceFile = join(state.servers, names[0] ?? "", "service.json");
    const originalService = readFileSync(serviceFile, "utf-8");
    try {
      writeFileSync(serviceFile, "invalid service JSON");
      const invalid = state.list();
      expect(invalid.status).not.toBe(0);
      expect(invalid.output).toContain(names[0] ?? "");
      expect(invalid.output).not.toContain("invalid service JSON");
    } finally {
      writeFileSync(serviceFile, originalService);
    }
  } finally {
    for (const name of names) {
      removeInstance(state.servers, name);
    }
    rmSync(config, { recursive: true, force: true });
  }
}, 300_000);
