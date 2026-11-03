import { chmod, lstat, mkdir, open } from "node:fs/promises";

import { isAlreadyExists } from "./fs-errors";
import { verifyWindowsPrivate } from "./windows-acl";

const PRIVATE_DIRECTORY = 0o700;
const PRIVATE_FILE = 0o600;

const owned = (uid: number) => uid === process.getuid?.();

async function create(path: string) {
  try {
    await mkdir(path, { mode: PRIVATE_DIRECTORY, recursive: false });
  } catch (error) {
    if (!isAlreadyExists(error)) {
      throw error;
    }
  }
}

export async function requirePrivateDirectory(path: string) {
  await create(path);
  if (process.platform === "win32") {
    await verifyWindowsPrivate({ path, kind: "directory" });
    return;
  }
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    !owned(stat.uid) ||
    stat.mode % 0o1000 !== PRIVATE_DIRECTORY
  ) {
    throw new Error("Server deployment state must be owner-only");
  }
}

// Pitchfork changes its own state directories to 0755 while running.
export async function restorePrivateDirectory(path: string) {
  await create(path);
  if (process.platform === "win32") {
    await verifyWindowsPrivate({ path, kind: "directory" });
    return;
  }
  const existing = await lstat(path);
  if (!existing.isDirectory() || !owned(existing.uid)) {
    throw new Error("Deployment state must be a directory owned by this user");
  }
  await chmod(path, PRIVATE_DIRECTORY);
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.mode % 0o1000 !== PRIVATE_DIRECTORY) {
    throw new Error("Deployment state must be owner-only");
  }
}

export async function privateFile(path: string) {
  const handle = await open(path, "a", PRIVATE_FILE);
  await handle.close();
  if (process.platform === "win32") {
    return;
  }
  const stat = await lstat(path);
  if (
    !stat.isFile() ||
    !owned(stat.uid) ||
    stat.mode % 0o1000 !== PRIVATE_FILE
  ) {
    throw new Error("Deployment records must be an owner-only regular file");
  }
}
