import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { instanceParent, loadInstance } from "@devver/server/identity";
import pkg from "../../../../package.json" with { type: "json" };
import { verifyIdentity } from "./local-server";
import { availablePort } from "./loopback";
import { pinServer } from "./supervised-server-posix";

const execute = promisify(execFile);
const DIRECTORY_MODE = 0o700;

function existing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

async function manager(...args: string[]) {
  const result = await execute(args[0] ?? "systemctl", args.slice(1), {
    timeout: 5000,
    maxBuffer: 8192,
  });
  return result.stdout.trim();
}

async function removeFailedInstance(unit: string, directory: string) {
  try {
    await manager("systemctl", "--user", "stop", unit);
  } catch (stopError) {
    // A failed registration may never have installed its unique transient unit.
    const state = await manager(
      "systemctl",
      "--user",
      "show",
      "--property=LoadState",
      "--value",
      unit
    );
    if (state !== "not-found") {
      throw stopError;
    }
  }
  await rm(directory, { recursive: true });
}

export async function create(name: string) {
  const parent = await instanceParent(name);
  const directory = join(parent, name);
  // Exclusive creation is the duplicate-name gate: nothing belonging to that name is touched.
  try {
    await mkdir(directory, { mode: DIRECTORY_MODE });
  } catch (error) {
    if (existing(error)) {
      throw new Error(`Server instance '${name}' already exists`);
    }
    throw error;
  }
  const unit = `devver-${randomUUID()}.service`;
  let started = false;
  try {
    const instance = await loadInstance(name);
    const port = await availablePort();
    const pinned = await pinServer(parent);
    const data =
      process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
    const handle = await open(join(directory, "service.json"), "wx", 0o600);
    try {
      await handle.writeFile(
        JSON.stringify({ unit, port, serverVersion: pkg.version })
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    await manager(
      "systemd-run",
      "--user",
      `--unit=${unit}`,
      "--collect",
      "--property=Restart=on-failure",
      "--property=RestartSec=2s",
      "--property=StartLimitIntervalSec=60s",
      "--property=StartLimitBurst=3",
      `--setenv=XDG_DATA_HOME=${data}`,
      "--",
      pinned.command,
      ...pinned.args,
      name,
      String(port)
    );
    started = true;
    const url = `http://127.0.0.1:${port}/api/v1`;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        const target = await verifyIdentity(url);
        if (target.instanceId === instance.instanceId && target.name === name) {
          await manager("systemctl", "--user", "is-active", "--quiet", unit);
          return url;
        }
      } catch {
        // A starting server can refuse connections; readiness remains bounded.
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(
      "Server did not return its expected identity while supervised"
    );
  } catch (error) {
    // Even if systemd-run failed, stop the unique unit before discarding its state.
    // If stopping fails, retain service.json so the user can inspect and stop it manually.
    try {
      await removeFailedInstance(unit, directory);
    } catch {
      throw new Error(
        `Server creation failed; instance '${name}' may need recovery: run systemctl --user stop ${unit}, then remove new state at ${directory} before retrying. No readiness was reported`,
        { cause: error }
      );
    }
    throw new Error(
      started
        ? "Server failed readiness; new unit was stopped and instance state removed"
        : "Could not install Linux systemd user supervision; new instance state removed",
      { cause: error }
    );
  }
}
