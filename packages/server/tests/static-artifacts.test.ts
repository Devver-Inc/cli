import { expect, test } from "bun:test";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import pkg from "../../../package.json";
import { stopDeploymentHost } from "../index";
import { windowsServersDirectory } from "../windows-acl";

const repo = join(import.meta.dir, "../../..");
// The directory the probe derives from the root it is given.
const PROBE_INSTANCE = "instance";
const PROXY_PORT = /proxyPort=(?<port>\d+)/u;
const NO_RUNTIME_PATH =
  process.platform === "win32"
    ? "C:\\Windows\\System32;C:\\Windows\\System32\\WindowsPowerShell\\v1.0"
    : "/usr/bin:/bin";

const skipped = () =>
  process.platform === "win32" &&
  process.env.DEVVER_WINDOWS_STATE_TESTS !== "1";

function requireNode() {
  const node = Bun.which("node");
  if (node === null) {
    throw new Error("Node is required for the npm artifact check");
  }
  return node;
}

async function stageTools(source: string, target: string) {
  const extension = process.platform === "win32" ? ".exe" : "";
  for (const name of ["pitchfork", "websitino"]) {
    const destination = join(target, `${name}${extension}`);
    await copyFile(join(source, `${name}${extension}`), destination);
    if (process.platform !== "win32") {
      await chmod(destination, 0o700);
    }
  }
}

function build(distribution: string) {
  const result = Bun.spawnSync(
    ["bun", "run", distribution === "npm" ? "build:npm" : "build"],
    { cwd: repo, stdout: "pipe", stderr: "pipe" }
  );
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return distribution === "npm"
    ? join(repo, "packages/cli/dist/servers", pkg.version)
    : join(repo, "servers", pkg.version);
}

/**
 * This check, not the probe, owns the directory a probe run uses, so it can
 * tear the supervisor down even when the probe never reaches its own teardown.
 */
async function probeWorkspace() {
  return await mkdtemp(
    join(
      process.platform === "win32"
        ? dirname(await windowsServersDirectory())
        : tmpdir(),
      "devver-static-probe-"
    )
  );
}

async function teardown(toolsDirectory: string, root: string) {
  try {
    await stopDeploymentHost({
      toolsDirectory,
      instanceDirectory: join(root, PROBE_INSTANCE),
    });
  } catch {
    // A probe that failed before starting has no instance state to address.
  }
}

async function serves(port: number) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(1000),
    });
    await response.body?.cancel();
    return true;
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

test("npm and standalone artifacts serve loopback-only static deployments without runtime downloads", async () => {
  if (skipped()) {
    return;
  }
  const node = requireNode();
  for (const distribution of ["npm", "standalone"]) {
    const directory = build(distribution);
    const temp = await mkdtemp(join(tmpdir(), "devver-artifact-probe-"));
    try {
      const command = await probeCommand(distribution, temp, node);
      await stageTools(directory, temp);
      const root = await probeWorkspace();
      try {
        const child = Bun.spawnSync([...command, directory, root], {
          cwd: temp,
          env: { ...process.env, PATH: NO_RUNTIME_PATH },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 120_000,
        });
        expect(child.exitCode, child.stderr.toString()).toBe(0);
      } finally {
        await teardown(directory, root);
        await rm(root, { recursive: true, force: true });
      }
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
}, 300_000);

test("broken packaged Pitchfork or Websitino cannot leave a reachable deployment", async () => {
  if (skipped()) {
    return;
  }
  const node = requireNode();
  for (const distribution of ["npm", "standalone"]) {
    const packaged = build(distribution);
    const temp = await mkdtemp(join(tmpdir(), "devver-broken-tools-"));
    try {
      const command = await probeCommand(
        distribution,
        temp,
        node,
        "static-start-failure-probe.ts"
      );
      for (const broken of ["pitchfork", "websitino"]) {
        const root = await probeWorkspace();
        const tools = join(root, "tools");
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
          await stageTools(tools, temp);
          const child = Bun.spawnSync([...command, tools, root], {
            cwd: temp,
            env: { ...process.env, PATH: NO_RUNTIME_PATH },
            stdout: "pipe",
            stderr: "pipe",
            timeout: 120_000,
          });
          expect(child.exitCode, child.stderr.toString()).toBe(0);
        } finally {
          await teardown(tools, root);
          await rm(root, { recursive: true, force: true });
        }
      }
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
}, 300_000);

test("a killed static deployment check still tears down the supervisor it started", async () => {
  if (skipped()) {
    return;
  }
  const node = requireNode();
  const directory = build("npm");
  const temp = await mkdtemp(join(tmpdir(), "devver-artifact-probe-"));
  const root = await probeWorkspace();
  try {
    const command = await probeCommand("npm", temp, node);
    await stageTools(directory, temp);
    const child = Bun.spawn([...command, directory, root], {
      cwd: temp,
      env: { ...process.env, PATH: NO_RUNTIME_PATH },
      stdout: "pipe",
      stderr: "pipe",
    });
    let port = 0;
    try {
      const deadline = Date.now() + 120_000;
      const reader = child.stdout.getReader();
      let seen = "";
      try {
        while (Date.now() < deadline && port === 0) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          seen += new TextDecoder().decode(value);
          port = Number(PROXY_PORT.exec(seen)?.groups?.port ?? 0);
        }
      } finally {
        reader.releaseLock();
      }
      expect(port).toBeGreaterThan(0);
      while (Date.now() < deadline && !(await serves(port))) {
        await Bun.sleep(200);
      }
      expect(await serves(port)).toBe(true);
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
    // Pitchfork supervises the deployment, so killing its starter leaves it
    // running: only this check's own teardown can remove it.
    expect(await serves(port)).toBe(true);
    await teardown(directory, root);
    expect(await serves(port)).toBe(false);
  } finally {
    await teardown(directory, root);
    await rm(root, { recursive: true, force: true });
    await rm(temp, { recursive: true, force: true });
  }
}, 300_000);
