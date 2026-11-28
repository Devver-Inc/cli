import { Schema } from "effect";
import { load } from "js-yaml";

const MAX_CONFIG_BYTES = 65_536;

export const DevverFileSchema = Schema.Record(Schema.String, Schema.Unknown);

export type DevverFile = typeof DevverFileSchema.Type;

export const CommandSchema = Schema.String.pipe(
  Schema.check(
    Schema.isNonEmpty(),
    Schema.isTrimmed(),
    Schema.isPattern(/\S/u),
    Schema.isPattern(/^[^"'`$;&|<>(){}\\\r\n]+$/u)
  )
);
export const RunCommandSchema = Schema.String.pipe(
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

export function decodeDevverContent(raw: string): DevverFile {
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

export const processRecipeFrom = Schema.decodeUnknownSync(ProcessRecipeSchema);
