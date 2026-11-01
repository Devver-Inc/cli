import { lstat, readdir, realpath } from "node:fs/promises";
import { release } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { Schema } from "effect";

import { portPlaceholder } from "../deployment-host";
import { locateWebsitino } from "../packaged-tools";
import { readDevverFile } from "./config";
import type { DaemonSpec, WorkloadKind } from "./types";

const StaticSection = Schema.Struct({
  workload: Schema.optional(Schema.String),
  static: Schema.optional(
    Schema.Struct({
      directory: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
    })
  ),
});

const decodeStaticSection = Schema.decodeUnknownSync(StaticSection);

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

export async function staticSourceDirectory(worktree: string): Promise<string> {
  const root = await realpath(worktree);
  const file = await readDevverFile(worktree);
  let directory = ".";
  let configured: string | undefined;
  try {
    const { static: staticSection } = decodeStaticSection(file);
    configured = staticSection?.directory;
  } catch {
    throw new Error("The static configuration is not usable");
  }
  if (configured !== undefined) {
    directory = configured;
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

async function requireMacOS14() {
  if (process.platform !== "darwin") {
    return;
  }
  const major = Math.trunc(Number(release().split(".")[0] ?? ""));
  if (!(major >= 23)) {
    throw new Error("Local static serving requires macOS 14 or newer");
  }
}

export const staticSiteKind: WorkloadKind = {
  name: "static",
  resolve: async (worktree) => {
    const directory = await staticSourceDirectory(worktree);
    await requireMacOS14();
    const websitino = await locateWebsitino();
    const spec: DaemonSpec = {
      command: [
        websitino,
        directory,
        "--bind",
        "127.0.0.1",
        "--port",
        portPlaceholder,
        "--index",
        "--spa",
      ],
      dir: directory,
    };
    return spec;
  },
};
