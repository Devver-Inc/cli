import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { FileStorage } from "@flystorage/file-storage";
import type { DirectoryListing } from "@flystorage/file-storage";
import { LocalStorageAdapter } from "@flystorage/local-fs";

import { Global } from "./global";

/**
 * Thin wrapper around flystorage scoped to the XDG data dir (~/.local/share/devver).
 * All paths are relative to that root -- NOT the user's project cwd.
 * Use this for CLI-internal persisted state (tokens, repo links, project prefs, etc.).
 */
const storage = new FileStorage(new LocalStorageAdapter(Global.Path.data));

async function write(filePath: string, contents: string): Promise<void> {
  // The local adapter does not create a missing parent on every platform:
  // writing a nested key such as "config/cli" into a fresh data directory
  // failed with ENOENT on Windows. Secrets keep their own owner-only writer.
  await mkdir(dirname(join(Global.Path.data, filePath)), { recursive: true });
  await storage.write(filePath, contents);
}

async function readToString(filePath: string): Promise<string> {
  return storage.readToString(filePath);
}

async function deleteFile(filePath: string): Promise<void> {
  await storage.deleteFile(filePath);
}

async function fileExists(filePath: string): Promise<boolean> {
  return storage.fileExists(filePath);
}

async function folderExists(folderPath: string): Promise<boolean> {
  return storage.directoryExists(folderPath);
}

function list(folderPath: string): DirectoryListing {
  return storage.list(folderPath);
}

export const Storage = {
  write,
  readToString,
  deleteFile,
  fileExists,
  folderExists,
  list,
};
