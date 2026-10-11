import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { release } from "node:os";
import { join } from "node:path";

import { verifyWindowsPrivate } from "./windows-acl";

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

async function privateDirectory(directory: string) {
  await mkdir(directory, { mode: 0o700 });
  if (process.platform === "win32") {
    await verifyWindowsPrivate({ path: directory, kind: "directory" });
  } else {
    const stat = await lstat(directory);
    if (
      !stat.isDirectory() ||
      stat.uid !== process.getuid?.() ||
      stat.mode % 0o1000 !== 0o700
    ) {
      throw new Error("Pitchfork state must be owner-only");
    }
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
  const suffix = process.platform === "win32" ? ".exe" : "";
  const pitchfork = join(toolsDirectory, `pitchfork${suffix}`);
  const websitino = join(toolsDirectory, `websitino${suffix}`);
  for (const binary of [pitchfork, websitino]) {
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
  // Unix sockets have a ~104-byte path limit; long XDG instance paths need a short private state root.
  const key = createHash("sha256")
    .update(`${await realpath(instanceDirectory)}:${port}`)
    .digest("hex")
    .slice(0, 24);
  const state =
    process.platform === "win32"
      ? join(instanceDirectory, `pitchfork-${port}-state`)
      : `/tmp/devver-pf-${key}`;
  const config = join(instanceDirectory, `pitchfork-${port}-config`);
  await privateDirectory(state);
  await privateDirectory(config);
  const env = {
    ...process.env,
    PITCHFORK_STATE_DIR: state,
    PITCHFORK_CONFIG_DIR: config,
  };
  const invoke = async (args: string[]) =>
    invokeTool(pitchfork, args, instanceDirectory, env);
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
    await invoke(["stop", "static"]).catch(() => undefined);
    await invoke(["clean", "--daemon", "static"]).catch(() => undefined);
    await invoke(["supervisor", "stop"]).catch(() => undefined);
    throw new Error("Packaged static site failed to start");
  }
  return {
    stop: async () => {
      try {
        await invoke(["stop", "static"]);
      } finally {
        try {
          await invoke(["clean", "--daemon", "static"]);
        } finally {
          await invoke(["supervisor", "stop"]);
        }
      }
    },
  };
}
