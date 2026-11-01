import { chmod, lstat, readdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { Schema } from "effect";

import { locateFerron } from "../packaged-tools";
import { readDevverFile } from "./config";
import type { DaemonSpec, WorkloadKind } from "./types";

const PRIVATE_FILE = 0o600;
// A KDL string ends at a double quote and escapes with a backslash, and Ferron
// expands `{env:NAME}` when it loads the config, so an unguarded brace would
// interpolate the server's environment into the served configuration.
const UNSAFE_IN_KDL = /["\\{\r\n]/u;
// Any path segment that is not a file or a directory and carries no extension
// is a client-side route. The query and fragment are consumed so the whole URL
// is replaced; matching only the path leaves the query appended to `/`.
const SPA_ROUTE = String.raw`^/([^?#]*/)*[^./?#]*(?:[?#].*)?$`;

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

/** One value inside a KDL double-quoted string, or a closed failure. */
function kdlString(value: string) {
  if (UNSAFE_IN_KDL.test(value)) {
    throw new Error(
      "A deployment path cannot contain quotes, backslashes, braces or newlines"
    );
  }
  return value;
}

/**
 * Ferron accepts only a literal port, so the reserved one is written into the
 * config. The catch-all host block serves whatever hostname the proxy passes
 * through, and both default ports are disabled so nothing binds 80 or 443.
 */
export function ferronConfig(directory: string, port: number) {
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

export const staticSiteKind: WorkloadKind = {
  name: "static",
  resolve: async ({ worktree, directory: slot, port }) => {
    const directory = await staticSourceDirectory(worktree);
    const ferron = await locateFerron();
    const config = join(slot, "ferron.kdl");
    await writeFile(config, ferronConfig(directory, port), {
      mode: PRIVATE_FILE,
    });
    await chmod(config, PRIVATE_FILE);
    const spec: DaemonSpec = {
      command: [ferron, "-c", config],
      dir: directory,
      port,
    };
    return spec;
  },
};
