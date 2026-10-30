import { Effect } from "effect";
import { HttpApiBuilder, HttpApiSchema } from "effect/http-api";

import pkg from "../../../package.json" with { type: "json" };
import {
  api,
  CONTROL_PROTOCOL_VERSION,
  DeployFailure,
  DeploymentNotFound,
} from "./api";
import type { openDeployer } from "./deploy";
import type { loadInstance } from "./identity";

type Instance = Awaited<ReturnType<typeof loadInstance>>;
type Deployer = Effect.Success<ReturnType<typeof openDeployer>>;

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

export const deploymentHandlers = (deployer: Deployer) =>
  HttpApiBuilder.group(api, "deployments", (handlers) =>
    handlers
      .handle("create", ({ payload }) =>
        deployer.deploy(payload).pipe(
          Effect.mapError((error) =>
            error instanceof DeployFailure
              ? error
              : new DeployFailure({
                  stage: "server",
                  message: "server: the deployment could not be completed",
                })
          )
        )
      )
      .handle("rename", ({ params, payload }) =>
        deployer.rename(params.deploymentId, payload.displayName).pipe(
          Effect.flatMap((found) =>
            found
              ? Effect.succeed({ displayName: payload.displayName })
              : new DeploymentNotFound({ message: "Deployment not found" })
          ),
          Effect.mapError((error) =>
            error instanceof DeploymentNotFound
              ? error
              : new DeployFailure({
                  stage: "server",
                  message: "server: deployment name could not be saved",
                })
          )
        )
      )
      .handle("list", () =>
        deployer.statuses.pipe(
          Effect.map((statuses) =>
            HttpApiSchema.withHeaders({
              body: statuses,
              headers: { "cache-control": "no-store" as const },
            })
          ),
          Effect.mapError(
            () =>
              new DeployFailure({
                stage: "server",
                message: "server: deployment records could not be read",
              })
          )
        )
      )
  );
