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
  name: string
) {
  const child = Bun.spawn(["bun", "run", server, name, "0"], {
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
    sitePort: Schema.NullOr(Schema.String),
  })
);

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
      .query("SELECT status, sitePort FROM deployments WHERE deploymentId = ?")
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
    const commitB = git(source.directory, "commit", "-q", "-m", "revision b");
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
    const bare = join(
      instance,
      "repositories",
      readdirSync(join(instance, "repositories"))[0] ?? ""
    );
    for (const commit of [
      source.commit,
      git(source.directory, "rev-parse", "HEAD"),
    ]) {
      expect(git(bare, "cat-file", "-t", `${commit}^{commit}`)).toBe("commit");
    }
    expect(
      git(bare, "for-each-ref", "--format=%(refname)", "refs/devver")
    ).toContain(a.id);
    expect((await body(a.url)).text).toBe("<h1>committed site</h1>");
    expect((await body(b.url)).text).toBe("<h1>revision b</h1>");

    // A killed server leaves its supervised static sites behind; the next one
    // reconciles them instead of adding a second process per deployment.
    const orphanPort = record(instance, b.id).sitePort;
    expect(orphanPort).toMatch(/^\d+$/u);
    running.child.kill("SIGKILL");
    await running.child.exited;
    rmSync(join(instance, "worktrees", b.id), { recursive: true, force: true });
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
    // The static site the killed server supervised for B is stopped, not left
    // running beside a second one.
    const orphan = await body(`http://127.0.0.1:${orphanPort}/`).catch(() => ({
      status: 0,
      text: "",
    }));
    expect(orphan.text).not.toContain("revision b");
    expect(record(instance, a.id)).toMatchObject({ status: "ready" });
    expect(record(instance, b.id)).toEqual({
      status: "degraded",
      sitePort: null,
    });

    // Metadata this server cannot read fails its startup closed: it serves no
    // deployment rather than guessing, and replaces no earlier record.
    await stop(running.child);
    corrupt(instance, a.id);
    const refused = await startupResult(ws.env, "revisions");
    expect(refused.status).toBeGreaterThan(0);
    expect(refused.output).not.toMatch(CONTROL_URL);
    expect(record(instance, a.id).status).toBe("bogus");
    expect(record(instance, b.id)).toEqual({
      status: "degraded",
      sitePort: null,
    });
  } finally {
    await stop(running.child);
    rmSync(ws.root, { recursive: true, force: true });
  }
}, 180_000);
