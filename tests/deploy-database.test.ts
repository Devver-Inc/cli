import { expect, test } from "bun:test";

import { Effect, Schema } from "effect";

import { ApiClient, ApiError } from "../packages/cli/src/api/client";
import { GetProjectSchema } from "../packages/cli/src/api/projects.requests";
import { resolveDbLinks } from "../packages/cli/src/cli/deploy";

const project = Schema.decodeSync(GetProjectSchema)({
  id: "p1",
  name: "demo",
  description: null,
  organizationId: "org1",
  createdBy: null,
  machineConfiguration: { cpuCores: 0.5, ram: 0.5 },
  teamMembers: [],
  overlayAccessControl: { commentPermission: "team_only" },
  databaseConfiguration: { type: "mongo", enabled: true },
  createdAt: new Date(),
  updatedAt: new Date(),
});

test("database listing failure aborts deploy link resolution", async () => {
  const client = ApiClient.of({
    get: (path, schema) =>
      path.endsWith("/mongo/databases")
        ? Effect.fail(
            new ApiError({ status: 503, message: "Database list unavailable" })
          )
        : Schema.decodeEffect(schema)(project),
    post: () => Effect.die(new Error("Unexpected POST")),
    put: () => Effect.die(new Error("Unexpected PUT")),
    delete: () => Effect.die(new Error("Unexpected DELETE")),
  });
  const result = await Effect.runPromise(
    resolveDbLinks("p1").pipe(
      Effect.provideService(ApiClient, client),
      Effect.result
    )
  );
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "ApiError", status: 503 },
  });
});
