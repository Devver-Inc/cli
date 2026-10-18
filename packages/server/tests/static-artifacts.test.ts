import { expect, test } from "bun:test";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import pkg from "../../../package.json";
import { stopStaticSite } from "../index";
import { windowsServersDirectory } from "../windows-acl";

const repo = join(import.meta.dir, "../../..");
// The directories the probe derives from the root it is given.
const PROBE_INSTANCES = ["instance", "another-instance"];
const NO_RUNTIME_PATH =
  process.platform === "win32"
    ? "C:\\Windows\\System32;C:\\Windows\\System32\\WindowsPowerShell\\v1.0"
    : "/usr/bin:/bin";

function isInetAddress(
  address: string | AddressInfo | null
): address is AddressInfo {
  return address !== null && typeof address !== "string";
}

async function availablePort() {
  const listener = createServer();
  await new Promise<void>((resolve) => {
    listener.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = listener.address();
    if (!isInetAddress(address)) {
      throw new Error("No allocated port");
    }
    return address.port;
  } finally {
    await new Promise<void>((resolve, reject) => {
      listener.close((error) => {
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      });
    });
  }
}

/**
 * This check, not the probe, owns the directories and ports a probe run uses,
 * so it can tear the managed processes down even when the probe never reaches
 * its own teardown.
 */
async function probeWorkspace() {
  const root = await mkdtemp(
    join(
      process.platform === "win32"
        ? dirname(await windowsServersDirectory())
        : tmpdir(),
      "devver-static-probe-"
    )
  );
  return { root, ports: [await availablePort(), await availablePort()] };
}

async function teardown(
  toolsDirectory: string,
  workspace: { root: string; ports: number[] }
) {
  for (const [index, name] of PROBE_INSTANCES.entries()) {
    const port = workspace.ports[index];
    if (port === undefined) {
      continue;
    }
    try {
      await stopStaticSite({
        toolsDirectory,
        instanceDirectory: join(workspace.root, name),
        port,
      });
    } catch {
      // A probe that failed before starting has no instance state to address.
    }
  }
}

async function serves(port: number) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(1000),
    });
    await response.body?.cancel();
    return response.status === 200;
  } catch {
    return false;
  }
}

async function probeCommand(
  distribution: string,
  temp: string,
  node: string,
  source = "static-artifact-probe.ts"
) {
  const probe = join(
    temp,
    distribution === "npm"
      ? "probe.mjs"
      : `probe${process.platform === "win32" ? ".exe" : ""}`
  );
  const result = await Bun.build({
    entrypoints: [join(repo, "packages/server/tests", source)],
    ...(distribution === "npm"
      ? {
          target: "node",
          packages: "bundle",
          outdir: temp,
          naming: { entry: "probe.mjs" },
        }
      : { compile: { outfile: probe } }),
  });
  expect(result.success, result.logs.map((log) => log.message).join("\n")).toBe(
    true
  );
  return distribution === "npm" ? [node, probe] : [probe];
}

test("npm and standalone artifacts serve a loopback-only static site without runtime downloads", async () => {
  // Windows' actual owner-only state root is exercised only in the isolated CI job.
  if (
    process.platform === "win32" &&
    process.env.DEVVER_WINDOWS_STATE_TESTS !== "1"
  ) {
    return;
  }
  const node = Bun.which("node");
  if (node === null) {
    throw new Error("Node is required for the npm artifact check");
  }
  for (const distribution of ["npm", "standalone"]) {
    const build = Bun.spawnSync(
      ["bun", "run", distribution === "npm" ? "build:npm" : "build"],
      { cwd: repo, stdout: "pipe", stderr: "pipe" }
    );
    expect(build.exitCode, build.stderr.toString()).toBe(0);
    const directory =
      distribution === "npm"
        ? join(repo, "packages/cli/dist/servers", pkg.version)
        : join(repo, "servers", pkg.version);
    const temp = await mkdtemp(join(tmpdir(), "devver-artifact-probe-"));
    try {
      const command = await probeCommand(distribution, temp, node);
      const workspace = await probeWorkspace();
      try {
        const child = Bun.spawnSync(
          [
            ...command,
            directory,
            workspace.root,
            ...workspace.ports.map(String),
          ],
          {
            cwd: temp,
            env: { ...process.env, PATH: NO_RUNTIME_PATH },
            stdout: "pipe",
            stderr: "pipe",
            timeout: 60_000,
          }
        );
        expect(child.exitCode, child.stderr.toString()).toBe(0);
      } finally {
        await teardown(directory, workspace);
        await rm(workspace.root, { recursive: true, force: true });
      }
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
}, 300_000);

test("broken packaged Pitchfork or Websitino cannot leave a reachable site", async () => {
  if (
    process.platform === "win32" &&
    process.env.DEVVER_WINDOWS_STATE_TESTS !== "1"
  ) {
    return;
  }
  const node = Bun.which("node");
  if (node === null) {
    throw new Error("Node is required for the npm artifact check");
  }
  for (const distribution of ["npm", "standalone"]) {
    const build = Bun.spawnSync(
      ["bun", "run", distribution === "npm" ? "build:npm" : "build"],
      { cwd: repo, stdout: "pipe", stderr: "pipe" }
    );
    expect(build.exitCode, build.stderr.toString()).toBe(0);
    const packaged =
      distribution === "npm"
        ? join(repo, "packages/cli/dist/servers", pkg.version)
        : join(repo, "servers", pkg.version);
    const temp = await mkdtemp(join(tmpdir(), "devver-broken-tools-"));
    try {
      const command = await probeCommand(
        distribution,
        temp,
        node,
        "static-start-failure-probe.ts"
      );
      for (const broken of ["pitchfork", "websitino"]) {
        const workspace = await probeWorkspace();
        const tools = join(workspace.root, "tools");
        const extension = process.platform === "win32" ? ".exe" : "";
        try {
          await mkdir(tools);
          for (const name of ["pitchfork", "websitino"]) {
            const destination = join(tools, `${name}${extension}`);
            await (name === broken
              ? writeFile(destination, "not an executable")
              : copyFile(join(packaged, `${name}${extension}`), destination));
            if (process.platform !== "win32") {
              await chmod(destination, 0o700);
            }
          }
          const [port] = workspace.ports;
          if (port === undefined) {
            throw new Error("No allocated port");
          }
          const child = Bun.spawnSync(
            [...command, tools, workspace.root, String(port)],
            {
              cwd: temp,
              env: { ...process.env, PATH: NO_RUNTIME_PATH },
              stdout: "pipe",
              stderr: "pipe",
              timeout: 60_000,
            }
          );
          expect(child.exitCode, child.stderr.toString()).toBe(0);
          expect(await serves(port)).toBe(false);
        } finally {
          await teardown(tools, workspace);
          await rm(workspace.root, { recursive: true, force: true });
        }
      }
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
}, 300_000);

test("a killed static site check still tears down the managed process it started", async () => {
  if (
    process.platform === "win32" &&
    process.env.DEVVER_WINDOWS_STATE_TESTS !== "1"
  ) {
    return;
  }
  const node = Bun.which("node");
  if (node === null) {
    throw new Error("Node is required for the npm artifact check");
  }
  const build = Bun.spawnSync(["bun", "run", "build:npm"], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(build.exitCode, build.stderr.toString()).toBe(0);
  const directory = join(repo, "packages/cli/dist/servers", pkg.version);
  const temp = await mkdtemp(join(tmpdir(), "devver-artifact-probe-"));
  const workspace = await probeWorkspace();
  const [port] = workspace.ports;
  if (port === undefined) {
    throw new Error("No allocated port");
  }
  try {
    const command = await probeCommand("npm", temp, node);
    const child = Bun.spawn(
      [...command, directory, workspace.root, ...workspace.ports.map(String)],
      {
        cwd: temp,
        env: { ...process.env, PATH: NO_RUNTIME_PATH },
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    try {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline && !(await serves(port))) {
        await Bun.sleep(200);
      }
      expect(await serves(port)).toBe(true);
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
    // Pitchfork supervises the site, so killing its starter leaves it running:
    // only this check's own teardown can remove it.
    expect(await serves(port)).toBe(true);
    await teardown(directory, workspace);
    expect(await serves(port)).toBe(false);
  } finally {
    await teardown(directory, workspace);
    await rm(workspace.root, { recursive: true, force: true });
    await rm(temp, { recursive: true, force: true });
  }
}, 300_000);
