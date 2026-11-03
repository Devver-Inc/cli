import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { Effect } from "effect";

import { execute } from "./exec";
import { allocatePort } from "./pitchfork/loopback-port";
import type { DaemonSpec } from "./pitchfork/manifest";
import {
  manifestText,
  projectLabel,
  proxySettings,
  safeDeploymentId,
} from "./pitchfork/manifest";
import { proxyAnswers } from "./pitchfork/proxy-probe";
import { restorePrivateDirectory } from "./private-state";
import { verifyWindowsPrivate } from "./windows-acl";

const EXECUTABLE = process.platform === "win32" ? ".exe" : "";
const PRIVATE_DIRECTORY = 0o700;
const PRIVATE_FILE = 0o600;
const PORT_ATTEMPTS = 10;
const PROXY_ATTEMPTS = 5;

export type { DaemonSpec } from "./pitchfork/manifest";

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
  await restorePrivateDirectory(state);
  await restorePrivateDirectory(config);
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
    const text = manifestText({ daemons, instanceDirectory, proxyPort });
    if (proxyPort !== 0) {
      await writeProxySettings(proxyPort);
    }
    const staged = `${manifest}.staging`;
    await writeFile(staged, text, { mode: PRIVATE_FILE });
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
      await restorePrivateDirectory(slots);
      await restorePrivateDirectory(directory);
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
