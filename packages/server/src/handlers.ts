import { Effect } from "effect";
import { HttpApiBuilder, HttpApiSchema } from "effect/http-api";

import pkg from "../../../package.json" with { type: "json" };
import { api, CONTROL_PROTOCOL_VERSION, DeployFailure } from "./api";
import type { openDeployer } from "./deploy";
import type { loadInstance } from "./identity";

type Instance = Awaited<ReturnType<typeof loadInstance>>;
type Deployer = Awaited<ReturnType<typeof openDeployer>>;

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
    handlers.handle("create", ({ payload }) =>
      Effect.tryPromise({
        try: async () => deployer.deploy(payload),
        catch: (error) =>
          error instanceof DeployFailure
            ? error
            : new DeployFailure({
                stage: "server",
                message: "server: the deployment could not be completed",
              }),
      })
    )
  );
