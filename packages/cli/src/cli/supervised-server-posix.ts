import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import pkg from "../../../../package.json" with { type: "json" };
import { isAlreadyExists } from "../util/fs-errors";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o700;

export class MissingPackagedServerError extends Error {
  override name = "MissingPackagedServerError";
}

async function privateDirectory(path: string) {
  try {
    await mkdir(path, { mode: DIRECTORY_MODE });
  } catch (error) {
    if (!isAlreadyExists(error)) {
      throw error;
    }
  }
  const stat = await lstat(path);
  if (
    stat.uid !== process.getuid?.() ||
    !stat.isDirectory() ||
    stat.mode % 0o1000 !== DIRECTORY_MODE
  ) {
    throw new Error(
      "Server installation directory must be owner-only and not a symlink"
    );
  }
}

export async function pinServer(parent: string, instanceId: string) {
  const installations = join(dirname(parent), "installations");
  await privateDirectory(installations);
  const version = join(installations, pkg.version);
  await privateDirectory(version);
  const pinnedInstance = join(version, instanceId);
  await privateDirectory(pinnedInstance);
  const npm = process.versions.bun === undefined;
  // The npm CLI is split into ESM chunks beside dist/servers; argv[1] may
  // be the extensionless npm bin symlink rather than dist/cli.mjs.
  const sourceRoot = npm ? import.meta.dirname : dirname(process.execPath);
  const serverName = npm ? "server.mjs" : "devver-server";
  for (const name of [
    serverName,
    "pitchfork",
    "ferron",
    "PITCHFORK-LICENSE",
    "FERRON-LICENSE",
  ]) {
    const source = join(sourceRoot, "servers", pkg.version, name);
    const packaged = await lstat(source).catch(() => undefined);
    if (packaged === undefined) {
      throw new MissingPackagedServerError(
        `Packaged server tool '${name}' is missing at ${source}. Creating a server needs a packaged build: run 'bun run build', then create the instance with the built './devver' executable. This command cannot run the CLI from source.`
      );
    }
    if (!packaged.isFile()) {
      throw new Error("Packaged server tool must be a regular file");
    }
    const destination = join(pinnedInstance, name);
    const staging = join(pinnedInstance, `.server-${randomUUID()}`);
    const handle = await open(staging, "wx", FILE_MODE);
    try {
      await handle.writeFile(await readFile(source));
      await handle.sync();
      try {
        await link(staging, destination);
      } catch (error) {
        if (!isAlreadyExists(error)) {
          throw error;
        }
      }
    } finally {
      await handle.close();
      await rm(staging, { force: true });
    }
    const pinned = await lstat(destination);
    if (
      pinned.uid !== process.getuid?.() ||
      !pinned.isFile() ||
      pinned.mode % 0o1000 !== FILE_MODE
    ) {
      throw new Error("Pinned server tool must be an owner-only regular file");
    }
  }
  const destination = join(pinnedInstance, serverName);
  return {
    command: npm ? process.execPath : destination,
    args: npm ? [destination] : [],
  };
}
