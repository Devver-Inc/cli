import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Schema } from "effect";

import pkg from "../package.json" with { type: "json" };

const repo = join(import.meta.dir, "..");
const cli = join(repo, "packages", "cli", "src", "cli", "index.ts");
const server = join(repo, "packages", "server", "src", "index.ts");
const CONTROL_URL = /^http:\/\/127\.0\.0\.1:\d+\/api\/v1$/u;
const APP_URL =
  /App URL: (?<url>http:\/\/(?<id>[0-9a-f-]{36})\.(?<project>[a-z0-9-]+)\.localhost:(?<port>\d+)\/)/u;

/** The server finds its packaged Pitchfork/Websitino beside a built artifact. */
function packagedTools() {
  const tools = join(repo, "packages", "cli", "dist", "servers", pkg.version);
  if (
    !existsSync(
      join(tools, `websitino${process.platform === "win32" ? ".exe" : ""}`)
    )
  ) {
    const build = Bun.spawnSync(["bun", "run", "build:npm"], {
      cwd: repo,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(build.exitCode, build.stderr.toString()).toBe(0);
  }
}

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "devver-local-deploy-"));
  const env = {
    ...process.env,
    XDG_DATA_HOME: root,
    XDG_CONFIG_HOME: root,
    XDG_CACHE_HOME: root,
    XDG_STATE_HOME: root,
  };
  const run = async (args: string[], cwd = root) => {
    const child = Bun.spawn(["bun", "run", cli, ...args], {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [status, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { status, output: `${out}${err}` };
  };
  return { root, env, run };
}

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Devver Test",
      GIT_AUTHOR_EMAIL: "test@devver.invalid",
      GIT_COMMITTER_NAME: "Devver Test",
      GIT_COMMITTER_EMAIL: "test@devver.invalid",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString().trim();
}

/** The instance's own bare repository: one checkout deploys in these tests. */
const bareRepository = (instance: string) =>
  join(
    instance,
    "repositories",
    readdirSync(join(instance, "repositories"))[0] ?? ""
  );

/** A committed static site plus edits that must never reach a deployment. */
function checkout(root: string) {
  const directory = join(root, "site-checkout");
  mkdirSync(join(directory, "assets"), { recursive: true });
  writeFileSync(join(directory, "index.html"), "<h1>committed site</h1>");
  writeFileSync(join(directory, "assets", "app.css"), "body{color:#0f0}");
  git(directory, "init", "-q", "-b", "main");
  git(directory, "add", ".");
  git(directory, "commit", "-q", "-m", "committed site");
  const commit = git(directory, "rev-parse", "HEAD");
  writeFileSync(join(directory, "index.html"), "<h1>uncommitted edit</h1>");
  writeFileSync(join(directory, "secret.txt"), "uncommitted secret");
  return { directory, commit };
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
        }, 10_000);
      }),
    ]);
    reader.releaseLock();
    const url = new TextDecoder().decode(output.value).trim();
    if (!CONTROL_URL.test(url)) {
      throw new Error(`Server did not announce a control URL: ${url}`);
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

const STARTUP_DEADLINE = 20_000;

/** Start a server that is expected to give up, without waiting on it forever. */
async function startupResult(
  env: Record<string, string | undefined>,
  name: string,
  command: string[] = ["bun", "run", server]
) {
  const child = Bun.spawn([...command, name, "0"], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const status = await Promise.race([
    child.exited,
    new Promise<undefined>((resolve) => {
      setTimeout(() => {
        resolve(undefined);
      }, STARTUP_DEADLINE);
    }),
  ]);
  if (status === undefined) {
    child.kill("SIGKILL");
    await child.exited;
  }
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { status, output: `${out}${err}` };
}

const isInetAddress = (
  address: string | AddressInfo | null
): address is AddressInfo => address !== null && typeof address !== "string";

/**
 * Hold a loopback port, either so the next server has to bind a different one
 * or so a port a record names keeps answering from something the packaged
 * teardown has no way to stop. Port 0 holds an unused one and reports which.
 */
async function hold(port: number) {
  const holder = createServer();
  await new Promise<void>((resolve, reject) => {
    holder.once("error", reject);
    holder.listen(port, "127.0.0.1", resolve);
  });
  const address = holder.address();
  if (!isInetAddress(address)) {
    throw new Error("The held listener has no loopback port");
  }
  return {
    port: address.port,
    release: async () =>
      new Promise<void>((resolve) => {
        holder.close(() => {
          resolve();
        });
      }),
  };
}

async function body(url: string, headers: Record<string, string> = {}) {
  const response = await fetch(url, {
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(5000),
  });
  return { status: response.status, text: await response.text() };
}

test("deploy serves the committed HEAD of an attached local target at a loopback app URL", async () => {
  if (process.platform === "win32") {
    return;
  }
  packagedTools();
  const ws = workspace();
  const source = checkout(ws.root);
  const running = await foreground(ws.env, "deployer");
  let appUrl: string | undefined;
  try {
    expect((await ws.run(["attach", running.url])).status).toBe(0);

    const deployed = await ws.run(["deploy"], source.directory);
    expect(deployed.status, deployed.output).toBe(0);
    expect(deployed.output).toContain(source.commit);
    expect(deployed.output.toLowerCase()).toContain("not sandboxed");
    const match = APP_URL.exec(deployed.output);
    expect(match?.groups?.url, deployed.output).toBeDefined();
    const { url, id, project, port } = match?.groups ?? {};
    if (url === undefined || id === undefined || port === undefined) {
      throw new Error("Deploy did not print an app URL");
    }
    appUrl = url;
    expect(project).toBe("deployer");
    expect(deployed.output).toContain(id);
    expect(url).not.toBe(running.url);

    const index = await body(url);
    expect(index.status).toBe(200);
    expect(index.text).toBe("<h1>committed site</h1>");
    const asset = await body(`${url}assets/app.css`);
    expect(asset.status).toBe(200);
    expect(asset.text).toBe("body{color:#0f0}");
    expect((await body(`${url}secret.txt`)).status).not.toBe(200);
    expect(index.text).not.toContain("uncommitted");

    // Unknown and malformed project hostnames cannot reach the deployment.
    for (const host of [
      `${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}.deployer.localhost:${port}`,
      `127.0.0.1:${port}`,
      `${id}.deployer.localhost.example.com:${port}`,
    ]) {
      const unknown = await body(`http://127.0.0.1:${port}/`, { Host: host });
      expect(unknown.status, host).not.toBe(200);
      expect(unknown.text, host).not.toContain("committed site");
    }
    const control = new URL(running.url).origin;
    expect((await body(`${control}/index.html`)).status).not.toBe(200);
    expect((await body(`${control}/api/v1/identity`)).status).toBe(200);

    // A later commit moves the branch; the deployment keeps its own revision.
    writeFileSync(join(source.directory, "index.html"), "<h1>later</h1>");
    git(source.directory, "add", ".");
    git(source.directory, "commit", "-q", "-m", "later revision");
    expect((await body(url)).text).toBe("<h1>committed site</h1>");
  } finally {
    await stop(running.child);
    rmSync(ws.root, { recursive: true, force: true });
  }
  if (appUrl !== undefined) {
    // The stopped server leaves no supervised app process behind.
    const orphan = await body(appUrl).catch(() => ({ status: 0, text: "" }));
    expect(orphan.status).not.toBe(200);
  }
}, 180_000);

test("a failing deploy stage exits nonzero and leaves no route behind", async () => {
  if (process.platform === "win32") {
    return;
  }
  packagedTools();
  const ws = workspace();
  const source = checkout(ws.root);
  const running = await foreground(ws.env, "failing");
  try {
    expect((await ws.run(["attach", running.url])).status).toBe(0);
    // An escaping static directory is rejected by the configuration stage.
    writeFileSync(
      join(source.directory, ".devver.yaml"),
      "static:\n  directory: ../..\n"
    );
    git(source.directory, "add", ".devver.yaml");
    git(source.directory, "commit", "-q", "-m", "escaping static directory");
    const failed = await ws.run(["deploy"], source.directory);
    expect(failed.status).not.toBe(0);
    expect(failed.output.toLowerCase()).toContain("config");
    expect(failed.output).not.toMatch(APP_URL);

    // A source that is not a work tree root is refused before any state exists.
    const unsafe = await fetch(`${running.url}/deployments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "/etc", commit: source.commit }),
      signal: AbortSignal.timeout(10_000),
    });
    expect(unsafe.status).not.toBe(200);
    expect(await unsafe.text()).toContain("source");
    const instance = join(ws.root, "devver", "servers", "failing");
    expect(existsSync(join(instance, "apps"))).toBe(false);
    expect(readdirSync(join(instance, "worktrees"))).toEqual([]);
    // A deployment that failed retains no commit of its own.
    expect(
      git(
        bareRepository(instance),
        "for-each-ref",
        "--format=%(refname)",
        "refs/devver"
      )
    ).toBe("");
  } finally {
    await stop(running.child);
    rmSync(ws.root, { recursive: true, force: true });
  }
}, 180_000);

test("cloud and unselected targets keep the existing deploy behaviour", async () => {
  if (process.platform === "win32") {
    return;
  }
  const ws = workspace();
  const source = checkout(ws.root);
  try {
    const none = await ws.run(["deploy"], source.directory);
    expect(none.status).not.toBe(0);
    expect(none.output).toContain("No CLI target");

    expect((await ws.run(["cloud"])).status).toBe(0);
    const cloud = await ws.run(["deploy"], source.directory);
    expect(cloud.status).not.toBe(0);
    expect(cloud.output).toContain("Not authenticated");
    expect(cloud.output).not.toMatch(APP_URL);
  } finally {
    rmSync(ws.root, { recursive: true, force: true });
  }
}, 60_000);

const decodeRecord = Schema.decodeUnknownSync(
  Schema.Struct({
    status: Schema.String,
    stage: Schema.NullOr(Schema.String),
  })
);

const decodeAttempt = Schema.decodeUnknownSync(
  Schema.Struct({ deploymentId: Schema.String })
);

const decodeSetting = Schema.decodeUnknownSync(
  Schema.Struct({ value: Schema.String })
);

function instanceRecords<A>(instance: string, read: (db: Database) => A) {
  const database = new Database(join(instance, "deployments.sqlite"));
  try {
    return read(database);
  } finally {
    database.close();
  }
}

/**
 * Make the server's own "ready" write fail the way a full disk or a busy
 * records file would, and keep the port it published on: only a writer outside
 * the server can stage that failure, and the port it allocated is the one a
 * leaked static site would still be listening on.
 */
function blockReadyRecord(instance: string) {
  instanceRecords(instance, (database) => {
    database.run("CREATE TABLE attempted (deploymentId TEXT NOT NULL)");
    database.run(`CREATE TRIGGER attempted_deploy AFTER UPDATE OF status ON deployments
       WHEN new.status = 'ready'
       BEGIN INSERT INTO attempted VALUES (new.deploymentId); END`);
    database.run(`CREATE TRIGGER block_ready BEFORE UPDATE OF status ON deployments
       WHEN new.status = 'ready'
       BEGIN SELECT RAISE(ABORT, 'injected record failure'); END`);
  });
}

/** Only an outside writer can point a record at a directory of its choosing. */
function repoint(instance: string, deploymentId: string, worktree: string) {
  instanceRecords(instance, (database) => {
    database.run("UPDATE deployments SET worktree = ? WHERE deploymentId = ?", [
      worktree,
      deploymentId,
    ]);
  });
}

/**
 * The npm server artifact, built where the packaged toolchain it normally
 * ships beside is absent: the same bundle this distribution installs, with
 * nothing on the paths it looks for its static tools on.
 */
async function toollessServer(root: string) {
  const directory = join(root, "toolless");
  const built = await Bun.build({
    entrypoints: [server],
    outdir: directory,
    naming: { entry: "server.mjs" },
    target: "node",
    format: "esm",
    packages: "bundle",
  });
  expect(built.success, built.logs.map((log) => log.message).join("\n")).toBe(
    true
  );
  const node = Bun.which("node");
  if (node === null) {
    throw new Error("Node is required to run the bundled server");
  }
  return [node, join(directory, "server.mjs")];
}

/**
 * The durable state a server killed between starting a deployment's static
 * site and recording it ready leaves behind: still preparing, carrying the
 * port the site it started is listening on.
 */
function interrupt(instance: string, deploymentId: string) {
  instanceRecords(instance, (database) => {
    database.run(
      "UPDATE deployments SET status = 'preparing', stage = NULL WHERE deploymentId = ?",
      [deploymentId]
    );
  });
}

/** The one deployment this instance recorded. */
const publishedAttempt = (instance: string) =>
  decodeAttempt(
    instanceRecords(instance, (database) =>
      database
        .query(
          "SELECT deploymentId FROM deployments ORDER BY createdAt LIMIT 1"
        )
        .get()
    )
  );

/** The loopback port this instance publishes every deployment URL on. */
const appPort = (instance: string) =>
  decodeSetting(
    instanceRecords(instance, (database) =>
      database.query("SELECT value FROM instance WHERE key = 'appPort'").get()
    )
  ).value;

/** Only a writer outside the server can leave a record it cannot decode. */
function corrupt(instance: string, deploymentId: string) {
  const database = new Database(join(instance, "deployments.sqlite"));
  try {
    database.run(
      "UPDATE deployments SET status = 'bogus' WHERE deploymentId = ?",
      [deploymentId]
    );
  } finally {
    database.close();
  }
}

/** What the server itself persisted about one deployment, as plain strings. */
function record(instance: string, deploymentId: string) {
  const database = new Database(join(instance, "deployments.sqlite"), {
    readonly: true,
  });
  try {
    const row: unknown = database
      .query("SELECT status, stage FROM deployments WHERE deploymentId = ?")
      .get(deploymentId);
    return decodeRecord(row);
  } finally {
    database.close();
  }
}

async function deployRevision(
  ws: ReturnType<typeof workspace>,
  directory: string
) {
  const deployed = await ws.run(["deploy"], directory);
  expect(deployed.status, deployed.output).toBe(0);
  const match = APP_URL.exec(deployed.output);
  const { url, id } = match?.groups ?? {};
  if (url === undefined || id === undefined) {
    throw new Error(`Deploy did not print an app URL: ${deployed.output}`);
  }
  return { url, id };
}

test("two committed revisions keep independent URLs across a server restart", async () => {
  if (process.platform === "win32") {
    return;
  }
  packagedTools();
  const ws = workspace();
  const source = checkout(ws.root);
  const instance = join(ws.root, "devver", "servers", "revisions");
  let running = await foreground(ws.env, "revisions");
  try {
    expect((await ws.run(["attach", running.url])).status).toBe(0);
    const a = await deployRevision(ws, source.directory);

    writeFileSync(join(source.directory, "index.html"), "<h1>revision b</h1>");
    git(source.directory, "add", ".");
    git(source.directory, "commit", "-q", "-m", "revision b");
    const commitB = git(source.directory, "rev-parse", "HEAD");
    expect(commitB).toMatch(/^[0-9a-f]{40}$/u);
    expect(commitB).not.toBe(source.commit);
    const b = await deployRevision(ws, source.directory);
    expect(b.id).not.toBe(a.id);
    expect(b.url).not.toBe(a.url);
    expect((await body(a.url)).text).toBe("<h1>committed site</h1>");
    expect((await body(b.url)).text).toBe("<h1>revision b</h1>");

    // Rewriting and deleting the source branch discards both commits from the
    // checkout; the server keeps its own retained objects and both URLs.
    git(source.directory, "checkout", "-q", "--detach", source.commit);
    git(source.directory, "branch", "-q", "-D", "main");
    git(source.directory, "reflog", "expire", "--expire=now", "--all");
    git(source.directory, "gc", "--prune=now", "-q");
    writeFileSync(join(source.directory, "index.html"), "<h1>uncommitted</h1>");
    const bare = bareRepository(instance);
    // The later revision is gone from the checkout it was deployed from.
    expect(() => {
      git(source.directory, "cat-file", "-e", `${commitB}^{commit}`);
    }).toThrow();
    // Both deployed commits, and the ref that pins each of them, survive.
    for (const commit of [source.commit, commitB]) {
      expect(git(bare, "cat-file", "-t", `${commit}^{commit}`)).toBe("commit");
    }
    const refs = git(
      bare,
      "for-each-ref",
      "--format=%(refname)",
      "refs/devver"
    );
    for (const id of [a.id, b.id]) {
      expect(refs).toContain(`refs/devver/deployments/${id}`);
    }
    expect((await body(a.url)).text).toBe("<h1>committed site</h1>");
    expect((await body(b.url)).text).toBe("<h1>revision b</h1>");

    // A killed server leaves its supervised static sites behind; the next one
    // reconciles them instead of adding a second process per deployment.
    running.child.kill("SIGKILL");
    await running.child.exited;
    rmSync(join(instance, "worktrees", b.id), { recursive: true, force: true });
    // A record pointing at the checkout does not make the server serve it: the
    // worktree of a deployment is where this server put it.
    repoint(instance, a.id, source.directory);
    running = await foreground(ws.env, "revisions");

    // The recovered deployment answers on the URL that was printed before.
    const recovered = await body(a.url);
    expect(recovered.status).toBe(200);
    expect(recovered.text).toBe("<h1>committed site</h1>");
    const unrecoverable = await body(b.url).catch(() => ({
      status: 0,
      text: "",
    }));
    expect(unrecoverable.status).not.toBe(200);
    expect(unrecoverable.text).not.toContain("committed site");
    expect(record(instance, a.id)).toMatchObject({ status: "ready" });
    expect(record(instance, b.id)).toMatchObject({ status: "degraded" });

    // Metadata this server cannot read fails its startup closed: it serves no
    // deployment rather than guessing, and replaces no earlier record.
    await stop(running.child);
    corrupt(instance, a.id);
    const published = appPort(instance);
    expect(a.url).toContain(`:${published}/`);
    // Holding the published port forces the refused startup onto another one,
    // which it must not record over the port every printed URL carries.
    const held = await hold(Number(published));
    const refusedStartup = await startupResult(ws.env, "revisions");
    await held.release();
    expect(refusedStartup.status).toBeGreaterThan(0);
    expect(refusedStartup.output).not.toMatch(CONTROL_URL);
    expect(appPort(instance)).toBe(published);
    expect(record(instance, a.id).status).toBe("bogus");
    expect(record(instance, b.id)).toMatchObject({ status: "degraded" });
    // A degraded deployment keeps the commit it pinned.
    expect(
      git(bare, "for-each-ref", "--format=%(refname)", "refs/devver")
    ).toContain(`refs/devver/deployments/${b.id}`);
  } finally {
    await stop(running.child);
    rmSync(ws.root, { recursive: true, force: true });
  }
}, 180_000);

test("a refused ready record leaves no route, process or worktree behind", async () => {
  if (process.platform === "win32") {
    return;
  }
  packagedTools();
  const ws = workspace();
  const source = checkout(ws.root);
  const instance = join(ws.root, "devver", "servers", "recording");
  const running = await foreground(ws.env, "recording");
  try {
    expect((await ws.run(["attach", running.url])).status).toBe(0);
    blockReadyRecord(instance);
    const failed = await ws.run(["deploy"], source.directory);
    expect(failed.status).not.toBe(0);
    expect(failed.output).not.toMatch(APP_URL);

    // The deployment was published and proven reachable before the record
    // failed. Every stage completed and only the ready write was refused.
    const attempt = publishedAttempt(instance);
    expect(record(instance, attempt.deploymentId)).toMatchObject({
      status: "failed",
      stage: "server",
    });
    // The route is withdrawn: the printed URL of an unpublished deployment
    // reaches nothing, and the worktree is gone.
    const routed = await body(
      `http://${attempt.deploymentId}.recording.localhost:${appPort(instance)}/`
    );
    expect(routed.status).not.toBe(200);
    expect(existsSync(join(instance, "worktrees", attempt.deploymentId))).toBe(
      false
    );
    // A failed deployment retains no commit of its own.
    expect(
      git(
        bareRepository(instance),
        "for-each-ref",
        "--format=%(refname)",
        "refs/devver"
      )
    ).toBe("");
  } finally {
    await stop(running.child);
    rmSync(ws.root, { recursive: true, force: true });
  }
}, 180_000);

test("an interrupted preparing deployment loses the site it left listening", async () => {
  if (process.platform === "win32") {
    return;
  }
  packagedTools();
  const ws = workspace();
  const source = checkout(ws.root);
  const instance = join(ws.root, "devver", "servers", "interrupted");
  let running = await foreground(ws.env, "interrupted");
  try {
    expect((await ws.run(["attach", running.url])).status).toBe(0);
    const deployed = await deployRevision(ws, source.directory);

    running.child.kill("SIGKILL");
    await running.child.exited;
    interrupt(instance, deployed.id);

    running = await foreground(ws.env, "interrupted");
    // An interrupted deploy is not recovered, and the daemon its process left
    // is stopped rather than left serving with nothing to reach it.
    expect(record(instance, deployed.id)).toMatchObject({ status: "degraded" });
    const routed = await body(deployed.url);
    expect(routed.status).not.toBe(200);
    expect(routed.text).toContain("Unknown project");
  } finally {
    await stop(running.child);
    rmSync(ws.root, { recursive: true, force: true });
  }
}, 180_000);

test("a killed server's site is recovered by the next server, toolless ones fail closed", async () => {
  if (process.platform === "win32") {
    return;
  }
  packagedTools();
  const ws = workspace();
  const source = checkout(ws.root);
  const instance = join(ws.root, "devver", "servers", "unproven");
  let running = await foreground(ws.env, "unproven");
  try {
    expect((await ws.run(["attach", running.url])).status).toBe(0);
    const a = await deployRevision(ws, source.directory);
    const published = appPort(instance);
    running.child.kill("SIGKILL");
    await running.child.exited;
    // The detached supervisor keeps serving the printed URL.
    expect((await body(a.url)).text).toBe("<h1>committed site</h1>");

    // A server without its packaged toolchain cannot reconcile recorded
    // deployments with the supervisor, so it gives up rather than guess.
    const toolless = await startupResult(
      ws.env,
      "unproven",
      await toollessServer(ws.root)
    );
    expect(toolless.status).toBeGreaterThan(0);
    expect(toolless.output).not.toMatch(CONTROL_URL);
    expect(record(instance, a.id)).toMatchObject({ status: "ready" });
    expect(appPort(instance)).toBe(published);
    expect((await body(a.url)).text).toBe("<h1>committed site</h1>");

    // A real server start replaces the supervisor it finds on its own state
    // directory and reconciles: the deployment answers on the printed URL,
    // which the slug keeps pointing at the daemon's current port.
    running = await foreground(ws.env, "unproven");
    expect(record(instance, a.id)).toMatchObject({ status: "ready" });
    const recovered = await body(a.url);
    expect(recovered.status).toBe(200);
    expect(recovered.text).toBe("<h1>committed site</h1>");
  } finally {
    await stop(running.child);
    rmSync(ws.root, { recursive: true, force: true });
  }
}, 180_000);
