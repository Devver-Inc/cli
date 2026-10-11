import { Effect, Schema } from "effect";

import { ApiClient } from "./client";

const DeploymentId = Schema.String.check(Schema.isUUID(4));
const Commit = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u));

/** The checkout root and the exact committed revision the server must serve. */
export const LocalDeploymentRequestSchema = Schema.Struct({
  source: Schema.String.check(Schema.isMinLength(1)),
  commit: Commit,
});

export const LocalDeploymentSchema = Schema.Struct({
  deploymentId: DeploymentId,
  repositoryId: Schema.String,
  commit: Commit,
  parentDeploymentId: Schema.NullOr(DeploymentId),
  url: Schema.String,
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
