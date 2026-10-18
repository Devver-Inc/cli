import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { startStaticSite } from "../index";

const [toolsDirectory, root, portText] = process.argv.slice(2);
const port = Number(portText);
if (
  toolsDirectory === undefined ||
  root === undefined ||
  !Number.isInteger(port) ||
  port < 1 ||
  port > 65_535
) {
  throw new Error("Expected tools directory, scratch root, and loopback port");
}
const site = join(root, "broken-site");
await mkdir(site);
await writeFile(join(site, "index.html"), "<h1>must not serve</h1>");
let running;
try {
  running = await startStaticSite({
    toolsDirectory,
    instanceDirectory: join(root, "instance"),
    siteDirectory: site,
    port,
  });
} catch (error) {
  if (
    !(
      error instanceof Error &&
      error.message === "Packaged static site failed to start"
    )
  ) {
    throw error;
  }
}
try {
  let connected = false;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(1000),
    });
    await response.body?.cancel();
    connected = true;
  } catch {
    // A broken packaged tool has no listener to answer.
  }
  if (connected) {
    throw new Error("A broken packaged tool still answered HTTP");
  }
} finally {
  await running?.stop();
}
