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
  /App URL: (?<url>http:\/\/(?<id>[0-9a-f-]{36})\.localhost:(?<port>\d+)\/)/u;

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

/**
 * Nothing is listening on an address any more.
 *
 * A site whose files were removed still answers, so only a refused connection
 * proves its process is gone; the stop is not instantaneous, so it is awaited.
 */
async function refused(url: string) {
  const deadline = Date.now() + 10_000;
  let answered = { status: 0, text: "" };
  while (Date.now() < deadline) {
    try {
      answered = await body(url);
    } catch {
      return { status: 0, text: "" };
    }
    await Bun.sleep(200);
  }
  return answered;
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
    const { url, id, port } = match?.groups ?? {};
    if (url === undefined || id === undefined || port === undefined) {
      throw new Error("Deploy did not print an app URL");
    }
    appUrl = url;
    expect(deployed.output).toContain(id);
    expect(url).not.toBe(running.url);

    const index = await body(url);
    expect(index.status).toBe(200);
    expect(index.text).toBe("<h1>committed site</h1>");
    // Root-relative assets resolve under the deployment hostname.
    const asset = await body(`${url}assets/app.css`);
    expect(asset.status).toBe(200);
    expect(asset.text).toBe("body{color:#0f0}");
    // Uncommitted work is never published.
    expect((await body(`${url}secret.txt`)).status).not.toBe(200);
    expect(index.text).not.toContain("uncommitted");

    // Unknown and malformed hosts cannot reach the deployment.
    for (const host of [
      `${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}.localhost:${port}`,
      `127.0.0.1:${port}`,
      `${id}.localhost`,
      `${id}.localhost.example.com:${port}`,
    ]) {
      const unknown = await body(`http://127.0.0.1:${port}/`, { Host: host });
      expect(unknown.status, host).not.toBe(200);
      expect(unknown.text, host).not.toContain("committed site");
    }
    // The control API never serves application files.
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
    sitePort: Schema.NullOr(Schema.String),
  })
);

const decodeAttempt = Schema.decodeUnknownSync(
  Schema.Struct({ deploymentId: Schema.String, sitePort: Schema.String })
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
    database.run(
      "CREATE TABLE attempted (deploymentId TEXT NOT NULL, sitePort TEXT NOT NULL)"
    );
    database.run(`CREATE TRIGGER attempted_site AFTER UPDATE OF sitePort ON deployments
       WHEN new.sitePort IS NOT NULL
       BEGIN INSERT INTO attempted VALUES (new.deploymentId, new.sitePort); END`);
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
 * A ready record carrying a site port of someone else's choosing, or none at
 * all like a record migrated from before that column existed. Only a writer
 * outside the server can leave either.
 */
function recordSite(
  instance: string,
  deploymentId: string,
  sitePort: number | null
) {
  instanceRecords(instance, (database) => {
    database.run(
      "UPDATE deployments SET status = 'ready', stage = NULL, sitePort = ? WHERE deploymentId = ?",
      [sitePort === null ? null : String(sitePort), deploymentId]
    );
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

/** The deployment the server published before its record write was refused. */
const publishedAttempt = (instance: string) =>
  decodeAttempt(
    instanceRecords(instance, (database) =>
      database.query("SELECT deploymentId, sitePort FROM attempted").get()
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
      .query(
        "SELECT status, stage, sitePort FROM deployments WHERE deploymentId = ?"
      )
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

    // A second explicit deploy of a later commit is its own root deployment.
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
    const aPort = record(instance, a.id).sitePort;
    const orphanPort = record(instance, b.id).sitePort;
    if (aPort === null || orphanPort === null) {
      throw new Error("A ready deployment recorded no site port");
    }
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
    // Each static site the killed server supervised is stopped, not left
    // running beside the one this server started: where the recovered
    // deployment took a new port, nothing answers on the port it had.
    const aRecovered = record(instance, a.id).sitePort;
    for (const port of [aPort, orphanPort]) {
      if (port !== aRecovered) {
        expect((await refused(`http://127.0.0.1:${port}/`)).status).toBe(0);
      }
    }
    expect(record(instance, a.id)).toMatchObject({ status: "ready" });
    expect(record(instance, b.id)).toMatchObject({
      status: "degraded",
      sitePort: null,
    });

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
    expect(record(instance, b.id)).toMatchObject({
      status: "degraded",
      sitePort: null,
    });
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

    // The site was published and proven reachable before the record failed.
    const attempt = publishedAttempt(instance);
    expect(attempt.sitePort).toMatch(/^\d+$/u);
    // A recorded port with no deploy stage is the published-then-unrecordable
    // deployment: every stage completed and only the ready write was refused.
    expect(record(instance, attempt.deploymentId)).toEqual({
      status: "failed",
      stage: "server",
      sitePort: null,
    });
    // The route is withdrawn, not merely serving a removed worktree: the
    // listener's own answer is what an unpublished address gives.
    const routed = await body(
      `http://${attempt.deploymentId}.localhost:${appPort(instance)}/`
    );
    expect(routed.status).not.toBe(200);
    expect(routed.text).toContain("No deployment is published");
    // The static site process is stopped, and its worktree is gone.
    expect(
      (await refused(`http://127.0.0.1:${attempt.sitePort}/`)).status
    ).toBe(0);
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
    const { sitePort } = record(instance, deployed.id);
    expect(sitePort).toMatch(/^\d+$/u);

    running.child.kill("SIGKILL");
    await running.child.exited;
    // The killed server's supervised site is still serving on its own port.
    expect((await body(`http://127.0.0.1:${sitePort}/`)).text).toBe(
      "<h1>committed site</h1>"
    );
    interrupt(instance, deployed.id);

    running = await foreground(ws.env, "interrupted");
    // An interrupted deploy is not recovered, and what it started is stopped
    // rather than left listening with nothing to reach it.
    expect((await refused(`http://127.0.0.1:${sitePort}/`)).status).toBe(0);
    expect(record(instance, deployed.id)).toMatchObject({
      status: "degraded",
      sitePort: null,
    });
    const routed = await body(deployed.url);
    expect(routed.status).not.toBe(200);
    expect(routed.text).toContain("No deployment is published");
  } finally {
    await stop(running.child);
    rmSync(ws.root, { recursive: true, force: true });
  }
}, 180_000);

test("a recorded site that cannot be proven gone is never replaced", async () => {
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
    const { sitePort } = record(instance, a.id);
    if (sitePort === null) {
      throw new Error("A ready deployment recorded no site port");
    }
    const published = appPort(instance);
    const site = `http://127.0.0.1:${sitePort}/`;
    running.child.kill("SIGKILL");
    await running.child.exited;
    // The killed server's supervised site is still serving on its own port.
    expect((await body(site)).text).toBe("<h1>committed site</h1>");

    // A server without its packaged toolchain cannot stop that site, so it
    // gives up rather than forget the port that is the only way to reach it.
    const toolless = await startupResult(
      ws.env,
      "unproven",
      await toollessServer(ws.root)
    );
    expect(toolless.status).toBeGreaterThan(0);
    expect(toolless.output).not.toMatch(CONTROL_URL);
    expect(record(instance, a.id)).toMatchObject({ status: "ready", sitePort });
    expect(appPort(instance)).toBe(published);
    expect((await body(site)).text).toBe("<h1>committed site</h1>");

    // A recorded port still answering after the teardown ran is the proof the
    // old backend is there. The port a record keeps is also what shows no
    // second site was started for it: starting one records its own port first.
    const held = await hold(0);
    recordSite(instance, a.id, held.port);
    const unstoppable = await startupResult(ws.env, "unproven");
    expect(unstoppable.status).toBeGreaterThan(0);
    expect(unstoppable.output).not.toMatch(CONTROL_URL);
    expect(record(instance, a.id)).toMatchObject({
      status: "ready",
      sitePort: String(held.port),
    });
    expect(appPort(instance)).toBe(published);
    const unpublished = await body(a.url).catch(() => ({ status: 0 }));
    expect(unpublished.status).not.toBe(200);
    await held.release();

    // A ready record with no port at all cannot show its backend is gone
    // either: it is retired without a route instead of being served twice.
    recordSite(instance, a.id, null);
    running = await foreground(ws.env, "unproven");
    expect(record(instance, a.id)).toMatchObject({
      status: "degraded",
      sitePort: null,
    });
    const unrouted = await body(a.url).catch(() => ({ status: 0, text: "" }));
    expect(unrouted.status).not.toBe(200);
    expect(unrouted.text).not.toContain("committed site");
    // The site the killed server left is still the only one serving it.
    expect((await body(site)).text).toBe("<h1>committed site</h1>");
    await stop(running.child);

    // Restoring the port it was started on lets a later start finish the
    // cleanup the refused ones deferred, and recover the deployment.
    recordSite(instance, a.id, Number(sitePort));
    running = await foreground(ws.env, "unproven");
    const recovered = await body(a.url);
    expect(recovered.status).toBe(200);
    expect(recovered.text).toBe("<h1>committed site</h1>");
    const after = record(instance, a.id);
    expect(after.status).toBe("ready");
    if (after.sitePort !== sitePort) {
      expect((await refused(site)).status).toBe(0);
    }
  } finally {
    await stop(running.child);
    rmSync(ws.root, { recursive: true, force: true });
  }
}, 180_000);
