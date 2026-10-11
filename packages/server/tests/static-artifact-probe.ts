import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { startStaticSite } from "../index";
import { windowsServersDirectory } from "../windows-acl";

const toolsDirectory = process.argv.at(2);

function isInetAddress(
  address: string | AddressInfo | null
): address is AddressInfo {
  return address !== null && typeof address !== "string";
}
if (toolsDirectory === undefined || toolsDirectory === "") {
  throw new Error("Missing packaged tools directory");
}
async function availablePort() {
  const listener = createServer();
  await new Promise<void>((resolve) => {
    listener.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = listener.address();
    if (!isInetAddress(address)) {
      throw new Error("No allocated port");
    }
    return address.port;
  } finally {
    await new Promise<void>((resolve, reject) => {
      listener.close((error) => {
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      });
    });
  }
}

const root = await mkdtemp(
  join(
    process.platform === "win32"
      ? dirname(await windowsServersDirectory())
      : tmpdir(),
    "devver-static-artifact-"
  )
);
try {
  const site = join(root, "site");
  await mkdir(site);
  await writeFile(join(site, "index.html"), "<h1>packaged static site</h1>");
  await writeFile(join(site, ".private"), "do not serve");
  await mkdir(join(site, "listing"));
  await writeFile(join(site, "listing", "file.txt"), "not listed");
  const port = await availablePort();
  const running = await startStaticSite({
    toolsDirectory,
    instanceDirectory: join(root, "instance"),
    siteDirectory: site,
    port,
  });
  try {
    const url = `http://127.0.0.1:${port}`;
    const response = await fetch(url);
    if (
      response.status !== 200 ||
      (await response.text()) !== "<h1>packaged static site</h1>"
    ) {
      throw new Error("Packaged site did not serve its index");
    }
    const hidden = await fetch(`${url}/.private`);
    if (hidden.status === 200) {
      throw new Error("Hidden file was served");
    }
    const listing = await fetch(`${url}/listing/`);
    if (listing.status === 200) {
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
      await fetch(`http://${host}:${port}/`, {
        signal: AbortSignal.timeout(1000),
      });
      throw new Error("Non-loopback interface accepted a connection");
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "Non-loopback interface accepted a connection"
      ) {
        throw error;
      }
    }
    const secondPort = await availablePort();
    const second = await startStaticSite({
      toolsDirectory,
      instanceDirectory: join(root, "another-instance"),
      siteDirectory: site,
      port: secondPort,
    });
    try {
      if ((await fetch(`http://127.0.0.1:${secondPort}/`)).status !== 200) {
        throw new Error("Second instance did not serve");
      }
    } finally {
      await second.stop();
    }
    if ((await fetch(url)).status !== 200) {
      throw new Error("Stopping another instance stopped this site");
    }
  } finally {
    await running.stop();
  }
  try {
    await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(1000),
    });
    throw new Error("Site remained reachable after stop");
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Site remained reachable after stop"
    ) {
      throw error;
    }
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
