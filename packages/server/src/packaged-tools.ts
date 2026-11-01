import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";

import pkg from "../../../package.json" with { type: "json" };

const EXECUTABLE = process.platform === "win32" ? ".exe" : "";

async function isToolchain(directory: string) {
  for (const tool of [`pitchfork${EXECUTABLE}`, `ferron${EXECUTABLE}`]) {
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

export async function locateFerron() {
  const toolsDirectory = await packagedToolsDirectory();
  const ferron = join(toolsDirectory, `ferron${EXECUTABLE}`);
  if (!(await lstat(ferron)).isFile()) {
    throw new Error("Packaged static server is not a regular file");
  }
  return ferron;
}
