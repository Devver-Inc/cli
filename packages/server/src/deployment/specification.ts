import { Schema } from "effect";

import { DeployFailure } from "../api";
import type { DevverFile, ProcessRecipe } from "../workloads/config";
import {
  CommandSchema,
  decodeDevverContent,
  processRecipeFrom,
  RunCommandSchema,
} from "../workloads/config";

export const StaticSpecificationSchema = Schema.Struct({
  kind: Schema.Literals(["static"]),
  directory: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
});

export const ProcessSpecificationSchema = Schema.Struct({
  kind: Schema.Literals(["process"]),
  install: Schema.optional(CommandSchema),
  build: Schema.optional(CommandSchema),
  run: RunCommandSchema,
});

export const DeploymentSpecificationSchema = Schema.Union([
  StaticSpecificationSchema,
  ProcessSpecificationSchema,
]);

export type DeploymentSpecification = typeof DeploymentSpecificationSchema.Type;

const StaticSection = Schema.Struct({
  static: Schema.optional(
    Schema.Struct({
      directory: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
    })
  ),
});

const failure = (message: string) =>
  new DeployFailure({ stage: "config", message: `config: ${message}` });

export const specificationOf = (
  committed: string | null
): DeploymentSpecification | DeployFailure => {
  if (committed === null) {
    return { kind: "static" };
  }
  let file: DevverFile;
  try {
    file = decodeDevverContent(committed);
  } catch (error) {
    return failure(
      error instanceof Error && error.message !== ""
        ? error.message
        : "the committed configuration is not usable"
    );
  }
  const names = Object.keys(file);
  if (names.length === 0 || (names.length === 1 && names[0] === "static")) {
    try {
      const decoded = Schema.decodeSync(StaticSection)(file);
      return { kind: "static", directory: decoded.static?.directory };
    } catch {
      return failure("the static configuration is not usable");
    }
  }
  if (names.length === 1 && names[0] === "process") {
    let recipe: ProcessRecipe;
    try {
      recipe = processRecipeFrom(file.process);
    } catch {
      return failure("the process configuration is not usable");
    }
    return { kind: "process", ...recipe };
  }
  return failure(
    "the deployment configuration must declare one local workload"
  );
};
