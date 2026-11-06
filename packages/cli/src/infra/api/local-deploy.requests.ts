import { Effect, Schema } from "effect";

import {
  DeployRequest,
  DeploymentResponse,
  DeploymentStatuses,
  RenameResponse,
} from "../../../../server/protocol";
import type { Deployment, DeploymentStatus } from "../../../../server/protocol";
import { ApiClient } from "./client";

export type LocalDeploymentStatus = DeploymentStatus;
export type LocalDeployment = Deployment;

export const listLocalDeployments = Effect.gen(function* () {
  const api = yield* ApiClient;
  return yield* api.get("/deployments", DeploymentStatuses);
});

export const mergeLocalDeployments = (
  firstDeploymentId: string,
  secondDeploymentId: string
) =>
  Effect.gen(function* () {
    const api = yield* ApiClient;
    return yield* api.post(
      "/deployments/merge",
      { firstDeploymentId, secondDeploymentId },
      DeploymentResponse
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

const encodeRequest = Schema.encodeUnknownSync(DeployRequest);

export const createLocalDeployment = (body: typeof DeployRequest.Type) =>
  Effect.gen(function* () {
    const api = yield* ApiClient;
    return yield* api.post(
      "/deployments",
      encodeRequest(body),
      DeploymentResponse
    );
  });
