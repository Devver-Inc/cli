import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
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
