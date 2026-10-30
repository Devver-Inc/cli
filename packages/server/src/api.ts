import { Schema } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
} from "effect/http-api";

import { DeployStageSchema } from "./deployment-store";

export const CONTROL_PROTOCOL_VERSION = 1;

export const API_PATH = "/api/v1";

const DeploymentId = Schema.String.check(Schema.isUUID(4));
const Commit = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u));

export const DisplayName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(80),
  // oxlint-disable-next-line no-control-regex -- Reject terminal escape and C0/C1 controls in persisted names.
  Schema.isPattern(/^[^\u0000-\u001F\u007F-\u009F]+$/u),
  Schema.isTrimmed()
);

/** The checkout and commit a local deploy selects, both untrusted. */
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

export const DeploymentStatuses = Schema.Array(
  Schema.Struct({
    deploymentId: DeploymentId,
    repositoryId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
    commit: Commit,
    commitSubject: Schema.NullOr(Schema.String),
    createdAt: Schema.String,
    parentDeploymentId: Schema.NullOr(DeploymentId),
    secondParentDeploymentId: Schema.NullOr(DeploymentId),
    displayName: Schema.NullOr(DisplayName),
    status: Schema.Literals(["preparing", "ready", "failed", "degraded"]),
    stage: Schema.NullOr(DeployStageSchema),
    url: Schema.NullOr(Schema.String),
  })
);

/** Every failed deployment names the stage that failed and nothing else. */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.Error builds the error class at this contract boundary; it is not a throw.
export class DeployFailure extends Schema.Error<DeployFailure>("DeployFailure")(
  {
    _tag: Schema.tag("DeployFailure"),
    stage: DeployStageSchema,
    message: Schema.String,
  },
  { httpApiStatus: 500 }
) {}

// oxlint-disable-next-line unicorn/throw-new-error -- Schema.Error declares a typed HTTP error.
export class DeploymentNotFound extends Schema.Error<DeploymentNotFound>(
  "DeploymentNotFound"
)(
  { _tag: Schema.tag("DeploymentNotFound"), message: Schema.String },
  { httpApiStatus: 404 }
) {}

// oxlint-disable-next-line unicorn/throw-new-error -- Schema.Error declares a typed HTTP error.
export class MergeRejected extends Schema.Error<MergeRejected>("MergeRejected")(
  { _tag: Schema.tag("MergeRejected"), message: Schema.String },
  { httpApiStatus: 400 }
) {}

export const IdentityResponse = Schema.Struct({
  instanceId: Schema.String,
  name: Schema.String,
  serverVersion: Schema.String,
  controlProtocolVersion: Schema.Literal(CONTROL_PROTOCOL_VERSION),
});

export const api = HttpApi.make("DevverControl")
  .add(
    HttpApiGroup.make("instance")
      .add(
        HttpApiEndpoint.get("identity", "/identity", {
          success: HttpApiSchema.WithHeaders(IdentityResponse, {
            "cache-control": Schema.Literal("no-store"),
          }),
        })
      )
      .prefix(API_PATH)
  )
  .add(
    HttpApiGroup.make("deployments")
      .add(
        HttpApiEndpoint.post("create", "/deployments", {
          payload: DeployRequest,
          success: DeploymentResponse,
          error: DeployFailure,
        })
      )
      .add(
        HttpApiEndpoint.post("merge", "/deployments/merge", {
          payload: MergeRequest,
          success: DeploymentResponse,
          error: [MergeRejected, DeployFailure],
        })
      )
      .add(
        HttpApiEndpoint.put("rename", "/deployments/:deploymentId/name", {
          params: Schema.Struct({ deploymentId: DeploymentId }),
          payload: Schema.Struct({ displayName: DisplayName }),
          success: Schema.Struct({ displayName: DisplayName }),
          error: [DeploymentNotFound, DeployFailure],
        })
      )
      .add(
        HttpApiEndpoint.get("list", "/deployments", {
          success: HttpApiSchema.WithHeaders(DeploymentStatuses, {
            "cache-control": Schema.Literal("no-store"),
          }),
          error: DeployFailure,
        })
      )
      .prefix(API_PATH)
  );
