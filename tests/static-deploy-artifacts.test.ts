import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Schema } from "effect";

import pkg from "../package.json";
import { stopDeploymentHost } from "../packages/server";
import { windowsServersDirectory } from "../packages/server/windows-acl";

const repo = join(import.meta.dir, "..");
const onWindows = process.platform === "win32";
const APP_URL =
  /App URL: (?<url>http:\/\/(?<id>[0-9a-f-]{36})\.(?<project>[a-z0-9-]+)\.localhost:(?<port>\d+)\/)/u;
const CONTROL_URL = /http:\/\/127\.0\.0\.1:(?<port>\d+)\/api\/v1/u;
const decodeService = Schema.decodeUnknownSync(
  Schema.Struct({
    port: Schema.Finite.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 1, maximum: 65_535 })
    ),
    label: Schema.optional(
      Schema.String.check(
        Schema.isPattern(/^com\.devver\.server\.[0-9a-f-]{36}$/u)
      )
    ),
    unit: Schema.optional(
      Schema.String.check(Schema.isPattern(/^devver-[0-9a-f-]{36}\.service$/u))
    ),
    task: Schema.optional(
      Schema.String.check(Schema.isPattern(/^devver-[0-9a-f-]{36}$/u))
    ),
  })
);
type Service = ReturnType<typeof decodeService>;
const decodeInstance = Schema.decodeUnknownSync(
  Schema.Struct({ instanceId: Schema.String })
);

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Devver Artifact Test",
      GIT_AUTHOR_EMAIL: "test@devver.invalid",
      GIT_COMMITTER_NAME: "Devver Artifact Test",
      GIT_COMMITTER_EMAIL: "test@devver.invalid",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString().trim();
}

function run(command: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = Bun.spawnSync(command, {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120_000,
  });
  return {
    status: child.exitCode,
    output: child.stdout.toString() + child.stderr.toString(),
  };
}

async function response(url: string, options?: RequestInit) {
  const result = await fetch(url, {
    ...options,
    redirect: "manual",
    signal: AbortSignal.timeout(5000),
  });
  return { status: result.status, text: await result.text() };
}

async function refuses(url: string) {
  const connected = await response(url).then(
    () => true,
    () => false
  );
  expect(connected).toBe(false);
}

async function waitFor(url: string, shouldAnswer: boolean) {
  const deadline = Date.now() + (onWindows ? 120_000 : 30_000);
  while (Date.now() < deadline) {
    try {
      const result = await response(url);
      if (shouldAnswer && result.status === 200) {
        return;
      }
    } catch {
      if (!shouldAnswer) {
        return;
      }
    }
    await Bun.sleep(200);
  }
  throw new Error(
    `Expected ${url} to ${shouldAnswer ? "answer" : "stop answering"}`
  );
}

function checkout(root: string) {
  const site = join(root, "site");
  mkdirSync(join(site, "assets"), { recursive: true });
  writeFileSync(join(site, "index.html"), "<h1>revision A</h1>");
  writeFileSync(join(site, "assets", "app.css"), "body{color:red}");
  git(site, "init", "-q", "-b", "main");
  git(site, "add", ".");
  git(site, "commit", "-q", "-m", "revision A");
  const first = git(site, "rev-parse", "HEAD");
  writeFileSync(join(site, "index.html"), "<h1>uncommitted edit</h1>");
  return { site, first };
}

function linuxManager(root: string) {
  const directory = join(root, "fake-bin");
  mkdirSync(directory);
  writeFileSync(
    join(directory, "systemd-run"),
    '#!/bin/sh\nfor arg do case "$arg" in --unit=*) unit="$(printf "%s" "$arg" | /usr/bin/cut -d= -f2)";; esac; done\nwhile [ "$1" != "--" ]; do shift; done\nshift\n"$@" >/dev/null 2>&1 &\necho "$!" > "$XDG_DATA_HOME/$unit.pid"\n',
    { mode: 0o700 }
  );
  writeFileSync(
    join(directory, "systemctl"),
    '#!/bin/sh\ncase "$2" in is-active) read pid < "$XDG_DATA_HOME/$4.pid"; read _ _ state _ < "/proc/$pid/stat" || exit 1; [ "$state" != Z ] && kill -0 "$pid";; stop) read pid < "$XDG_DATA_HOME/$3.pid"; kill "$pid";; esac\n',
    { mode: 0o700 }
  );
  return directory;
}

function powershell(script: string) {
  execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      timeout: 30_000,
      windowsHide: true,
    }
  );
}

function artifact() {
  const built = run(["bun", "run", "build"], repo, process.env);
  expect(built.status, built.output).toBe(0);
  const executable = join(repo, onWindows ? "devver.exe" : "devver");
  const server = join(
    repo,
    "servers",
    pkg.version,
    onWindows ? "devver-server.exe" : "devver-server"
  );
  return { command: [executable], serverCommand: [server] };
}

function workspace() {
  const built = artifact();
  const gitPath = Bun.which("git");
  if (gitPath === null) {
    throw new Error("Git is required for a committed deployment");
  }
  const root = mkdtempSync(join(tmpdir(), "devver-artifact-deploy-"));
  const system = process.env.SystemRoot ?? "C:\\Windows";
  const paths = [
    ...(process.platform === "linux" ? [linuxManager(root)] : []),
    ...(process.platform === "darwin" ? [] : [dirname(gitPath)]),
    ...(onWindows
      ? [
          join(system, "System32"),
          join(system, "System32", "WindowsPowerShell", "v1.0"),
        ]
      : ["/usr/bin", "/bin"]),
  ];
  const path = paths.join(onWindows ? ";" : ":");
  expect(Bun.which("bun", { PATH: path })).toBeNull();
  expect(Bun.which("node", { PATH: path })).toBeNull();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: path,
    XDG_DATA_HOME: join(root, "data"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
  };
  if (onWindows) {
    env.Path = path;
  }
  const creationEnv = onWindows ? { ...env, XDG_DATA_HOME: undefined } : env;
  return {
    ...built,
    root,
    env,
    creationEnv,
    name: `artifact${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
    cli: (cwd: string, ...args: string[]) =>
      run([...built.command, ...args], cwd, env),
  };
}

type Workspace = ReturnType<typeof workspace>;
interface App {
  url: string;
  id: string;
  port: string;
}

function printedApp(output: string): App {
  const match = APP_URL.exec(output)?.groups;
  if (
    match?.url === undefined ||
    match.id === undefined ||
    match.port === undefined
  ) {
    throw new Error("Packaged CLI did not print an app URL");
  }
  return { url: match.url, id: match.id, port: match.port };
}

async function deploy(
  ws: Workspace,
  site: string,
  commit: string,
  html: string
) {
  const result = ws.cli(site, "deploy", "--verbose");
  expect(result.status, result.output).toBe(0);
  expect(result.output).toContain(commit);
  const app = printedApp(result.output);
  expect(new URL(app.url).hostname).toBe(`${app.id}.${ws.name}.localhost`);
  expect((await response(app.url)).text).toBe(html);
  return app;
}

async function isolatedRouting(
  first: App,
  second: App,
  controlUrl: string,
  controlPort: number
) {
  expect(first.url).not.toBe(second.url);
  expect(first.port).toBe(second.port);
  expect(first.port).not.toBe(String(controlPort));
  expect((await response(`${first.url}assets/app.css`)).text).toBe(
    "body{color:red}"
  );
  expect(
    (await response(`${controlUrl.slice(0, -7)}/index.html`)).status
  ).not.toBe(200);
  for (const host of [
    `127.0.0.1:${first.port}`,
    `${second.id}.localhost.example.com:${first.port}`,
    `${new URL(first.url).hostname.replace(first.id, `${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}`)}:${first.port}`,
  ]) {
    const unknown = await response(`http://127.0.0.1:${first.port}/`, {
      headers: { Host: host },
    });
    expect(unknown.status).not.toBe(200);
    expect(unknown.text).not.toContain("revision A");
  }
  const nonLoopback = Object.values(networkInterfaces())
    .flatMap((addresses) => addresses ?? [])
    .find((address) => address.family === "IPv4" && !address.internal);
  if (nonLoopback === undefined) {
    throw new Error(
      "No non-loopback interface is available for the binding check"
    );
  }
  await refuses(`http://${nonLoopback.address}:${first.port}/`);
  await refuses(`http://${nonLoopback.address}:${controlPort}/api/v1/identity`);
}

async function failedDeployments(
  ws: Workspace,
  site: string,
  instance: string,
  controlUrl: string,
  first: App,
  second: App
) {
  const configFile = join(ws.root, "data", "devver", "config", "cli");
  const selected = readFileSync(configFile, "utf-8");
  const worktrees = join(instance, "worktrees");
  const originals = readdirSync(worktrees).toSorted();
  writeFileSync(
    join(site, ".devver.yaml"),
    "static:\n  directory: ../..\n  secret: do-not-print-this-canary\n"
  );
  git(site, "add", ".devver.yaml");
  git(site, "commit", "-q", "-m", "escaping static folder");
  const escaped = ws.cli(site, "deploy");
  expect(escaped.status).not.toBe(0);
  expect(escaped.output).toContain("config:");
  expect(escaped.output).not.toMatch(APP_URL);
  expect(escaped.output).not.toContain("do-not-print-this-canary");
  rmSync(join(site, ".devver.yaml"));
  if (onWindows) {
    git(site, "add", "-A");
  } else {
    symlinkSync("../../outside", join(site, "assets", "outside.css"));
    git(site, "add", "-A");
    git(site, "commit", "-q", "-m", "escaping asset symlink");
    const escapedAsset = ws.cli(site, "deploy");
    expect(escapedAsset.status).not.toBe(0);
    expect(escapedAsset.output).toContain("config:");
    expect(escapedAsset.output).not.toMatch(APP_URL);
    rmSync(join(site, "assets", "outside.css"));
  }
  git(site, "add", "-A");
  git(site, "commit", "-q", "-m", "valid static site after rejected config");
  if (!onWindows) {
    const websitino = join(
      dirname(instance),
      "..",
      "installations",
      pkg.version,
      decodeInstance(
        JSON.parse(readFileSync(join(instance, "identity.json"), "utf-8"))
      ).instanceId,
      "websitino"
    );
    const mode = statSync(websitino).mode % 0o1000;
    chmodSync(websitino, 0o600);
    try {
      const failedTool = ws.cli(site, "deploy");
      expect(failedTool.status).not.toBe(0);
      expect(failedTool.output).toMatch(/(?:process|readiness):/u);
      expect(failedTool.output).not.toMatch(APP_URL);
      expect(readdirSync(worktrees).toSorted()).toEqual(originals);
      expect((await response(first.url)).text).toBe("<h1>revision A</h1>");
      expect((await response(second.url)).text).toBe("<h1>revision B</h1>");
    } finally {
      chmodSync(websitino, mode);
    }
  }
  rmSync(join(site, "index.html"));
  git(site, "add", "-A");
  git(site, "commit", "-q", "-m", "site without an index");
  const unreachable = ws.cli(site, "deploy");
  expect(unreachable.status).not.toBe(0);
  expect(unreachable.output).toContain("readiness:");
  expect(unreachable.output).not.toMatch(APP_URL);
  const missing = await response(`${controlUrl}/deployments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: site, commit: "0".repeat(40) }),
  });
  expect(missing.status).not.toBe(200);
  expect(missing.text).not.toContain(".localhost");
  expect(readdirSync(worktrees).toSorted()).toEqual(originals);
  expect(readFileSync(configFile, "utf-8")).toBe(selected);
  expect((await response(first.url)).text).toBe("<h1>revision A</h1>");
  expect((await response(second.url)).text).toBe("<h1>revision B</h1>");
}

function stopSupervisor(ws: Workspace, service: Service) {
  if (process.platform === "darwin" && service.label !== undefined) {
    const stopped = run(
      [
        "launchctl",
        "bootout",
        `gui/${process.getuid?.() ?? ""}/${service.label}`,
      ],
      ws.root,
      ws.env
    );
    expect(stopped.status, stopped.output).toBe(0);
    return;
  }
  if (process.platform === "linux" && service.unit !== undefined) {
    const stopped = run(
      ["systemctl", "--user", "stop", service.unit],
      ws.root,
      ws.env
    );
    expect(stopped.status, stopped.output).toBe(0);
    return;
  }
  if (onWindows && service.task !== undefined) {
    powershell(`Stop-ScheduledTask -TaskName '${service.task}'`);
    return;
  }
  throw new Error("Created server has no platform supervisor");
}

async function restart(
  ws: Workspace,
  service: Service,
  controlUrl: string,
  first: App,
  second: App
) {
  stopSupervisor(ws, service);
  await waitFor(`${controlUrl}/identity`, false);
  await waitFor(first.url, false);
  await waitFor(second.url, false);
  const child = Bun.spawn(
    [...ws.serverCommand, ws.name, String(service.port)],
    {
      env: ws.creationEnv,
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  try {
    await waitFor(`${controlUrl}/identity`, true);
    expect((await response(first.url)).text).toBe("<h1>revision A</h1>");
    expect((await response(second.url)).text).toBe("<h1>revision B</h1>");
    expect(ws.cli(ws.root, "server", "status").output).toContain(": reachable");
  } finally {
    child.kill();
    await child.exited;
  }
  await waitFor(first.url, false);
  await waitFor(second.url, false);
}

function changeStoredStatus(instance: string, id: string, status: string) {
  const db = new Database(join(instance, "deployments.sqlite"));
  try {
    db.query("UPDATE deployments SET status = ? WHERE deploymentId = ?").run(
      status,
      id
    );
  } finally {
    db.close();
  }
}

async function degradedRestart(
  ws: Workspace,
  instance: string,
  service: Service,
  controlUrl: string,
  first: App,
  second: App,
  site: string,
  commit: string
) {
  changeStoredStatus(instance, first.id, "preparing");
  const child = Bun.spawn(
    [...ws.serverCommand, ws.name, String(service.port)],
    { env: ws.creationEnv, stdout: "pipe", stderr: "pipe" }
  );
  try {
    await waitFor(`${controlUrl}/identity`, true);
    const statuses = await response(`${controlUrl}/deployments`);
    expect(statuses.status).toBe(200);
    expect(statuses.text).toContain(`"deploymentId":"${first.id}"`);
    expect(statuses.text).toContain('"status":"degraded"');
    expect(statuses.text).toContain(
      `"repositoryId":"${createHash("sha256").update(realpathSync(site)).digest("hex")}"`
    );
    expect(statuses.text).toContain(`"commit":"${commit}"`);
    expect(statuses.text).not.toContain("worktree");
    expect(ws.cli(ws.root, "server", "status").output).toContain(
      `${first.id}: degraded (server)`
    );
    expect((await response(first.url)).status).not.toBe(200);
    expect((await response(second.url)).text).toBe("<h1>revision B</h1>");
  } finally {
    child.kill();
    await child.exited;
    changeStoredStatus(instance, first.id, "ready");
  }
  await waitFor(`${controlUrl}/identity`, false);
}

async function corruptRestart(
  ws: Workspace,
  instance: string,
  service: Service,
  controlUrl: string,
  first: App,
  second: App
) {
  changeStoredStatus(instance, first.id, "corrupt");
  try {
    const attempted = run(
      [...ws.serverCommand, ws.name, String(service.port)],
      ws.root,
      ws.creationEnv
    );
    expect(attempted.status).not.toBe(0);
    expect(attempted.output).toContain("Deployment records hold entries");
    await refuses(first.url);
    await refuses(second.url);
  } finally {
    changeStoredStatus(instance, first.id, "ready");
  }
  const child = Bun.spawn(
    [...ws.serverCommand, ws.name, String(service.port)],
    { env: ws.creationEnv, stdout: "pipe", stderr: "pipe" }
  );
  try {
    await waitFor(`${controlUrl}/identity`, true);
    expect((await response(first.url)).text).toBe("<h1>revision A</h1>");
    expect((await response(second.url)).text).toBe("<h1>revision B</h1>");
  } finally {
    child.kill();
    await child.exited;
  }
}

async function occupiedPortRestart(
  ws: Workspace,
  service: Service,
  controlUrl: string,
  first: App,
  second: App
) {
  const blocker = createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(Number(first.port), "127.0.0.1", resolve);
  });
  try {
    const attempted = run(
      [...ws.serverCommand, ws.name, String(service.port)],
      ws.root,
      ws.creationEnv
    );
    expect(attempted.status).not.toBe(0);
    expect(attempted.output).toContain("saved app port is occupied");
  } finally {
    await new Promise<void>((resolve) => {
      blocker.close(() => {
        resolve();
      });
    });
  }
  const child = Bun.spawn(
    [...ws.serverCommand, ws.name, String(service.port)],
    { env: ws.creationEnv, stdout: "pipe", stderr: "pipe" }
  );
  try {
    await waitFor(`${controlUrl}/identity`, true);
    expect((await response(first.url)).text).toBe("<h1>revision A</h1>");
    expect((await response(second.url)).text).toBe("<h1>revision B</h1>");
  } finally {
    child.kill();
    await child.exited;
  }
}

function removeSupervisor(ws: Workspace, service: Service | undefined) {
  if (service?.label !== undefined) {
    const job = `gui/${process.getuid?.() ?? ""}/${service.label}`;
    if (run(["launchctl", "print", job], ws.root, ws.env).status === 0) {
      const stopped = run(["launchctl", "bootout", job], ws.root, ws.env);
      expect(stopped.status, stopped.output).toBe(0);
    }
    const deadline = Date.now() + 10_000;
    let gone = false;
    while (Date.now() < deadline) {
      if (run(["launchctl", "print", job], ws.root, ws.env).status !== 0) {
        gone = true;
        break;
      }
      Bun.spawnSync(["/bin/sleep", "0.2"]);
    }
    expect(gone).toBe(true);
  }
  if (service?.unit !== undefined) {
    run(["systemctl", "--user", "stop", service.unit], ws.root, ws.env);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (
        run(
          ["systemctl", "--user", "is-active", "--quiet", service.unit],
          ws.root,
          ws.env
        ).status !== 0
      ) {
        break;
      }
      Bun.spawnSync(["/bin/sleep", "0.2"]);
    }
    expect(
      run(
        ["systemctl", "--user", "is-active", "--quiet", service.unit],
        ws.root,
        ws.env
      ).status
    ).not.toBe(0);
  }
  if (service?.task !== undefined) {
    powershell(
      `Stop-ScheduledTask -TaskName '${service.task}' -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName '${service.task}' -Confirm:$false -ErrorAction SilentlyContinue; if (Get-ScheduledTask -TaskName '${service.task}' -ErrorAction SilentlyContinue) { throw 'Scheduled task remains registered' }`
    );
  }
}

async function stopRecordedSites(instance: string, data: string) {
  const identity = join(instance, "identity.json");
  if (!existsSync(identity)) {
    return;
  }
  const { instanceId } = decodeInstance(
    JSON.parse(readFileSync(identity, "utf-8"))
  );
  await stopDeploymentHost({
    toolsDirectory: join(
      dirname(data),
      "installations",
      pkg.version,
      instanceId
    ),
    instanceDirectory: instance,
  });
}

async function exercise() {
  const windowsData = onWindows ? await windowsServersDirectory() : undefined;
  const ws = workspace();
  const data =
    windowsData ?? join(ws.env.XDG_DATA_HOME ?? "", "devver", "servers");
  const instance = join(data, ws.name);
  let recorded: Service | undefined;
  let controlUrl: string | undefined;
  try {
    const source = checkout(ws.root);
    const created = run(
      [...ws.command, "new", "server", ws.name],
      ws.root,
      ws.creationEnv
    );
    expect(created.status, created.output).toBe(0);
    controlUrl = CONTROL_URL.exec(created.output)?.[0];
    if (controlUrl === undefined) {
      throw new Error("Packaged CLI did not print a control URL");
    }
    recorded = decodeService(
      JSON.parse(readFileSync(join(instance, "service.json"), "utf-8"))
    );
    expect(ws.cli(ws.root, "attach", controlUrl).status).toBe(0);
    expect(ws.cli(ws.root, "server", "status").output).toContain(": reachable");
    const first = await deploy(
      ws,
      source.site,
      source.first,
      "<h1>revision A</h1>"
    );
    writeFileSync(join(source.site, "intermediate.txt"), "not deployed");
    git(source.site, "add", "intermediate.txt");
    git(source.site, "commit", "-q", "-m", "undeployed revision");
    writeFileSync(join(source.site, "index.html"), "<h1>revision B</h1>");
    git(source.site, "add", "index.html");
    git(source.site, "commit", "-q", "-m", "revision B");
    const second = await deploy(
      ws,
      source.site,
      git(source.site, "rev-parse", "HEAD"),
      "<h1>revision B</h1>"
    );
    const listing = await response(`${controlUrl}/deployments`);
    expect(listing.status).toBe(200);
    const deployments = Schema.decodeUnknownSync(
      Schema.Array(
        Schema.Struct({
          deploymentId: Schema.String,
          parentDeploymentId: Schema.NullOr(Schema.String),
        })
      )
    )(JSON.parse(listing.text));
    expect(
      deployments.find(({ deploymentId }) => deploymentId === first.id)
    ).toEqual({
      deploymentId: first.id,
      parentDeploymentId: null,
    });
    expect(
      deployments.find(({ deploymentId }) => deploymentId === second.id)
    ).toEqual({
      deploymentId: second.id,
      parentDeploymentId: first.id,
    });
    await isolatedRouting(first, second, controlUrl, recorded.port);
    await failedDeployments(
      ws,
      source.site,
      instance,
      controlUrl,
      first,
      second
    );
    await restart(ws, recorded, controlUrl, first, second);
    await degradedRestart(
      ws,
      instance,
      recorded,
      controlUrl,
      first,
      second,
      source.site,
      source.first
    );
    await corruptRestart(ws, instance, recorded, controlUrl, first, second);
    await occupiedPortRestart(ws, recorded, controlUrl, first, second);
  } finally {
    if (recorded === undefined && existsSync(join(instance, "service.json"))) {
      recorded = decodeService(
        JSON.parse(readFileSync(join(instance, "service.json"), "utf-8"))
      );
    }
    if (recorded !== undefined || !existsSync(instance)) {
      removeSupervisor(ws, recorded);
      if (recorded !== undefined) {
        await waitFor(
          `http://127.0.0.1:${recorded.port}/api/v1/identity`,
          false
        );
      }
      await stopRecordedSites(instance, data);
      if (existsSync(instance)) {
        rmSync(instance, { recursive: true, force: true });
      }
      rmSync(ws.root, { recursive: true, force: true });
    }
  }
}

if (!onWindows) {
  test("the standalone CLI deploys committed static revisions and recovers after restart", async () => {
    await exercise();
  }, 300_000);
}
