import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { Schema } from "effect";
import { load } from "js-yaml";

const StaticConfig = Schema.Struct({
  static: Schema.Struct({
    directory: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
  }),
});

const decodeStaticConfig = Schema.decodeUnknownSync(StaticConfig);

function inside(root: string, path: string) {
  const subpath = relative(root, path);
  return (
    subpath !== ".." && !subpath.startsWith(`..${sep}`) && !isAbsolute(subpath)
  );
}

async function verifyStaticTree(root: string) {
  const pending = [root];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined || visited.has(directory)) {
      continue;
    }
    visited.add(directory);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      const target = entry.isSymbolicLink() ? await realpath(file) : file;
      if (!inside(root, target)) {
        throw new Error("Static site contains a symlink outside its directory");
      }
      if ((await lstat(target)).isDirectory()) {
        pending.push(target);
      }
    }
  }
}

/** Resolve only static files from the selected, committed worktree. */
export async function staticSourceDirectory(worktree: string): Promise<string> {
  const root = await realpath(worktree);
  const configPath = join(root, ".devver.yaml");
  let directory = ".";
  let stat;
  try {
    stat = await lstat(configPath);
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error && error.code === "ENOENT")
    ) {
      // Do not attach filesystem errors: their paths can contain untrusted input.
      // oxlint-disable-next-line eslint/preserve-caught-error -- A cause could expose local paths.
      throw new Error("Cannot read static configuration");
    }
  }
  if (stat !== undefined) {
    try {
      if (!stat.isFile()) {
        throw new Error("Not a regular file");
      }
      const raw = await readFile(configPath, "utf-8");
      const value: unknown = load(raw);
      directory = decodeStaticConfig(value).static.directory ?? ".";
    } catch {
      throw new Error("Invalid static configuration in .devver.yaml");
    }
  }
  if (isAbsolute(directory)) {
    throw new Error("Static directory must remain inside the worktree");
  }
  const requested = resolve(root, directory);
  if (!inside(root, requested)) {
    throw new Error("Static directory must remain inside the worktree");
  }
  try {
    const actual = await realpath(requested);
    if (!inside(root, actual) || !(await lstat(actual)).isDirectory()) {
      throw new Error("Outside worktree");
    }
    await verifyStaticTree(actual);
    return actual;
  } catch {
    throw new Error(
      "Static directory must be a safe directory inside the worktree"
    );
  }
}
