import { chmod, lstat, readdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { Data, Effect } from "effect";

import { locateFerron } from "../packaged-tools";
import type { DaemonSpec, WorkloadTarget } from "./types";

const PRIVATE_FILE = 0o600;
// Ferron expands `{env:NAME}` in config strings; braces can expose server secrets.
const UNSAFE_IN_KDL = /["\\{\r\n]/u;
// Consume queries and fragments so SPA rewrites do not append them to `/`.
const SPA_ROUTE = String.raw`^/([^?#]*/)*[^./?#]*(?:[?#].*)?$`;

// A preparation failure carries one of the plain sentences this module
// constructs; the surrounding worktree contents never reach it.
export class StaticPrepareFailure extends Data.TaggedError(
  "StaticPrepareFailure"
)<{
  readonly message: string;
}> {}

const failed = (message: string) => new StaticPrepareFailure({ message });

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
        throw failed("Static site contains a symlink outside its directory");
      }
      if ((await lstat(target)).isDirectory()) {
        pending.push(target);
      }
    }
  }
}

async function staticSourceDirectory(worktree: string, configured?: string) {
  const root = await realpath(worktree);
  let directory = ".";
  if (configured !== undefined) {
    directory = configured;
  }
  if (isAbsolute(directory)) {
    throw failed("Static directory must remain inside the worktree");
  }
  const requested = resolve(root, directory);
  if (!inside(root, requested)) {
    throw failed("Static directory must remain inside the worktree");
  }
  try {
    const actual = await realpath(requested);
    if (!inside(root, actual) || !(await lstat(actual)).isDirectory()) {
      throw new Error("Outside worktree");
    }
    await verifyStaticTree(actual);
    return actual;
  } catch {
    throw failed(
      "Static directory must be a safe directory inside the worktree"
    );
  }
}

function kdlString(value: string) {
  if (UNSAFE_IN_KDL.test(value)) {
    throw failed(
      "A deployment path cannot contain quotes, backslashes, braces or newlines"
    );
  }
  return value;
}

function ferronConfig(directory: string, port: number) {
  return `* {
    listen_ip "127.0.0.1"
    default_http_port #null
    default_https_port #null
}

*:${port} {
    root "${kdlString(directory)}"
    rewrite "${SPA_ROUTE}" "/" file=#false directory=#false last=#true
}
`;
}

export const prepareStaticSite = (
  specification: { readonly directory?: string | undefined },
  target: WorkloadTarget
): Effect.Effect<DaemonSpec, StaticPrepareFailure> =>
  Effect.gen(function* () {
    const directory = yield* Effect.tryPromise({
      try: async () =>
        await staticSourceDirectory(target.worktree, specification.directory),
      catch: (cause) =>
        cause instanceof StaticPrepareFailure
          ? cause
          : failed("The static checkout is not usable"),
    });
    const ferron = yield* Effect.tryPromise({
      try: async () => await locateFerron(),
      catch: () => failed("The packaged static server is not available"),
    });
    const config = join(target.directory, "ferron.kdl");
    yield* Effect.tryPromise({
      try: async () => {
        await writeFile(config, ferronConfig(directory, target.port), {
          mode: PRIVATE_FILE,
        });
        await chmod(config, PRIVATE_FILE);
      },
      catch: () =>
        failed("The static server configuration could not be written"),
    });
    return {
      command: [ferron, "-c", config],
      dir: directory,
      port: target.port,
    } satisfies DaemonSpec;
  });
