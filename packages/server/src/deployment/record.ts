import { Schema } from "effect";

export const DeployStageSchema = Schema.Literals([
  "server",
  "source",
  "git",
  "config",
  "process",
  "readiness",
]);

export type DeployStage = typeof DeployStageSchema.Type;

const identity = {
  deploymentId: Schema.String.check(Schema.isUUID(4)),
  repositoryId: Schema.String.check(Schema.isNonEmpty()),
  commit: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u)),
  parentDeploymentId: Schema.NullOr(Schema.String.check(Schema.isUUID(4))),
  secondParentDeploymentId: Schema.NullOr(
    Schema.String.check(Schema.isUUID(4))
  ),
  worktree: Schema.String.check(Schema.isNonEmpty()),
};

export const NewDeploymentSchema = Schema.Struct({
  ...identity,
  repositoryId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
});

export const DeploymentSchema = Schema.Struct({
  ...identity,
  status: Schema.Literals(["preparing", "ready", "failed", "degraded"]),
  stage: Schema.NullOr(DeployStageSchema),
  displayName: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});

export type Deployment = typeof DeploymentSchema.Type;
export type NewDeployment = typeof NewDeploymentSchema.Type;
