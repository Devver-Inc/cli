import { Schema } from "effect";

import { DeployStageSchema } from "./deployment/record";

export const CONTROL_PROTOCOL_VERSION = 1;

export const DeploymentId = Schema.String.check(Schema.isUUID(4));
export const Commit = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u));
export const RepositoryIdHash = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{64}$/u)
);

export const DisplayName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(80),
  // oxlint-disable-next-line no-control-regex -- Reject terminal escape and C0/C1 controls in persisted names.
  Schema.isPattern(/^[^\u0000-\u001F\u007F-\u009F]+$/u),
  Schema.isTrimmed()
);

export const DeployRequest = Schema.Struct({
  source: Schema.String.check(Schema.isNonEmpty()),
  commit: Commit,
});

export const MergeRequest = Schema.Struct({
  firstDeploymentId: DeploymentId,
  secondDeploymentId: DeploymentId,
});

export const DeploymentResponse = Schema.Struct({
  deploymentId: DeploymentId,
  repositoryId: Schema.String,
  commit: Commit,
  parentDeploymentId: Schema.NullOr(DeploymentId),
  secondParentDeploymentId: Schema.NullOr(DeploymentId),
  url: Schema.String,
});

const DeploymentStatusSchema = Schema.Struct({
  deploymentId: DeploymentId,
  repositoryId: Schema.optional(RepositoryIdHash),
  commit: Schema.optional(Commit),
  commitSubject: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: Schema.optional(Schema.String),
  parentDeploymentId: Schema.optional(Schema.NullOr(DeploymentId)),
  secondParentDeploymentId: Schema.optional(Schema.NullOr(DeploymentId)),
  displayName: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.Literals(["preparing", "ready", "failed", "degraded"]),
  stage: Schema.NullOr(DeployStageSchema),
  url: Schema.optional(Schema.NullOr(Schema.String)),
});

export const DeploymentStatuses = Schema.Array(DeploymentStatusSchema);

export const RenameResponse = Schema.Struct({ displayName: DisplayName });

export const IdentityResponse = Schema.Struct({
  instanceId: Schema.String,
  name: Schema.String,
  serverVersion: Schema.String,
  controlProtocolVersion: Schema.Literal(CONTROL_PROTOCOL_VERSION),
});

export type Deployment = typeof DeploymentResponse.Type;
export type DeploymentStatus = typeof DeploymentStatusSchema.Type;
