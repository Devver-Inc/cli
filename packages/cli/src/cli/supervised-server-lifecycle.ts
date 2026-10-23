import { rm } from "node:fs/promises";
import { join } from "node:path";

import { instanceParent, readInstanceService } from "../../../server/identity";
import { execute } from "../util/exec";

async function stopDarwin(name: string) {
  const service = await readInstanceService(name);
  if (!("label" in service)) {
    throw new Error(
      `Instance '${name}' has no launchd label; it was created on another platform.`
    );
  }
  const { label } = service;
  const domain = `gui/${process.getuid?.()}`;
  await execute("launchctl", ["bootout", `${domain}/${label}`], {
    timeout: 5000,
    maxBuffer: 8192,
  });
  // bootout is asynchronous: PASS only when the job is really gone.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      await execute("launchctl", ["print", `${domain}/${label}`], {
        timeout: 2000,
        maxBuffer: 1024 * 1024,
      });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 150);
      });
    } catch {
      return;
    }
  }
  throw new Error(
    `Launchd job ${label} remains registered; run 'launchctl bootout ${domain}/${label}' by hand.`
  );
}

async function stopLinux(name: string) {
  const service = await readInstanceService(name);
  if (!("unit" in service)) {
    throw new Error(
      `Instance '${name}' has no systemd unit; it was created on another platform.`
    );
  }
  const { unit } = service;
  await execute("systemctl", ["--user", "stop", unit], {
    timeout: 5000,
    maxBuffer: 8192,
  });
  const state = await execute(
    "systemctl",
    ["--user", "show", "--property=LoadState", "--value", unit],
    { timeout: 5000, maxBuffer: 8192 }
  );
  if (state.stdout.trim() !== "not-found") {
    throw new Error(`Unit ${unit} remains loaded; stop it by hand.`);
  }
}

export async function stopInstance(name: string) {
  if (process.platform === "darwin") {
    await stopDarwin(name);
    return;
  }
  if (process.platform === "linux") {
    await stopLinux(name);
    return;
  }
  throw new Error(
    `Stopping a supervised server is currently unsupported on ${process.platform}`
  );
}

export async function removeInstance(name: string) {
  await stopInstance(name);
  const directory = join(await instanceParent(name), name);
  await rm(directory, { recursive: true });
  // A removed instance must not answer its identity anymore.
  const service = await readInstanceService(name).catch(() => undefined);
  if (service !== undefined) {
    throw new Error(
      `Instance '${name}' state remains after removal; remove ${directory} by hand.`
    );
  }
}
