import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { release } from "node:os";
import { join } from "node:path";

import { isAlreadyExists } from "./fs-errors";
import { verifyWindowsPrivate } from "./windows-acl";

const EXECUTABLE = process.platform === "win32" ? ".exe" : "";

async function invokeTool(
  binary: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv
) {
  await new Promise<void>((resolve, reject) => {
    execFile(
      binary,
      args,
      { cwd, env, timeout: 20_000, windowsHide: true },
      (error) => {
        if (error === null) {
          resolve();
        } else {
          reject(new Error("Packaged tool command failed"));
        }
      }
    );
  });
}

/**
 * Stopping and starting the same instance and port finds the state directory
 * it already created, so an existing one is adopted instead of failing. Only a
 * real directory we own qualifies: a symlink or another user's directory on the
 * predictable path under shared /tmp is refused.
 */
async function privateDirectory(directory: string) {
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (!isAlreadyExists(error)) {
      throw error;
    }
  }
  if (process.platform === "win32") {
    await verifyWindowsPrivate({ path: directory, kind: "directory" });
    return;
  }
  const existing = await lstat(directory);
  if (!existing.isDirectory() || existing.uid !== process.getuid?.()) {
    throw new Error("Pitchfork state must be a directory owned by this user");
  }
  // Pitchfork relaxes its own state directory to 0755 while it runs, so the
  // owner-only mode is restored before the tools start again.
  await chmod(directory, 0o700);
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.mode % 0o1000 !== 0o700) {
    throw new Error("Pitchfork state must be owner-only");
  }
}

async function stateDirectories(instanceDirectory: string, port: number) {
  // Unix sockets have a ~104-byte path limit; long XDG instance paths need a short private state root.
  const key = createHash("sha256")
    .update(`${await realpath(instanceDirectory)}:${port}`)
    .digest("hex")
    .slice(0, 24);
  return {
    state:
      process.platform === "win32"
        ? join(instanceDirectory, `pitchfork-${port}-state`)
        : `/tmp/devver-pf-${key}`,
    config: join(instanceDirectory, `pitchfork-${port}-config`),
  };
}

function pitchforkInvoker(options: {
  toolsDirectory: string;
  instanceDirectory: string;
  state: string;
  config: string;
}) {
  const pitchfork = join(options.toolsDirectory, `pitchfork${EXECUTABLE}`);
  const env = {
    ...process.env,
    PITCHFORK_STATE_DIR: options.state,
    PITCHFORK_CONFIG_DIR: options.config,
  };
  return async (args: string[]) => {
    await invokeTool(pitchfork, args, options.instanceDirectory, env);
  };
}

/**
 * Teardown of an instance's static site, addressed by the same inputs that
 * started it. It is idempotent so that a supervising check can clean up after
 * the process that called `startStaticSite` died without running its own
 * teardown; whether the site is gone is proven by its reachability, not by
 * these commands, because nothing may be running at all.
 */
export async function stopStaticSite(options: {
  toolsDirectory: string;
  instanceDirectory: string;
  port: number;
}) {
  const { state, config } = await stateDirectories(
    options.instanceDirectory,
    options.port
  );
  const invoke = pitchforkInvoker({ ...options, state, config });
  for (const args of [
    ["stop", "static"],
    ["clean", "--daemon", "static"],
    ["supervisor", "stop"],
  ]) {
    await invoke(args).catch(() => undefined);
  }
}

const PORT = 65_535;

/** The tools directory is the version-pinned server installation, not PATH. */
export async function startStaticSite(options: {
  toolsDirectory: string;
  instanceDirectory: string;
  siteDirectory: string;
  port: number;
}) {
  const { toolsDirectory, instanceDirectory, siteDirectory, port } = options;
  if (!Number.isInteger(port) || port < 1 || port > PORT) {
    throw new Error("Static site port must be between 1 and 65535");
  }
  if (process.platform === "darwin") {
    const major = Math.trunc(Number(release().split(".")[0] ?? ""));
    if (!(major >= 23)) {
      throw new Error("Local static serving requires macOS 14 or newer");
    }
  }
  const websitino = join(toolsDirectory, `websitino${EXECUTABLE}`);
  for (const binary of [
    join(toolsDirectory, `pitchfork${EXECUTABLE}`),
    websitino,
  ]) {
    if (!(await lstat(binary)).isFile()) {
      throw new Error("Packaged static tool is not a regular file");
    }
  }
  await mkdir(instanceDirectory, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") {
    await verifyWindowsPrivate({ path: instanceDirectory, kind: "directory" });
  } else {
    const stat = await lstat(instanceDirectory);
    if (
      !stat.isDirectory() ||
      stat.uid !== process.getuid?.() ||
      stat.mode % 0o1000 !== 0o700
    ) {
      throw new Error("Static instance directory must be owner-only");
    }
  }
  const { state, config } = await stateDirectories(instanceDirectory, port);
  await privateDirectory(state);
  await privateDirectory(config);
  const invoke = pitchforkInvoker({
    toolsDirectory,
    instanceDirectory,
    state,
    config,
  });
  try {
    await invoke([
      "run",
      "static",
      "--port",
      String(port),
      "--retry",
      "3",
      "--",
      websitino,
      siteDirectory,
      "--bind",
      "127.0.0.1",
      "--port",
      String(port),
      "--index",
    ]);
  } catch {
    // Even a failed readiness probe can leave a managed daemon behind.
    await stopStaticSite({ toolsDirectory, instanceDirectory, port });
    throw new Error("Packaged static site failed to start");
  }
  return {
    stop: async () => {
      await stopStaticSite({ toolsDirectory, instanceDirectory, port });
    },
  };
}
