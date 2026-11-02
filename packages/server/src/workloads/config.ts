import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";

import { Schema } from "effect";
import { load } from "js-yaml";

const MAX_CONFIG_BYTES = 65_536;

export const DevverFileSchema = Schema.Record(Schema.String, Schema.Unknown);

export type DevverFile = typeof DevverFileSchema.Type;

const CommandSchema = Schema.String.pipe(
  Schema.check(
    Schema.isNonEmpty(),
    Schema.isTrimmed(),
    Schema.isPattern(/\S/u),
    Schema.isPattern(/^[^"'`$;&|<>(){}\\\r\n]+$/u)
  )
);
const RunCommandSchema = Schema.String.pipe(
  Schema.check(
    Schema.isNonEmpty(),
    Schema.isTrimmed(),
    Schema.isPattern(/\S/u),
    Schema.isPattern(/^(?:[^"'`$;&|<>(){}\\\r\n]|\$\{PORT\})+$/u)
  )
);

export const ProcessRecipeSchema = Schema.Struct({
  install: Schema.optional(CommandSchema),
  build: Schema.optional(CommandSchema),
  run: RunCommandSchema,
});

export type ProcessRecipe = typeof ProcessRecipeSchema.Type;

const decodeDevverFile = Schema.decodeUnknownSync(DevverFileSchema);
const decodeProcessRecipe = Schema.decodeUnknownSync(ProcessRecipeSchema);

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

export async function readProcessRecipe(
  worktree: string
): Promise<ProcessRecipe> {
  const { process } = await readDevverFile(worktree);
  try {
    return decodeProcessRecipe(process);
  } catch {
    throw new Error("The process configuration is not usable");
  }
}
