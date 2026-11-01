import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { basename, join } from "node:path";

import { Effect } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import { execute } from "./exec";
import { isAlreadyExists } from "./fs-errors";
import { verifyWindowsPrivate } from "./windows-acl";

const EXECUTABLE = process.platform === "win32" ? ".exe" : "";
const PRIVATE_DIRECTORY = 0o700;
const PRIVATE_FILE = 0o600;
const PORT_ATTEMPTS = 10;
const PROXY_ATTEMPTS = 5;
const PROXY_DEADLINE = 10_000;
const PROXY_INTERVAL = 200;
const PROXY_TIMEOUT = 1000;
const DEPLOYMENT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const UNSAFE_IN_ARGUMENT = /["'`$\r\n]/u;

export interface DaemonSpec {
  readonly command: readonly string[];
  readonly dir: string;
  readonly port: number;
}

export interface DaemonSlot {
  readonly port: number;
  readonly directory: string;
}

async function invokeTool(
  binary: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv
) {
  try {
    await execute(binary, args, {
      cwd,
      env,
      timeout: 20_000,
      windowsHide: true,
    });
  } catch {
    throw new Error("Packaged tool command failed");
  }
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
    throw new Error("Deployment state must be a directory owned by this user");
  }
  // Pitchfork changes this directory to 0755 while running.
  await chmod(directory, PRIVATE_DIRECTORY);
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.mode % 0o1000 !== PRIVATE_DIRECTORY) {
    throw new Error("Deployment state must be owner-only");
  }
}

async function stateDirectories(instanceDirectory: string) {
  // Unix socket paths have a ~104-byte limit.
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

function tomlLiteral(value: string) {
  if (UNSAFE_IN_ARGUMENT.test(value)) {
    throw new Error(
      "A deployment path cannot contain quotes, expansions or newlines"
    );
  }
  return value;
}

function shellArgument(argument: string) {
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

// Pitchfork reports its configured port even if another process bound it.
const proxyAnswers = (port: number) =>
  Effect.gen(function* () {
    const client = HttpClient.withScope(yield* HttpClient.HttpClient);
    const deadline = Date.now() + PROXY_DEADLINE;
    while (Date.now() < deadline) {
      const answered = yield* client
        .execute(HttpClientRequest.get(`http://127.0.0.1:${port}/`))
        .pipe(
          Effect.flatMap((response) =>
            response.status === 404 || response.status === 502
              ? response.text.pipe(
                  Effect.map(
                    (body) =>
                      body.includes("No route for <code>127.0.0.1</code>") ||
                      body.includes("No daemon found for host '127.0.0.1'")
                  )
                )
              : Effect.succeed(false)
          ),
          Effect.timeout(PROXY_TIMEOUT),
          Effect.provideService(FetchHttpClient.RequestInit, {
            redirect: "manual",
          }),
          Effect.scoped,
          Effect.orElseSucceed(() => false)
        );
      if (answered) {
        return true;
      }
      yield* Effect.sleep(PROXY_INTERVAL);
    }
    return false;
  }).pipe(
    // @effect-diagnostics-next-line strictEffectProvide:off -- The Promise host opens this HTTP client at its Effect entry point.
    Effect.provide(FetchHttpClient.layer)
  );

// Pitchfork limits project labels to 63 characters.
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
  const slots = join(instanceDirectory, "daemons");
  const daemons = new Map<string, DaemonSpec>();
  const reserved = new Map<string, number>();
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
    // Pitchfork rejects instance hostnames when its `dir` is a separate worktree.
    const entries = [...daemons].map(([deploymentId, spec]) => {
      const directory = shellArgument(spec.dir);
      const changeDirectory = process.platform === "win32" ? "cd /d" : "cd";
      const command = spec.command
        .map((argument) => shellArgument(argument))
        .join(" ");
      return `[daemons."${deploymentId}"]
run = '${changeDirectory} ${directory} && ${command}'
dir = '${tomlLiteral(instanceDirectory)}'
port = { expect = [${spec.port}], bump = false }
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
    // Auto-start loses the state directory; a forced start can race shutdown.
    const started = await run(["supervisor", "start", "--force"])
      .then(() => true)
      .catch(() => false);
    if (started && (await Effect.runPromise(proxyAnswers(candidate)))) {
      proxyPort = candidate;
      break;
    }
    await run(["supervisor", "stop"]).catch(() => undefined);
  }
  if (proxyPort === 0) {
    throw new Error("The packaged proxy did not answer on a loopback port");
  }
  manifestProxyPort = proxyPort;
  // Pitchfork does not discover generated manifests without registration.
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
    // Reserve ports until withdrawal; probes can reuse ports before daemons bind.
    reserve: async (deploymentId: string): Promise<DaemonSlot> => {
      const id = safeDeploymentId(deploymentId);
      const taken = new Set([
        proxyPort,
        ...reserved.values(),
        ...[...daemons.values()].map((spec) => spec.port),
      ]);
      let port = 0;
      for (
        let attempt = 0;
        attempt < PORT_ATTEMPTS && port === 0;
        attempt += 1
      ) {
        const candidate = await allocatePort();
        if (!taken.has(candidate)) {
          port = candidate;
        }
      }
      if (port === 0) {
        throw new Error(
          "No free loopback port was available for the deployment"
        );
      }
      const directory = join(slots, id);
      await privateDirectory(slots);
      await privateDirectory(directory);
      reserved.set(id, port);
      return { port, directory };
    },
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
    withdraw: async (deploymentId: string) => {
      const id = safeDeploymentId(deploymentId);
      daemons.delete(id);
      reserved.delete(id);
      await run(["stop", deploymentId]).catch(() => undefined);
      await run(["clean", "--daemon", deploymentId]).catch(() => undefined);
      await rm(join(slots, id), { force: true, recursive: true }).catch(
        () => undefined
      );
      await writeManifest().catch(() => undefined);
    },
    close: async () => {
      for (const deploymentId of new Set([
        ...daemons.keys(),
        ...reserved.keys(),
      ])) {
        await run(["stop", deploymentId]).catch(() => undefined);
        await rm(join(slots, deploymentId), {
          force: true,
          recursive: true,
        }).catch(() => undefined);
      }
      daemons.clear();
      reserved.clear();
      await run(["supervisor", "stop"]).catch(() => undefined);
      await writeManifest().catch(() => undefined);
    },
  };
}

export type DeploymentHost = Awaited<ReturnType<typeof openDeploymentHost>>;
