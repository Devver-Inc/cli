import { mkdir, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { join } from "node:path";

import { startStaticSite } from "../index";

// Every request is bounded so the probe cannot outlive its supervising check,
// which owns the directories and ports below and tears them down itself.
const DEADLINE = 5000;
const [toolsDirectory, root, firstPort, secondPort] = process.argv.slice(2);

function port(value: string | undefined) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("Missing static site port");
  }
  return parsed;
}

async function request(url: string, timeout = DEADLINE) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  return { status: response.status, body: await response.text() };
}

if (
  toolsDirectory === undefined ||
  toolsDirectory === "" ||
  root === undefined ||
  root === ""
) {
  throw new Error("Missing packaged tools directory or probe root");
}
const port1 = port(firstPort);
const port2 = port(secondPort);
const site = join(root, "site");
await mkdir(site, { recursive: true });
await writeFile(join(site, "index.html"), "<h1>packaged static site</h1>");
await writeFile(join(site, ".private"), "do not serve");
await mkdir(join(site, "listing"), { recursive: true });
await writeFile(join(site, "listing", "file.txt"), "not listed");
const instance = join(root, "instance");
const url = `http://127.0.0.1:${port1}`;
const running = await startStaticSite({
  toolsDirectory,
  instanceDirectory: instance,
  siteDirectory: site,
  port: port1,
});
try {
  const served = await request(url);
  if (
    served.status !== 200 ||
    served.body !== "<h1>packaged static site</h1>"
  ) {
    throw new Error("Packaged site did not serve its index");
  }
  if ((await request(`${url}/.private`)).status === 200) {
    throw new Error("Hidden file was served");
  }
  if ((await request(`${url}/listing/`)).status === 200) {
    throw new Error("Directory listing was served");
  }
  const host = Object.values(networkInterfaces())
    .flat()
    .find(
      (interfaceAddress) =>
        interfaceAddress?.family === "IPv4" && !interfaceAddress.internal
    )?.address;
  if (host === undefined) {
    throw new Error(
      "No non-loopback IPv4 interface available for binding proof"
    );
  }
  try {
    await request(`http://${host}:${port1}/`, 1000);
    throw new Error("Non-loopback interface accepted a connection");
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Non-loopback interface accepted a connection"
    ) {
      throw error;
    }
  }
  const second = await startStaticSite({
    toolsDirectory,
    instanceDirectory: join(root, "another-instance"),
    siteDirectory: site,
    port: port2,
  });
  try {
    if ((await request(`http://127.0.0.1:${port2}/`)).status !== 200) {
      throw new Error("Second instance did not serve");
    }
  } finally {
    await second.stop();
  }
  if ((await request(url)).status !== 200) {
    throw new Error("Stopping another instance stopped this site");
  }
} finally {
  await running.stop();
}
try {
  await request(`${url}/`, 1000);
  throw new Error("Site remained reachable after stop");
} catch (error) {
  if (
    error instanceof Error &&
    error.message === "Site remained reachable after stop"
  ) {
    throw error;
  }
}
// The stopped instance left its Pitchfork state behind, so starting the same
// instance and port again is the restart a running server performs.
const restarted = await startStaticSite({
  toolsDirectory,
  instanceDirectory: instance,
  siteDirectory: site,
  port: port1,
});
try {
  if ((await request(url)).status !== 200) {
    throw new Error("Restarted instance did not serve its index");
  }
} finally {
  await restarted.stop();
}
