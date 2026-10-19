import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { openDeploymentHost, portPlaceholder } from "../index";
import { locateWebsitino } from "../src/packaged-tools";

const DEPLOYMENT = "44444444-4444-4444-8444-444444444444";
const [toolsDirectory, root] = process.argv.slice(2);

if (
  toolsDirectory === undefined ||
  toolsDirectory === "" ||
  root === undefined ||
  root === ""
) {
  throw new Error("Expected a packaged tools directory and a scratch root");
}

const instanceDirectory = join(root, "instance");
const site = join(instanceDirectory, "broken-site");
await mkdir(site, { recursive: true });
await writeFile(join(site, "index.html"), "<h1>must not serve</h1>");

let host;
try {
  host = await openDeploymentHost({ toolsDirectory, instanceDirectory });
} catch {
  process.exitCode = 0;
}

if (host !== undefined) {
  try {
    let published = false;
    try {
      await host.publish(DEPLOYMENT, {
        command: [
          await locateWebsitino(),
          site,
          "--bind",
          "127.0.0.1",
          "--port",
          portPlaceholder,
          "--index",
        ],
        dir: site,
      });
      published = true;
    } catch {
      published = false;
    }
    if (published) {
      const answered = await fetch(host.url(DEPLOYMENT), {
        signal: AbortSignal.timeout(1000),
      })
        .then(async (response) => {
          await response.body?.cancel();
          return response.status === 200;
        })
        .catch(() => false);
      if (answered) {
        throw new Error("A broken packaged tool still served a deployment");
      }
    }
  } finally {
    await host.close();
  }
}
