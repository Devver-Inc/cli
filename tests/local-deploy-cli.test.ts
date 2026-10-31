import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pkg from "../package.json" with { type: "json" };

const repo = join(import.meta.dir, "..");
const cli = join(repo, "packages", "cli", "src", "cli", "index.ts");
const server = join(repo, "packages", "server", "src", "index.ts");
const CONTROL_URL = /^http:\/\/127\.0\.0\.1:\d+\/api\/v1$/u;
const APP_URL =
  /App URL: (?<url>http:\/\/(?<id>[0-9a-f-]{36})\.(?<project>[a-z0-9-]+)\.localhost:(?<port>\d+)\/)/u;

function packagedTools() {
  const tools = join(repo, "servers", pkg.version);
  if (
    !existsSync(
      join(tools, `websitino${process.platform === "win32" ? ".exe" : ""}`)
    )
  ) {
    const build = Bun.spawnSync(["bun", "run", "build"], {
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
        }, 60_000);
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

async function body(url: string, headers: Record<string, string> = {}) {
  const response = await fetch(url, {
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(5000),
  });
  return { status: response.status, text: await response.text() };
}

function isTcpAddress(
  address: string | AddressInfo | null
): address is AddressInfo {
  return address !== null && typeof address !== "string";
}

test("server status identifies older same-version servers without deployment listing", async () => {
  const ws = workspace();
  const instanceId = crypto.randomUUID();
  const older = createServer((request, response) => {
    if (request.url === "/api/v1/identity") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          instanceId,
          name: "older",
          serverVersion: pkg.version,
          controlProtocolVersion: 1,
        })
      );
    } else {
      response.writeHead(405);
      response.end();
    }
  });
  await new Promise<void>((resolve) => {
    older.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = older.address();
    if (!isTcpAddress(address)) {
      throw new Error("Old server did not bind a TCP port");
    }
    const attached = await ws.run([
      "attach",
      `http://127.0.0.1:${address.port}/api/v1`,
    ]);
    expect(attached.status, attached.output).toBe(0);
    const status = await ws.run(["server", "status"]);
    expect(status.status, status.output).toBe(0);
    expect(status.output).toContain(": reachable");
    expect(status.output).toContain("Deployment status unavailable");
  } finally {
    await new Promise<void>((resolve) => {
      older.close(() => {
        resolve();
      });
    });
    rmSync(ws.root, { recursive: true, force: true });
  }
});

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

    const deployed = await ws.run(["deploy", "--verbose"], source.directory);
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

    writeFileSync(join(source.directory, "index.html"), "<h1>later</h1>");
    git(source.directory, "add", ".");
    git(source.directory, "commit", "-q", "-m", "later revision");
    expect((await body(url)).text).toBe("<h1>committed site</h1>");
  } finally {
    await stop(running.child);
    rmSync(ws.root, { recursive: true, force: true });
  }
  if (appUrl !== undefined) {
    const orphan = await body(appUrl).catch(() => ({ status: 0, text: "" }));
    expect(orphan.status).not.toBe(200);
  }
}, 180_000);

test("server migrates existing deployment records to nullable second-parent lineage", async () => {
  if (process.platform === "win32") {
    return;
  }
  packagedTools();
  const ws = workspace();
  const source = checkout(ws.root);
  const running = await foreground(ws.env, "older-store");
  let stopped = false;
  try {
    expect((await ws.run(["attach", running.url])).status).toBe(0);
    const deployed = await ws.run(["deploy"], source.directory);
    expect(deployed.status, deployed.output).toBe(0);
    const url = APP_URL.exec(deployed.output)?.groups?.url;
    expect(url).toBeDefined();
    await stop(running.child);
    stopped = true;
    const db = new Database(
      join(ws.root, "devver", "servers", "older-store", "deployments.sqlite")
    );
    try {
      db.run("ALTER TABLE deployments DROP COLUMN secondParentDeploymentId");
    } finally {
      db.close();
    }
    const restarted = await foreground(ws.env, "older-store");
    try {
      const listing = await body(`${restarted.url}/deployments`);
      expect(listing.status).toBe(200);
      expect(listing.text).toContain('"secondParentDeploymentId":null');
      if (url !== undefined) {
        expect((await body(url)).text).toBe("<h1>committed site</h1>");
      }
    } finally {
      await stop(restarted.child);
    }
  } finally {
    if (!stopped) {
      await stop(running.child);
    }
    rmSync(ws.root, { recursive: true, force: true });
  }
}, 180_000);

async function assertSameRevisionRejected(
  ws: ReturnType<typeof workspace>,
  site: string,
  url: string,
  firstId: string,
  firstCommit: string
) {
  git(site, "checkout", "-q", "--detach", firstCommit);
  const deployed = await ws.run(["deploy"], site);
  expect(deployed.status, deployed.output).toBe(0);
  const sameRevision = APP_URL.exec(deployed.output)?.groups?.id;
  expect(sameRevision).toBeDefined();
  const before = await body(`${url}/deployments`);
  const identical = await ws.run(["merge", firstId, sameRevision ?? ""], site);
  expect(identical.status).not.toBe(0);
  expect(identical.output).toContain("same revision");
  expect((await body(`${url}/deployments`)).text).toBe(before.text);
}

test("merge creates a two-parent revision without changing either source checkout or app", async () => {
  if (process.platform === "win32") {
    return;
  }
  packagedTools();
  const ws = workspace();
  const site = join(ws.root, "merge-site");
  mkdirSync(site);
  writeFileSync(join(site, "index.html"), "<h1>base</h1>");
  git(site, "init", "-q", "-b", "main");
  git(site, "add", ".");
  git(site, "commit", "-q", "-m", "base");
  const base = git(site, "rev-parse", "HEAD");
  writeFileSync(join(site, "first.txt"), "first");
  git(site, "add", ".");
  git(site, "commit", "-q", "-m", "first");
  const firstCommit = git(site, "rev-parse", "HEAD");
  const running = await foreground(ws.env, "merging");
  try {
    expect((await ws.run(["attach", running.url])).status).toBe(0);
    const first = await ws.run(["deploy"], site);
    expect(first.status, first.output).toBe(0);
    const firstMatch = APP_URL.exec(first.output)?.groups;
    expect(firstMatch?.id).toBeDefined();
    git(site, "checkout", "-q", "-b", "second", base);
    writeFileSync(join(site, "second.txt"), "second");
    git(site, "add", ".");
    git(site, "commit", "-q", "-m", "second");
    const secondCommit = git(site, "rev-parse", "HEAD");
    const second = await ws.run(["deploy"], site);
    expect(second.status, second.output).toBe(0);
    const secondMatch = APP_URL.exec(second.output)?.groups;
    expect(secondMatch?.id).toBeDefined();
    if (firstMatch?.id === undefined || secondMatch?.id === undefined) {
      throw new Error("Deployments did not return IDs");
    }
    const firstId = firstMatch.id;
    const merged = await ws.run(["merge", firstMatch.id, secondMatch.id], site);
    expect(merged.status, merged.output).toBe(0);
    const id = /Merged deployment (?<id>[0-9a-f-]{36})/u.exec(merged.output)
      ?.groups?.id;
    const commit = /Commit: (?<commit>[0-9a-f]{40})/u.exec(merged.output)
      ?.groups?.commit;
    const url = /App URL: (?<url>http:\/\/[^\s]+)/u.exec(merged.output)?.groups
      ?.url;
    expect(id).toBeDefined();
    expect(commit).toBeDefined();
    expect(url).toBeDefined();
    if (id === undefined || commit === undefined || url === undefined) {
      throw new Error("Merge did not return a revision and URL");
    }
    expect(git(site, "rev-parse", "HEAD")).toBe(secondCommit);
    expect(git(site, "status", "--porcelain")).toBe("");
    const repositoryId = createHash("sha256")
      .update(realpathSync(site))
      .digest("hex");
    const bare = join(
      ws.root,
      "devver",
      "servers",
      "merging",
      "repositories",
      `${repositoryId}.git`
    );
    expect(git(bare, "rev-list", "--parents", "-n", "1", commit)).toBe(
      `${commit} ${firstCommit} ${secondCommit}`
    );
    expect((await body(`${url}first.txt`)).text).toBe("first");
    expect((await body(`${url}second.txt`)).text).toBe("second");
    expect((await body(`${firstMatch.url}second.txt`)).status).not.toBe(200);
    expect((await body(`${secondMatch.url}first.txt`)).status).not.toBe(200);
    const listing = await body(`${running.url}/deployments`);
    expect(listing.status).toBe(200);
    const rows: unknown = JSON.parse(listing.text);
    expect(Array.isArray(rows)).toBe(true);
    if (!Array.isArray(rows)) {
      throw new TypeError("Deployment list is not an array");
    }
    expect(rows).toContainEqual(
      expect.objectContaining({
        deploymentId: secondMatch.id,
        parentDeploymentId: null,
      })
    );
    expect(rows).toContainEqual(
      expect.objectContaining({
        deploymentId: id,
        parentDeploymentId: firstMatch.id,
        secondParentDeploymentId: secondMatch.id,
        commit,
        status: "ready",
      })
    );
    const duplicate = await ws.run(
      ["merge", firstMatch.id, firstMatch.id],
      site
    );
    expect(duplicate.status).not.toBe(0);
    await assertSameRevisionRejected(
      ws,
      site,
      running.url,
      firstId,
      firstCommit
    );

    await (async () => {
      git(site, "checkout", "-q", "-b", "conflict-a", base);
      writeFileSync(join(site, "index.html"), "<h1>conflict A</h1>");
      git(site, "add", ".");
      git(site, "commit", "-q", "-m", "conflict A");
      const conflictA = APP_URL.exec((await ws.run(["deploy"], site)).output)
        ?.groups?.id;
      git(site, "checkout", "-q", "-b", "conflict-b", base);
      writeFileSync(join(site, "index.html"), "<h1>conflict B</h1>");
      git(site, "add", ".");
      git(site, "commit", "-q", "-m", "conflict B");
      const conflictB = APP_URL.exec((await ws.run(["deploy"], site)).output)
        ?.groups?.id;
      if (conflictA === undefined || conflictB === undefined) {
        throw new Error("Conflicting source deployments were not created");
      }
      const beforeConflict = await body(`${running.url}/deployments`);
      const conflict = await ws.run(["merge", conflictA, conflictB], site);
      expect(conflict.status).not.toBe(0);
      expect(conflict.output).toContain(
        "Merge conflicts prevent combining these revisions"
      );
      expect((await body(`${running.url}/deployments`)).text).toBe(
        beforeConflict.text
      );
      expect(git(site, "status", "--porcelain")).toBe("");
      git(site, "checkout", "-q", "-b", "descendant", firstCommit);
      writeFileSync(join(site, "third.txt"), "third");
      git(site, "add", ".");
      git(site, "commit", "-q", "-m", "descendant");
      const descendantCommit = git(site, "rev-parse", "HEAD");
      const descendant = APP_URL.exec((await ws.run(["deploy"], site)).output)
        ?.groups?.id;
      if (descendant === undefined) {
        throw new Error("Descendant deployment was not created");
      }
      const ancestorMerge = await ws.run(["merge", firstId, descendant], site);
      expect(ancestorMerge.status, ancestorMerge.output).toBe(0);
      const ancestorCommit = /Commit: (?<commit>[0-9a-f]{40})/u.exec(
        ancestorMerge.output
      )?.groups?.commit;
      expect(ancestorCommit).toBeDefined();
      if (ancestorCommit !== undefined) {
        expect(
          git(bare, "rev-list", "--parents", "-n", "1", ancestorCommit)
        ).toBe(`${ancestorCommit} ${firstCommit} ${descendantCommit}`);
      }
      git(site, "checkout", "-q", "--orphan", "orphan");
      git(site, "rm", "-qrf", ".");
      writeFileSync(join(site, "index.html"), "<h1>orphan</h1>");
      git(site, "add", ".");
      git(site, "commit", "-q", "-m", "orphan");
      const orphan = APP_URL.exec((await ws.run(["deploy"], site)).output)
        ?.groups?.id;
      if (orphan === undefined) {
        throw new Error("Orphan deployment was not created");
      }
      const beforeUnrelated = await body(`${running.url}/deployments`);
      const unrelated = await ws.run(["merge", firstId, orphan], site);
      expect(unrelated.status).not.toBe(0);
      expect(unrelated.output).toContain(
        "Git histories are unrelated or unavailable"
      );
      expect((await body(`${running.url}/deployments`)).text).toBe(
        beforeUnrelated.text
      );
      const other = join(ws.root, "other-site");
      mkdirSync(other);
      writeFileSync(join(other, "index.html"), "<h1>other repo</h1>");
      git(other, "init", "-q", "-b", "main");
      git(other, "add", ".");
      git(other, "commit", "-q", "-m", "other repo");
      const otherId = APP_URL.exec((await ws.run(["deploy"], other)).output)
        ?.groups?.id;
      if (otherId === undefined) {
        throw new Error("Other repository was not deployed");
      }
      const crossRepo = await ws.run(["merge", firstId, otherId], other);
      expect(crossRepo.status).not.toBe(0);
      expect(crossRepo.output).toContain(
        "Both deployments must belong to the same repository"
      );
      expect((await body(`${running.url}/deployments`)).text).toContain(
        `"deploymentId":"${otherId}"`
      );
    })();
    await stop(running.child);
    const restarted = await foreground(ws.env, "merging");
    try {
      expect((await body(`${url}first.txt`)).text).toBe("first");
      expect((await body(`${url}second.txt`)).text).toBe("second");
      const afterRestart = await body(`${restarted.url}/deployments`);
      expect(afterRestart.text).toContain(
        `"secondParentDeploymentId":"${secondMatch.id}"`
      );
    } finally {
      await stop(restarted.child);
    }
  } finally {
    await stop(running.child);
    rmSync(ws.root, { recursive: true, force: true });
  }
}, 180_000);
