import { Schema } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
} from "effect/http-api";

import { DeployStageSchema } from "./deployment/record";
import {
  DeployRequest,
  DeploymentId,
  DeploymentResponse,
  DeploymentStatuses,
  DisplayName,
  IdentityResponse,
  MergeRequest,
  RenameResponse,
} from "./protocol";

export { CONTROL_PROTOCOL_VERSION } from "./protocol";

export const API_PATH = "/api/v1";

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
          success: RenameResponse,
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
