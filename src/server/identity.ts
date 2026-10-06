import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { xdgData } from "xdg-basedir";

const InstanceSchema = Schema.Struct({
  instanceId: Schema.String.check(Schema.isUUID(4)),
  name: Schema.String,
});

const decodeInstance = Schema.decodeUnknownSync(InstanceSchema);
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const PRIVATE_DIRECTORY = 0o700;
const PRIVATE_FILE = 0o600;

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
  if (process.platform === "win32" || process.getuid === undefined) {
    throw new Error(
      "Server instance state requires POSIX owner-only filesystem permissions"
    );
  }
  if (!NAME.test(name)) {
    throw new Error(
      "Invalid server instance name (use letters, numbers, _ or -; start with a letter or number)"
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

export async function loadInstance(name: string) {
  const directory = join(await instanceParent(name), name);
  try {
    await mkdir(directory, { mode: PRIVATE_DIRECTORY });
  } catch (error) {
    if (!isExisting(error)) {
      throw error;
    }
  }
  checkOwner(await lstat(directory), PRIVATE_DIRECTORY, "directory");

  const file = join(directory, "identity.json");
  try {
    const handle = await open(file, "wx", PRIVATE_FILE);
    try {
      const instance = { instanceId: randomUUID(), name };
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
  checkOwner(await lstat(file), PRIVATE_FILE, "file");
  try {
    const instance = decodeInstance(JSON.parse(await readFile(file, "utf8")));
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
