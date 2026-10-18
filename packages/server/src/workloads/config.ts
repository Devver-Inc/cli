/**
 * The `.devver.yaml` format boundary.
 *
 * Only the file's format decisions live here: where it is read from, how large
 * it may be, that it must be a regular file, and that sections this server
 * does not know are tolerated so workloads can coexist. The meaning of each
 * section belongs to the workload module that claims it; this module returns
 * the raw decoded sections untouched.
 */

import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";

import { Schema } from "effect";
import { load } from "js-yaml";

const MAX_CONFIG_BYTES = 65_536;

/** Sections this module never interprets. A workload decodes its own. */
export const DevverFileSchema = Schema.Record(Schema.String, Schema.Unknown);

export type DevverFile = typeof DevverFileSchema.Type;

const decodeDevverFile = Schema.decodeUnknownSync(DevverFileSchema);

/**
 * Read the committed configuration of one worktree.
 *
 * An absent file is an empty configuration, not an error: a worktree with no
 * `.devver.yaml` is deployable. Anything unreadable, oversized or malformed
 * fails with prose only, because filesystem errors can carry local paths and
 * the YAML content is untrusted input.
 */
export async function readDevverFile(worktree: string): Promise<DevverFile> {
  const root = await realpath(worktree);
  const configPath = join(root, ".devver.yaml");
  let stat;
  try {
    stat = await lstat(configPath);
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error && error.code === "ENOENT")
    ) {
      throw new Error("Cannot read the deployment configuration", {
        cause: error,
      });
    }
    return {};
  }
  if (!stat.isFile()) {
    throw new Error("The deployment configuration is not a regular file");
  }
  let raw;
  try {
    raw = await readFile(configPath, "utf-8");
  } catch {
    throw new Error("Cannot read the deployment configuration");
  }
  if (raw.length > MAX_CONFIG_BYTES) {
    throw new Error("The deployment configuration is too large");
  }
  let value: unknown;
  try {
    value = load(raw);
  } catch {
    throw new Error("The deployment configuration is not valid YAML");
  }
  if (value === null || value === undefined) {
    return {};
  }
  try {
    return decodeDevverFile(value);
  } catch {
    throw new Error("The deployment configuration has an unexpected shape");
  }
}
