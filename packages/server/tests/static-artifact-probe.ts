import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";

import { openDeploymentHost, portPlaceholder } from "../index";
import { locateWebsitino } from "../src/packaged-tools";

// Every request is bounded so the probe cannot outlive its supervising check,
// which owns the directory below and tears the managed processes down itself.
const DEADLINE = 5000;
const FIRST = "11111111-1111-4111-8111-111111111111";
const SECOND = "22222222-2222-4222-8222-222222222222";
const UNKNOWN = "33333333-3333-4333-8333-333333333333";
const [toolsDirectory, root] = process.argv.slice(2);

if (
  toolsDirectory === undefined ||
  toolsDirectory === "" ||
  root === undefined ||
  root === ""
) {
  throw new Error("Missing packaged tools directory or probe root");
}

async function request(url: string, timeout = DEADLINE) {
  const response = await fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(timeout),
  });
  return { status: response.status, body: await response.text() };
}

async function unreachable(url: string, timeout = 1000) {
  try {
    await request(url, timeout);
    return false;
  } catch {
    return true;
  }
}

const instanceDirectory = join(root, "instance");
// The host requires the instance directory itself to be owner-only; create it
// before any site below it, which would otherwise create it world-readable.
await mkdir(instanceDirectory, { recursive: true, mode: 0o700 });
for (const deploymentId of [FIRST, SECOND]) {
  const site = join(instanceDirectory, "sites", deploymentId);
  await mkdir(site, { recursive: true });
  await writeFile(join(site, "index.html"), `<h1>${deploymentId}</h1>`);
  await writeFile(join(site, ".private"), "do not serve");
  await mkdir(join(site, "listing"), { recursive: true });
  await writeFile(join(site, "listing", "file.txt"), "not listed");
}

const websitino = await locateWebsitino();
const command = (dir: string) => [
  websitino,
  dir,
  "--bind",
  "127.0.0.1",
  "--port",
  portPlaceholder,
  "--index",
];
function isTcpAddress(
  address: string | AddressInfo | null
): address is AddressInfo {
  return address !== null && typeof address !== "string";
}

const foreign = createServer((_request, response) => {
  response.end("foreign listener");
});
await new Promise<void>((resolve) => {
  foreign.listen(0, "127.0.0.1", resolve);
});
const foreignAddress = foreign.address();
if (!isTcpAddress(foreignAddress)) {
  throw new Error("Could not bind a foreign loopback listener");
}
const occupiedPort: number = foreignAddress.port;
let host;
try {
  host = await openDeploymentHost({
    toolsDirectory,
    instanceDirectory,
    proxyPort: occupiedPort,
  });
  if (host.proxyPort === occupiedPort) {
    throw new Error("The proxy accepted a port held by another listener");
  }
  if (
    (await request(`http://127.0.0.1:${occupiedPort}/`)).body !==
    "foreign listener"
  ) {
    throw new Error("The proxy replaced the foreign listener");
  }
} finally {
  await new Promise<void>((resolve, reject) => {
    foreign.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}
// The supervising check owns teardown, so it needs the port this run chose.
console.log(`proxyPort=${host.proxyPort}`);
try {
  await host.publish(FIRST, {
    command: command(join(instanceDirectory, "sites", FIRST)),
    dir: join(instanceDirectory, "sites", FIRST),
  });
  const served = await request(host.url(FIRST));
  if (served.status !== 200 || served.body !== `<h1>${FIRST}</h1>`) {
    throw new Error("Packaged site did not serve its index");
  }
  if ((await request(`${host.url(FIRST)}.private`)).status === 200) {
    throw new Error("Hidden file was served");
  }
  if ((await request(`${host.url(FIRST)}listing/`)).status === 200) {
    throw new Error("Directory listing was served");
  }
  // A hostname with no published deployment reaches nothing.
  const unknown = await request(host.url(UNKNOWN));
  if (unknown.status >= 200 && unknown.status < 400) {
    throw new Error("An unpublished deployment hostname was routed");
  }

  // A second deployment is served beside the first, on the same proxy port.
  await host.publish(SECOND, {
    command: command(join(instanceDirectory, "sites", SECOND)),
    dir: join(instanceDirectory, "sites", SECOND),
  });
  if ((await request(host.url(SECOND))).body !== `<h1>${SECOND}</h1>`) {
    throw new Error("Second deployment did not serve its own revision");
  }
  if ((await request(host.url(FIRST))).body !== `<h1>${FIRST}</h1>`) {
    throw new Error("Publishing a second deployment changed the first");
  }
  if (new URL(host.url(FIRST)).port !== new URL(host.url(SECOND)).port) {
    throw new Error("Deployments were published on different ports");
  }
  if (
    new URL(host.url(FIRST)).hostname === new URL(host.url(SECOND)).hostname
  ) {
    throw new Error("Deployments share a hostname");
  }
  if (new URL(host.url(FIRST)).hostname !== `${FIRST}.instance.localhost`) {
    throw new Error(
      "Deployment hostname does not match Pitchfork's project name"
    );
  }

  const external = Object.values(networkInterfaces())
    .flat()
    .find(
      (interfaceAddress) =>
        interfaceAddress?.family === "IPv4" && !interfaceAddress.internal
    )?.address;
  if (external === undefined) {
    throw new Error(
      "No non-loopback IPv4 interface available for binding proof"
    );
  }
  if (!(await unreachable(`http://${external}:${host.proxyPort}/`))) {
    throw new Error("Non-loopback interface accepted a connection");
  }

  // Withdrawing one deployment leaves its sibling serving.
  await host.withdraw(FIRST);
  if ((await request(host.url(FIRST))).status === 200) {
    throw new Error("A withdrawn deployment is still routed");
  }
  if ((await request(host.url(SECOND))).status !== 200) {
    throw new Error("Withdrawing one deployment stopped another");
  }
} finally {
  await host.close();
}

if (!(await unreachable(`http://127.0.0.1:${host.proxyPort}/`))) {
  throw new Error("The proxy remained reachable after close");
}

// Reopening the same instance adopts the state the closed host left behind.
const restarted = await openDeploymentHost({
  toolsDirectory,
  instanceDirectory,
});
try {
  await restarted.publish(FIRST, {
    command: command(join(instanceDirectory, "sites", FIRST)),
    dir: join(instanceDirectory, "sites", FIRST),
  });
  if ((await request(restarted.url(FIRST))).status !== 200) {
    throw new Error("Restarted instance did not serve its index");
  }
} finally {
  await restarted.close();
}
