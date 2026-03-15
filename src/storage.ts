import { FileStorage } from "@flystorage/file-storage";
import { LocalStorageAdapter } from "@flystorage/local-fs";
import { Global } from "./global";

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

export const Storage = {
  write,
  readToString,
  deleteFile,
  fileExists,
};
