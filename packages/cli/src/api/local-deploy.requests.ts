import { Effect, Schema } from "effect";

import { ApiClient } from "./client";

const DeploymentId = Schema.String.check(Schema.isUUID(4));
const Commit = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u));

export const LocalDeploymentRequestSchema = Schema.Struct({
  source: Schema.String.check(Schema.isMinLength(1)),
  commit: Commit,
});

export const LocalDeploymentSchema = Schema.Struct({
  deploymentId: DeploymentId,
  repositoryId: Schema.String,
  commit: Commit,
  parentDeploymentId: Schema.NullOr(DeploymentId),
  secondParentDeploymentId: Schema.optional(Schema.NullOr(DeploymentId)),
  url: Schema.String,
});

const LocalDeploymentStatuses = Schema.Array(
  Schema.Struct({
    deploymentId: DeploymentId,
    repositoryId: Schema.optional(
      Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u))
    ),
    commit: Schema.optional(Commit),
    parentDeploymentId: Schema.optional(Schema.NullOr(DeploymentId)),
    secondParentDeploymentId: Schema.optional(Schema.NullOr(DeploymentId)),
    displayName: Schema.optional(Schema.NullOr(Schema.String)),
    status: Schema.Literals(["preparing", "ready", "failed", "degraded"]),
    stage: Schema.NullOr(
      Schema.Literals([
        "server",
        "source",
        "git",
        "config",
        "process",
        "readiness",
      ])
    ),
    url: Schema.optional(Schema.NullOr(Schema.String)),
  })
);

export type LocalDeploymentStatus =
  (typeof LocalDeploymentStatuses.Type)[number];

export const listLocalDeployments = Effect.gen(function* () {
  const api = yield* ApiClient;
  return yield* api.get("/deployments", LocalDeploymentStatuses);
});

const RenameResponse = Schema.Struct({ displayName: Schema.String });

export const mergeLocalDeployments = (
  firstDeploymentId: string,
  secondDeploymentId: string
) =>
  Effect.gen(function* () {
    const api = yield* ApiClient;
    return yield* api.post(
      "/deployments/merge",
      { firstDeploymentId, secondDeploymentId },
      LocalDeploymentSchema
    );
  });

export const renameLocalDeployment = (
  deploymentId: string,
  displayName: string
) =>
  Effect.gen(function* () {
    const api = yield* ApiClient;
    return yield* api.put(
      `/deployments/${encodeURIComponent(deploymentId)}/name`,
      { displayName },
      RenameResponse
    );
  });

const encodeRequest = Schema.encodeUnknownSync(LocalDeploymentRequestSchema);

export const createLocalDeployment = (
  body: typeof LocalDeploymentRequestSchema.Type
) =>
  Effect.gen(function* () {
    const api = yield* ApiClient;
    return yield* api.post(
      "/deployments",
      encodeRequest(body),
      LocalDeploymentSchema
    );
  });
