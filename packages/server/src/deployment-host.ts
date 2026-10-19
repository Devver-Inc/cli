import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { isAlreadyExists } from "./fs-errors";
import { verifyWindowsPrivate } from "./windows-acl";

const EXECUTABLE = process.platform === "win32" ? ".exe" : "";
const PRIVATE_DIRECTORY = 0o700;
const PRIVATE_FILE = 0o600;
/** Every daemon asks for the same port; Pitchfork bumps until one is free. */
const PORT_BASE = 52_000;
const PROXY_ATTEMPTS = 5;
const PROXY_DEADLINE = 10_000;
const PROXY_INTERVAL = 200;
const PROXY_TIMEOUT = 1000;
const DEPLOYMENT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
// Arguments are double-quoted inside a TOML literal string, so a quote of
// either kind would end the string or the argument. Expansion characters would
// let a path reach the shell as code.
const UNSAFE_IN_ARGUMENT = /["'`$\r\n]/u;

/**
 * The resolved port Pitchfork assigned, as the platform shell spells it.
 * A command that listens on a port puts this in its own arguments.
 */
export const portPlaceholder =
  process.platform === "win32" ? "%PORT%" : "$PORT";

/**
 * What the host needs to run one deployment. It never interprets this: the
 * command is an argv, not a shell string, and the directory is where the
 * process runs. Pitchfork's daemon `dir` remains the instance project so its
 * automatic hostname belongs to that project; the generated run line changes
 * to the workload directory before executing the command.
 */
export interface DaemonSpec {
  readonly command: readonly string[];
  readonly dir: string;
}

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
  try {
    await mkdir(directory, { mode: PRIVATE_DIRECTORY });
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
  await chmod(directory, PRIVATE_DIRECTORY);
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.mode % 0o1000 !== PRIVATE_DIRECTORY) {
    throw new Error("Pitchfork state must be owner-only");
  }
}

async function stateDirectories(instanceDirectory: string) {
  // Unix sockets have a ~104-byte path limit; long XDG instance paths need a
  // short private state root.
  const key = createHash("sha256")
    .update(await realpath(instanceDirectory))
    .digest("hex")
    .slice(0, 24);
  return {
    state:
      process.platform === "win32"
        ? join(instanceDirectory, "pitchfork-state")
        : `/tmp/devver-pf-${key}`,
    config: join(instanceDirectory, "pitchfork-config"),
  };
}

function safeDeploymentId(deploymentId: string) {
  if (!DEPLOYMENT_ID.test(deploymentId)) {
    throw new Error("A deployment name must be a UUID");
  }
  return deploymentId;
}

/**
 * One value in a TOML literal string. The manifest is read by Pitchfork, not
 * by a shell, so this quotes for TOML only: a quote or newline would end the
 * string, and nothing here is ever expanded.
 */
function tomlLiteral(value: string) {
  if (UNSAFE_IN_ARGUMENT.test(value)) {
    throw new Error(
      "A deployment path cannot contain quotes, expansions or newlines"
    );
  }
  return value;
}

/**
 * One argument, as the shell should see it. The port placeholder is the only
 * thing left unquoted, because the shell has to expand it.
 */
function shellArgument(argument: string) {
  if (argument === portPlaceholder) {
    return argument;
  }
  if (
    UNSAFE_IN_ARGUMENT.test(argument) ||
    (process.platform === "win32"
      ? /[%!^&|<>]/u.test(argument)
      : argument.includes("\\"))
  ) {
    throw new Error(
      "A deployment command cannot contain quotes, expansions or newlines"
    );
  }
  return `"${argument}"`;
}

function proxySettings(port: number) {
  return `[settings.proxy]
enable = true
https = false
port = ${port}
auto_trust = false
sync_hosts = false
dns = false
tld = "localhost"
host = "127.0.0.1"
`;
}

/** node:net reports a pipe server as a string address; a TCP listener never is. */
function isTcpAddress(
  address: string | AddressInfo | null
): address is AddressInfo {
  return address !== null && typeof address !== "string";
}

async function allocatePort() {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  try {
    if (!isTcpAddress(address)) {
      throw new Error("Could not allocate a loopback port");
    }
    return address.port;
  } finally {
    await new Promise<void>((resolve) => {
      probe.close(() => {
        resolve();
      });
    });
  }
}

/**
 * The proxy answers for this instance.
 *
 * Pitchfork reports its configured port whether or not it bound it, so the
 * only proof is a real request. Ask for a missing route and verify
 * Pitchfork's response, rather than accepting another listener
 * that won the port between allocation and startup.
 */
async function proxyAnswers(port: number) {
  const deadline = Date.now() + PROXY_DEADLINE;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        redirect: "manual",
        signal: AbortSignal.timeout(PROXY_TIMEOUT),
      });
      if (response.status === 404 || response.status === 502) {
        const body = await response.text();
        if (
          body.includes("No route for <code>127.0.0.1</code>") ||
          body.includes("No daemon found for host '127.0.0.1'")
        ) {
          return true;
        }
      } else {
        await response.body?.cancel();
      }
    } catch {
      await delay(PROXY_INTERVAL);
      continue;
    }
    await delay(PROXY_INTERVAL);
  }
  return false;
}

// Instance names are ASCII alphanumeric, '_' or '-'. Pitchfork lowercases,
// collapses separators and limits project labels to 63 characters.
function projectLabel(instanceDirectory: string) {
  return basename(instanceDirectory)
    .toLowerCase()
    .replaceAll(/[_-]+/gu, "-")
    .replace(/-$/u, "")
    .slice(0, 63)
    .replace(/-$/u, "");
}

function toolInvoker(toolsDirectory: string, instanceDirectory: string) {
  const pitchfork = join(toolsDirectory, `pitchfork${EXECUTABLE}`);
  return async (state: string, config: string, args: string[]) => {
    await invokeTool(pitchfork, args, instanceDirectory, {
      ...process.env,
      PITCHFORK_STATE_DIR: state,
      PITCHFORK_CONFIG_DIR: config,
    });
  };
}

export async function stopDeploymentHost(options: {
  readonly toolsDirectory: string;
  readonly instanceDirectory: string;
}) {
  const { state, config } = await stateDirectories(options.instanceDirectory);
  const invoke = toolInvoker(options.toolsDirectory, options.instanceDirectory);
  await invoke(state, config, ["supervisor", "stop"]).catch(() => undefined);
}

export async function openDeploymentHost(options: {
  readonly toolsDirectory: string;
  readonly instanceDirectory: string;
  readonly proxyPort?: number | undefined;
}) {
  const { toolsDirectory, instanceDirectory } = options;
  const pitchfork = join(toolsDirectory, `pitchfork${EXECUTABLE}`);
  if (!(await lstat(pitchfork)).isFile()) {
    throw new Error("Packaged supervisor is not a regular file");
  }
  await mkdir(instanceDirectory, { recursive: true, mode: PRIVATE_DIRECTORY });
  if (process.platform === "win32") {
    await verifyWindowsPrivate({ path: instanceDirectory, kind: "directory" });
  } else {
    const stat = await lstat(instanceDirectory);
    if (
      !stat.isDirectory() ||
      stat.uid !== process.getuid?.() ||
      stat.mode % 0o1000 !== PRIVATE_DIRECTORY
    ) {
      throw new Error("Deployment instance directory must be owner-only");
    }
  }
  const { state, config } = await stateDirectories(instanceDirectory);
  await privateDirectory(state);
  await privateDirectory(config);
  const manifest = join(instanceDirectory, "pitchfork.toml");
  const daemons = new Map<string, DaemonSpec>();
  const invoke = toolInvoker(toolsDirectory, instanceDirectory);
  const run = async (args: string[]) => {
    await invoke(state, config, args);
  };
  let writtenProxyPort = 0;
  let manifestProxyPort = 0;
  const writeProxySettings = async (proxyPort: number) => {
    if (writtenProxyPort === proxyPort) {
      return;
    }
    await writeFile(join(config, "config.toml"), proxySettings(proxyPort), {
      mode: PRIVATE_FILE,
    });
    writtenProxyPort = proxyPort;
  };
  const writeManifest = async (proxyPort = manifestProxyPort) => {
    // A daemon whose Pitchfork `dir` points at a bare-repository worktree is
    // treated as a different checkout, so its instance hostname is refused.
    // Keep Pitchfork's project at the instance and enter the workload's cwd in
    // the shell; the host does this for any workload, not just static sites.
    const entries = [...daemons].map(([deploymentId, spec]) => {
      const directory = shellArgument(spec.dir);
      const changeDirectory = process.platform === "win32" ? "cd /d" : "cd";
      const command = spec.command
        .map((argument) => shellArgument(argument))
        .join(" ");
      return `[daemons."${deploymentId}"]
run = '${changeDirectory} ${directory} && ${command}'
dir = '${tomlLiteral(instanceDirectory)}'
port = { expect = [${PORT_BASE}], bump = true }
`;
    });
    if (proxyPort !== 0) {
      await writeProxySettings(proxyPort);
    }
    const settings = proxyPort === 0 ? "" : proxySettings(proxyPort);
    const staged = `${manifest}.staging`;
    await writeFile(staged, `${settings}\n${entries.join("\n")}`, {
      mode: PRIVATE_FILE,
    });
    await rename(staged, manifest);
  };
  await writeManifest();

  let proxyPort = 0;
  for (let attempt = 0; attempt < PROXY_ATTEMPTS; attempt += 1) {
    const candidate =
      attempt === 0 && options.proxyPort !== undefined
        ? options.proxyPort
        : await allocatePort();
    await writeManifest(candidate);
    // Explicitly, never by auto-start: a supervisor started on another
    // command's behalf does not keep the state directory it was launched with.
    // A start can lose a race with its own forced predecessor's shutdown, so a
    // failed attempt is this loop's reason to try the next port, not fatal.
    const started = await run(["supervisor", "start", "--force"])
      .then(() => true)
      .catch(() => false);
    if (started && (await proxyAnswers(candidate))) {
      proxyPort = candidate;
      break;
    }
    await run(["supervisor", "stop"]).catch(() => undefined);
  }
  if (proxyPort === 0) {
    throw new Error("The packaged proxy did not answer on a loopback port");
  }
  manifestProxyPort = proxyPort;
  // A generated manifest is not automatically a known proxy project. Register
  // this instance in its isolated config so Pitchfork discovers its native
  // <daemon>.<project>.localhost names (without global machine changes).
  try {
    await run(["config", "add", manifest, "--dir", instanceDirectory]);
  } catch {
    await run(["supervisor", "stop"]).catch(() => undefined);
    throw new Error("The deployment project could not be registered");
  }
  const label = projectLabel(instanceDirectory);

  return {
    proxyPort,
    url: (deploymentId: string) =>
      `http://${safeDeploymentId(deploymentId)}.${label}.localhost:${proxyPort}/`,
    publish: async (deploymentId: string, spec: DaemonSpec) => {
      daemons.set(safeDeploymentId(deploymentId), spec);
      await writeManifest();
      try {
        await run(["start", deploymentId]);
      } catch {
        daemons.delete(deploymentId);
        await writeManifest().catch(() => undefined);
        throw new Error("The deployment process failed to start");
      }
    },
    /**
     * Stop one deployment. Tolerant by contract, because it also has to clean
     * up after a daemon an earlier run left behind.
     */
    withdraw: async (deploymentId: string) => {
      daemons.delete(safeDeploymentId(deploymentId));
      await run(["stop", deploymentId]).catch(() => undefined);
      await run(["clean", "--daemon", deploymentId]).catch(() => undefined);
      await writeManifest().catch(() => undefined);
    },
    close: async () => {
      for (const deploymentId of daemons.keys()) {
        await run(["stop", deploymentId]).catch(() => undefined);
      }
      daemons.clear();
      await run(["supervisor", "stop"]).catch(() => undefined);
      await writeManifest().catch(() => undefined);
    },
  };
}

export type DeploymentHost = Awaited<ReturnType<typeof openDeploymentHost>>;
