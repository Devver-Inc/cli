import { Effect } from "effect";
import { HttpApiBuilder, HttpApiSchema } from "effect/http-api";

import pkg from "../../../package.json" with { type: "json" };
import {
  api,
  CONTROL_PROTOCOL_VERSION,
  DeployFailure,
  DeploymentNotFound,
  MergeRejected,
} from "./api";
import { Deployments } from "./deploy";
import type { loadInstance } from "./identity";

type Instance = Awaited<ReturnType<typeof loadInstance>>;

const serverFailure = (message: string) =>
  new DeployFailure({ stage: "server", message });

export const instanceHandlers = (instance: Instance) =>
  HttpApiBuilder.group(api, "instance", (handlers) =>
    handlers.handle("identity", () =>
      Effect.succeed(
        HttpApiSchema.withHeaders({
          body: {
            instanceId: instance.instanceId,
            name: instance.name,
            serverVersion: pkg.version,
            controlProtocolVersion: CONTROL_PROTOCOL_VERSION,
          },
          headers: { "cache-control": "no-store" as const },
        })
      )
    )
  );

// The handlers consume the deployment service through their effect's
// requirements, so the server edge composes its layers once instead of
// passing a constructed value.
export const deploymentHandlers = HttpApiBuilder.group(
  api,
  "deployments",
  (handlers) =>
    handlers
      .handle("create", ({ payload }) =>
        Effect.flatMap(Deployments, (deployments) =>
          deployments
            .deploy(payload)
            .pipe(
              Effect.mapError((error) =>
                error instanceof DeployFailure
                  ? error
                  : serverFailure(
                      "server: the deployment could not be completed"
                    )
              )
            )
        )
      )
      .handle("merge", ({ payload }) =>
        Effect.flatMap(Deployments, (deployments) =>
          deployments
            .merge(payload.firstDeploymentId, payload.secondDeploymentId)
            .pipe(
              Effect.mapError((error) =>
                error instanceof MergeRejected || error instanceof DeployFailure
                  ? error
                  : serverFailure(
                      "server: the deployment merge could not be completed"
                    )
              )
            )
        )
      )
      .handle("rename", ({ params, payload }) =>
        Effect.flatMap(Deployments, (deployments) =>
          deployments.rename(params.deploymentId, payload.displayName).pipe(
            Effect.flatMap((found) =>
              found
                ? Effect.succeed({ displayName: payload.displayName })
                : Effect.fail(
                    new DeploymentNotFound({ message: "Deployment not found" })
                  )
            ),
            Effect.mapError((error) =>
              error instanceof DeploymentNotFound
                ? error
                : serverFailure("server: deployment name could not be saved")
            )
          )
        )
      )
      .handle("list", () =>
        Effect.flatMap(Deployments, (deployments) =>
          deployments.statuses.pipe(
            Effect.map((statuses) =>
              HttpApiSchema.withHeaders({
                body: statuses,
                headers: { "cache-control": "no-store" as const },
              })
            ),
            Effect.mapError(() =>
              serverFailure("server: deployment records could not be read")
            )
          )
        )
      )
);
