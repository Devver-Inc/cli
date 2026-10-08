import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { Schema } from "effect";
import { xdgData } from "xdg-basedir";

import {
  existingWindowsServersDirectory,
  verifyWindowsPrivate,
  windowsPrivateDirectories,
  windowsServersDirectory,
} from "./windows-acl";

const InstanceSchema = Schema.Struct({
  instanceId: Schema.String.check(Schema.isUUID(4)),
  name: Schema.String,
});

const decodeInstance = Schema.decodeUnknownSync(InstanceSchema);
const PORT = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 65_535 })
);
const VERSION = Schema.String.check(
  Schema.isPattern(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/u)
);
const UUID =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}";
const SERVICE = {
  darwin: Schema.Struct({
    label: Schema.String.check(
      Schema.isPattern(new RegExp(`^com\\.devver\\.server\\.${UUID}$`, "u"))
    ),
    port: PORT,
    serverVersion: VERSION,
  }),
  linux: Schema.Struct({
    unit: Schema.String.check(
      Schema.isPattern(new RegExp(`^devver-${UUID}\\.service$`, "u"))
    ),
    port: PORT,
    serverVersion: VERSION,
  }),
  win32: Schema.Struct({
    task: Schema.String.check(
      Schema.isPattern(new RegExp(`^devver-${UUID}$`, "u"))
    ),
    port: PORT,
    serverVersion: VERSION,
  }),
};
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u;
const PRIVATE_DIRECTORY = 0o700;
const PRIVATE_FILE = 0o600;

// Node filesystem errors enter as unknown; only the error code is inspected.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
function isExisting(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function checkDataRoot(
  stat: Awaited<ReturnType<typeof lstat>>,
  created: boolean
) {
  if (
    stat.uid !== process.getuid?.() ||
    !stat.isDirectory() ||
    // Node's stat mode may be bigint; permission arithmetic needs a number.
    // oxlint-disable-next-line anti-slop/no-runtime-typeof
    typeof stat.mode !== "number"
  ) {
    throw new Error(
      "Server data root must be owned by this user and not a symlink"
    );
  }
  const permissions = stat.mode % 0o1000;
  const group = Math.floor(permissions / 0o10) % 0o10;
  const other = permissions % 0o10;
  if (
    group % 4 >= 2 ||
    other % 4 >= 2 ||
    (created && permissions !== PRIVATE_DIRECTORY)
  ) {
    throw new Error(
      "Server data root must be 0700 when new and not group/other writable when existing"
    );
  }
}

function checkOwner(
  stat: Awaited<ReturnType<typeof lstat>>,
  mode: number,
  kind: "directory" | "file"
) {
  if (
    stat.uid !== process.getuid?.() ||
    // oxlint-disable-next-line anti-slop/no-runtime-typeof
    typeof stat.mode !== "number" ||
    stat.mode % 0o1000 !== mode ||
    (kind === "directory" ? !stat.isDirectory() : !stat.isFile())
  ) {
    throw new Error(
      `Server instance ${kind} must be owner-only and not a symlink`
    );
  }
}

export async function instanceParent(name: string) {
  if (!NAME.test(name)) {
    throw new Error(
      "Invalid server instance name (use letters, numbers, _ or -; start with a letter or number)"
    );
  }

  if (process.platform === "win32") {
    return await windowsServersDirectory();
  }
  if (process.getuid === undefined) {
    throw new Error(
      "Server instance state requires owner-only filesystem permissions"
    );
  }
  const data = xdgData ?? join(homedir(), ".local", "share");
  await mkdir(data, { recursive: true });
  const root = join(data, "devver");
  let created = false;
  try {
    await mkdir(root, { mode: PRIVATE_DIRECTORY });
    created = true;
  } catch (error) {
    if (!isExisting(error)) {
      throw error;
    }
  }
  checkDataRoot(await lstat(root), created);
  const servers = join(root, "servers");
  try {
    await mkdir(servers, { mode: PRIVATE_DIRECTORY });
  } catch (error) {
    if (!isExisting(error)) {
      throw error;
    }
  }
  checkOwner(await lstat(servers), PRIVATE_DIRECTORY, "directory");
  return servers;
}

async function existingStat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      // Explicit undefined keeps the async helper's return branches consistent.
      // oxlint-disable-next-line unicorn/no-useless-undefined
      return undefined;
    }
    throw error;
  }
}

async function existingParent() {
  if (process.platform === "win32") {
    return await existingWindowsServersDirectory();
  }
  if (process.getuid === undefined) {
    throw new Error(
      "Server instance state requires owner-only filesystem permissions"
    );
  }
  const data = xdgData ?? join(homedir(), ".local", "share");
  const root = join(data, "devver");
  const rootStat = await existingStat(root);
  if (rootStat === undefined) {
    // oxlint-disable-next-line unicorn/no-useless-undefined
    return undefined;
  }
  checkDataRoot(rootStat, false);
  const servers = join(root, "servers");
  const serversStat = await existingStat(servers);
  if (serversStat === undefined) {
    // oxlint-disable-next-line unicorn/no-useless-undefined
    return undefined;
  }
  checkOwner(serversStat, PRIVATE_DIRECTORY, "directory");
  return servers;
}

/** Read only this user's persisted instance identities; never initialize state. */
export async function listInstances() {
  const parent = await existingParent();
  if (parent === undefined) {
    return [];
  }
  const instances: (typeof InstanceSchema.Type)[] = [];
  for (const name of (await readdir(parent)).toSorted()) {
    if (!NAME.test(name)) {
      throw new Error("Server instance state contains an invalid entry name");
    }
    const directory = join(parent, name);
    const file = join(directory, "identity.json");
    try {
      if (process.platform === "win32") {
        await verifyWindowsPrivate(
          { path: directory, kind: "directory" },
          { path: file, kind: "file" }
        );
      } else {
        checkOwner(await lstat(directory), PRIVATE_DIRECTORY, "directory");
        checkOwner(await lstat(file), PRIVATE_FILE, "file");
      }
      const instance = decodeInstance(
        JSON.parse(await readFile(file, "utf-8"))
      );
      if (instance.name !== name) {
        throw new Error("Instance name mismatch");
      }
      instances.push(instance);
    } catch {
      throw new Error(
        `Server instance '${name}' has invalid or unsafe state; it was not replaced`
      );
    }
  }
  return instances;
}

/** Verify owner-only service metadata for an existing named instance. */
export async function readInstanceService(name: string) {
  if (!NAME.test(name)) {
    throw new Error("Invalid server instance name");
  }
  const parent = await existingParent();
  if (parent === undefined) {
    throw new Error(`Server instance '${name}' has missing state`);
  }
  const directory = join(parent, name);
  const file = join(directory, "service.json");
  try {
    if (process.platform === "win32") {
      await verifyWindowsPrivate(
        { path: directory, kind: "directory" },
        { path: file, kind: "file" }
      );
    } else {
      checkOwner(await lstat(directory), PRIVATE_DIRECTORY, "directory");
      checkOwner(await lstat(file), PRIVATE_FILE, "file");
    }
    const value: unknown = JSON.parse(await readFile(file, "utf-8"));
    if (process.platform === "win32") {
      return Schema.decodeUnknownSync(SERVICE.win32)(value);
    }
    if (process.platform === "darwin") {
      return Schema.decodeUnknownSync(SERVICE.darwin)(value);
    }
    if (process.platform === "linux") {
      return Schema.decodeUnknownSync(SERVICE.linux)(value);
    }
    throw new Error("Unsupported platform");
  } catch {
    throw new Error(
      `Server instance '${name}' has invalid or unsafe service state`
    );
  }
}

export async function loadInstance(name: string) {
  const directory = join(await instanceParent(name), name);
  if (process.platform === "win32") {
    await windowsPrivateDirectories(directory);
  } else {
    try {
      await mkdir(directory, { mode: PRIVATE_DIRECTORY });
    } catch (error) {
      if (!isExisting(error)) {
        throw error;
      }
    }
    checkOwner(await lstat(directory), PRIVATE_DIRECTORY, "directory");
  }

  const file = join(directory, "identity.json");
  try {
    const handle = await open(file, "wx", PRIVATE_FILE);
    try {
      const instance = { instanceId: randomUUID(), name };
      if (process.platform === "win32") {
        await verifyWindowsPrivate({ path: file, kind: "file" });
      }
      await handle.writeFile(JSON.stringify(instance));
      await handle.sync();
      return instance;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!isExisting(error)) {
      throw error;
    }
  }
  if (process.platform === "win32") {
    await verifyWindowsPrivate({ path: file, kind: "file" });
  } else {
    checkOwner(await lstat(file), PRIVATE_FILE, "file");
  }
  try {
    const instance = decodeInstance(JSON.parse(await readFile(file, "utf-8")));
    if (instance.name !== name) {
      throw new Error("Instance name mismatch");
    }
    return instance;
  } catch {
    throw new Error(
      `Server instance '${name}' has invalid state; it was not replaced`
    );
  }
}
