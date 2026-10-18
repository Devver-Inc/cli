import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";

import pkg from "../../../package.json" with { type: "json" };

const EXECUTABLE = process.platform === "win32" ? ".exe" : "";

async function isToolchain(directory: string) {
  for (const tool of [`pitchfork${EXECUTABLE}`, `websitino${EXECUTABLE}`]) {
    try {
      if (!(await lstat(join(directory, tool))).isFile()) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * The pinned toolchain ships beside the server artifact: next to `server.mjs`
 * for npm and next to the compiled executable for standalone, in both the
 * distribution and the per-version installation a supervisor pins. A source
 * checkout has no artifact of its own, so it uses the one a build produced.
 */
export async function packagedToolsDirectory() {
  for (const candidate of [
    import.meta.dirname,
    dirname(process.execPath),
    join(import.meta.dirname, "..", "..", "..", "servers", pkg.version),
    join(
      import.meta.dirname,
      "..",
      "..",
      "cli",
      "dist",
      "servers",
      pkg.version
    ),
  ]) {
    if (await isToolchain(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    "This server installation has no packaged static toolchain to deploy with"
  );
}

/** The packaged static file server, beside the supervisor in the toolchain. */
export async function locateWebsitino() {
  const toolsDirectory = await packagedToolsDirectory();
  const websitino = join(toolsDirectory, `websitino${EXECUTABLE}`);
  if (!(await lstat(websitino)).isFile()) {
    throw new Error("Packaged static server is not a regular file");
  }
  return websitino;
}
