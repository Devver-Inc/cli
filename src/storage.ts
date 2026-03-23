import { type DirectoryListing, FileStorage } from "@flystorage/file-storage";
import { LocalStorageAdapter } from "@flystorage/local-fs";
import { Global } from "./global";

/**
 * Thin wrapper around flystorage scoped to the XDG data dir (~/.local/share/devver).
 * All paths are relative to that root -- NOT the user's project cwd.
 * Use this for CLI-internal persisted state (tokens, repo links, project prefs, etc.).
 */
const storage = new FileStorage(new LocalStorageAdapter(Global.Path.data));

async function write(filePath: string, contents: string): Promise<void> {
  await storage.write(filePath, contents);
}

function readToString(filePath: string): Promise<string> {
  return storage.readToString(filePath);
}

async function deleteFile(filePath: string): Promise<void> {
  await storage.deleteFile(filePath);
}

function fileExists(filePath: string): Promise<boolean> {
  return storage.fileExists(filePath);
}

function folderExists(folderPath: string): Promise<boolean> {
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
