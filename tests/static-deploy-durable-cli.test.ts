import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  /App URL: (?<url>http:\/\/(?<id>[0-9a-f-]{36})\.(?<project>[a-z0-9-]+)\.localhost:(?<port>\d+)\/)/u;

function packagedTools() {
  const tools = join(repo, "servers", pkg.version);
  if (
    !existsSync(
      join(tools, `ferron${process.platform === "win32" ? ".exe" : ""}`)
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
  const root = mkdtempSync(join(tmpdir(), "devver-durable-deploy-"));
  const env = {
    ...process.env,
    XDG_DATA_HOME: root,
    XDG_CONFIG_HOME: root,
    XDG_CACHE_HOME: root,
    XDG_STATE_HOME: root,
  };
  return { root, env };
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
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "index.html"), "<h1>durable page</h1>");
  git(directory, "init", "-q", "-b", "main");
  git(directory, "add", ".");
  git(directory, "commit", "-q", "-m", "durable page");
  const commit = git(directory, "rev-parse", "HEAD");
  writeFileSync(join(directory, "index.html"), "<h1>uncommitted edit</h1>");
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

async function runCli(
  env: Record<string, string | undefined>,
  cwd: string,
  args: string[]
) {
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
}

async function body(url: string) {
  const response = await fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(5000),
  });
  return { status: response.status, text: await response.text() };
}

const RecordRows = Schema.Array(
  Schema.Struct({
    deploymentId: Schema.String,
    status: Schema.String,
    stage: Schema.NullOr(Schema.String),
  })
);
type RecordRow = (typeof RecordRows.Type)[number];

function records(root: string) {
  const instance = join(
    root,
    "devver",
    "servers",
    "verify-static",
    "deployments.sqlite"
  );
  if (!existsSync(instance)) {
    return undefined;
  }
  try {
    const db = new Database(instance, { readonly: true });
    try {
      return Schema.decodeUnknownSync(RecordRows)(
        db.query("SELECT deploymentId, status, stage FROM deployments").all()
      );
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

async function waitForRecord(
  root: string,
  accept: (rows: readonly RecordRow[]) => boolean
) {
  const deadline = Date.now() + 60_000;
  let observed = "none";
  while (Date.now() < deadline) {
    const rows = records(root);
    if (rows !== undefined) {
      observed = JSON.stringify(rows);
      if (accept(rows)) {
        return rows;
      }
    }
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for deployment records: ${observed}`);
}

test("a killed static deploy resumes to ready and same-commit deployments stay distinct", async () => {
  if (process.platform === "win32") {
    return;
  }
  packagedTools();
  const ws = workspace();
  const source = checkout(ws.root);
  const name = "verify-static";
  const first = await foreground(ws.env, name);
  try {
    expect(
      (await runCli(ws.env, source.directory, ["attach", first.url])).status
    ).toBe(0);

    const deploying = Bun.spawn(["bun", "run", cli, "deploy", "--verbose"], {
      cwd: source.directory,
      env: ws.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const preparing = await waitForRecord(ws.root, (rows) =>
      rows.some((row) => row.status === "preparing")
    );
    first.child.kill(9);
    await first.child.exited;
    await Promise.race([deploying.exited, Bun.sleep(2000)]);
    deploying.kill();
    await deploying.exited;

    const journal = join(ws.root, "devver", "servers", name, "workflow.sqlite");
    expect(existsSync(journal)).toBe(true);

    const interrupted = preparing.find((row) => row.status === "preparing");
    expect(interrupted).toBeDefined();

    const restart = await foreground(ws.env, name);
    try {
      const resumed = await waitForRecord(ws.root, (rows) =>
        rows.some(
          (row) =>
            row.deploymentId === interrupted?.deploymentId &&
            row.status === "ready" &&
            row.stage === null
        )
      );
      const served = resumed.find(
        (row) => row.deploymentId === interrupted?.deploymentId
      );
      if (served === undefined) {
        throw new Error("The killed deployment did not resume to ready");
      }
      const listing = await body(`${restart.url}/deployments`);
      expect(listing.status).toBe(200);
      expect(listing.text).toContain(`"deploymentId":"${served.deploymentId}"`);
      expect(listing.text).toContain('"status":"ready"');

      const reattached = await runCli(ws.env, source.directory, [
        "attach",
        restart.url,
      ]);
      expect(reattached.status, reattached.output).toBe(0);

      const second = await runCli(ws.env, source.directory, [
        "deploy",
        "--verbose",
      ]);
      expect(second.output).toContain(source.commit);
      expect(second.output).toContain("not sandboxed");
      const secondMatch = APP_URL.exec(second.output)?.groups?.url;
      expect(secondMatch, second.output).toBeDefined();
      expect(second.status, second.output).toBe(0);

      const repeat = await waitForRecord(
        ws.root,
        (rows) => rows.filter((row) => row.status === "ready").length === 2
      );
      expect(new Set(repeat.map((row) => row.deploymentId)).size).toBe(2);
      const appUrl = new URL(secondMatch ?? "http://invalid.localhost/");
      const firstUrl = `http://${served.deploymentId}.${name}.localhost:${appUrl.port}/`;
      const firstPage = await body(firstUrl);
      expect(firstPage.status).toBe(200);
      expect(firstPage.text).toBe("<h1>durable page</h1>");
      const secondPage = await body(secondMatch ?? "about:blank");
      expect(secondPage.status).toBe(200);
      expect(secondPage.text).toBe("<h1>durable page</h1>");

      const storedDb = new Database(
        join(ws.root, "devver", "servers", name, "deployments.sqlite")
      );
      storedDb
        .query(
          "UPDATE deployments SET status = 'preparing' WHERE deploymentId = ?"
        )
        .run(served.deploymentId);
      storedDb.close();
      restart.child.kill();
      await restart.child.exited;
      const recovery = await foreground(ws.env, name);
      try {
        await waitForRecord(ws.root, (rows) =>
          rows.some(
            (row) =>
              row.deploymentId === served.deploymentId && row.status === "ready"
          )
        );
        const recoveredPage = await body(firstUrl);
        expect(recoveredPage.status).toBe(200);
        expect(recoveredPage.text).toBe("<h1>durable page</h1>");
      } finally {
        recovery.child.kill();
        await recovery.child.exited;
      }
    } finally {
      restart.child.kill();
      await restart.child.exited;
    }
  } finally {
    first.child.kill();
    await first.child.exited;
    rmSync(ws.root, { recursive: true, force: true });
  }
}, 180_000);

test("restart preserves a resumed process while restoring older ready workloads", async () => {
  if (process.platform === "win32") {
    return;
  }
  packagedTools();
  const ws = workspace();
  const source = checkout(ws.root);
  const name = "verify-static";
  const first = await foreground(ws.env, name);
  try {
    expect(
      (await runCli(ws.env, source.directory, ["attach", first.url])).status
    ).toBe(0);
    const page = await runCli(ws.env, source.directory, [
      "deploy",
      "--verbose",
    ]);
    expect(page.status, page.output).toBe(0);
    const pageUrl = APP_URL.exec(page.output)?.groups?.url;
    expect(pageUrl).toBeDefined();
    const gate = join(ws.root, "release-build");
    const marker = join(ws.root, "build-started");
    writeFileSync(gate, "release");
    writeFileSync(
      join(source.directory, "build.mjs"),
      `import { existsSync, writeFileSync } from 'node:fs';\nimport { setTimeout } from 'node:timers/promises';\nwriteFileSync(${JSON.stringify(marker)}, 'started');\nwhile (!existsSync(${JSON.stringify(gate)})) await setTimeout(50);\n`
    );
    writeFileSync(
      join(source.directory, "server.mjs"),
      "import { createServer } from 'node:http';\ncreateServer((_req, res) => res.end('node deployment')).listen(Number(process.env.PORT), process.env.HOST);\n"
    );
    writeFileSync(
      join(source.directory, ".devver.yaml"),
      "process:\n  build: node build.mjs\n  run: node server.mjs\n"
    );
    git(source.directory, "add", ".devver.yaml", "server.mjs", "build.mjs");
    git(source.directory, "commit", "-qm", "Node process");
    const backend = await runCli(ws.env, source.directory, [
      "deploy",
      "--verbose",
    ]);
    expect(backend.status, backend.output).toBe(0);
    const backendUrl = APP_URL.exec(backend.output)?.groups?.url;
    expect(backendUrl).toBeDefined();
    rmSync(gate);
    rmSync(marker);
    const deploying = Bun.spawn(["bun", "run", cli, "deploy", "--verbose"], {
      cwd: source.directory,
      env: ws.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const deadline = Date.now() + 30_000;
      while (!existsSync(marker) && Date.now() < deadline) {
        await Bun.sleep(20);
      }
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf-8")).toBe("started");
      const preparing = await waitForRecord(ws.root, (rows) =>
        rows.some((row) => row.status === "preparing")
      );
      const interrupted = preparing.find((row) => row.status === "preparing");
      expect(interrupted).toBeDefined();
      first.child.kill(9);
      await first.child.exited;
      await deploying.exited;
      writeFileSync(gate, "release");
      const restart = await foreground(ws.env, name);
      try {
        await waitForRecord(
          ws.root,
          (rows) =>
            rows.length === 3 && rows.every((row) => row.status === "ready")
        );
        if (
          pageUrl === undefined ||
          backendUrl === undefined ||
          interrupted === undefined
        ) {
          throw new Error("The deployment URLs were not recorded");
        }
        const recoveredUrl = new URL(backendUrl);
        recoveredUrl.hostname = `${interrupted.deploymentId}.${name}.localhost`;
        expect(await body(pageUrl)).toEqual({
          status: 200,
          text: "<h1>durable page</h1>",
        });
        expect(await body(backendUrl)).toEqual({
          status: 200,
          text: "node deployment",
        });
        expect(await body(recoveredUrl.href)).toEqual({
          status: 200,
          text: "node deployment",
        });
      } finally {
        restart.child.kill();
        await restart.child.exited;
      }
    } finally {
      deploying.kill();
      await deploying.exited;
    }
  } finally {
    first.child.kill();
    await first.child.exited;
    rmSync(ws.root, { recursive: true, force: true });
  }
}, 180_000);
