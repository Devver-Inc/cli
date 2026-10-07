/**
 * Owner-only creation steps shared by the POSIX supervisors.
 *
 * POSIX mode bits are the whole access boundary here, so the pinned server and
 * its installation directories are created with them and verified afterwards.
 * Windows instance state cannot use them and keeps its own ACL-backed copy.
 */

import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pkg from "../../package.json" with { type: "json" };

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o700;

function existing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

async function privateDirectory(path: string) {
  try {
    await mkdir(path, { mode: DIRECTORY_MODE });
  } catch (error) {
    if (!existing(error)) {
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

export async function pinServer(parent: string) {
  const installations = join(dirname(parent), "installations");
  await privateDirectory(installations);
  const version = join(installations, pkg.version);
  await privateDirectory(version);
  const npm = process.versions.bun === undefined;
  // The npm CLI is split into ESM chunks beside dist/servers; argv[1] may
  // be the extensionless npm bin symlink rather than dist/cli.mjs.
  const sourceRoot = npm
    ? dirname(fileURLToPath(import.meta.url))
    : dirname(process.execPath);
  const source = join(
    sourceRoot,
    "servers",
    pkg.version,
    npm ? "server.mjs" : "devver-server"
  );
  const packaged = await lstat(source);
  if (!packaged.isFile()) {
    throw new Error("Packaged server must be a regular file");
  }
  const destination = join(version, npm ? "server.mjs" : "devver-server");
  const staging = join(version, `.server-${randomUUID()}`);
  const handle = await open(staging, "wx", FILE_MODE);
  try {
    await handle.writeFile(await readFile(source));
    await handle.sync();
    try {
      // A complete, fsynced copy becomes visible atomically; never replace a pin.
      await link(staging, destination);
    } catch (error) {
      if (!existing(error)) {
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
    throw new Error("Pinned server must be an owner-only regular file");
  }
  return {
    command: npm ? process.execPath : destination,
    args: npm ? [destination] : [],
  };
}
