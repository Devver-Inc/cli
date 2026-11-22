import { Context, Data, Effect, Exit, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";

import type {
  DeployStage,
  Deployment,
  NewDeployment,
} from "./deployment/record";
import { DeploymentSchema, NewDeploymentSchema } from "./deployment/record";
import { privateFile } from "./private-state";
import { sqliteClientLayer } from "./sqlite-driver";

const PortSchema = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: 65_535 })
);

const APP_PORT = "appPort";

class DeploymentStoreError extends Data.TaggedError("DeploymentStoreError")<{
  message: string;
}> {}

export const openDeploymentStore = (path: string) =>
  Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: async () => {
        await privateFile(path);
      },
      catch: () =>
        new DeploymentStoreError({
          message: "Deployment records must be owner-only",
        }),
    });
    const sql = yield* Effect.gen(function* () {
      const context = yield* Effect.exit(
        Layer.build(
          sqliteClientLayer({
            filename: path,
            disableWAL: true,
            busyTimeout: 0,
          })
        )
      );
      if (Exit.isFailure(context)) {
        return yield* new DeploymentStoreError({
          message: "Deployment records could not be opened",
        });
      }
      return Context.get(context.value, SqlClient.SqlClient);
    });
    yield* sql`CREATE TABLE IF NOT EXISTS deployments (
      deploymentId TEXT PRIMARY KEY NOT NULL,
      repositoryId TEXT NOT NULL,
      commitSha TEXT NOT NULL,
      parentDeploymentId TEXT REFERENCES deployments(deploymentId),
      worktree TEXT NOT NULL,
      status TEXT NOT NULL,
      stage TEXT,
      createdAt TEXT NOT NULL
    ) STRICT`;
    const columns = yield* Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({ name: Schema.String }))
    )(yield* sql`PRAGMA table_info(deployments)`);
    if (!columns.some((column) => column.name === "displayName")) {
      yield* sql`ALTER TABLE deployments ADD COLUMN displayName TEXT`;
    }
    if (!columns.some((column) => column.name === "source")) {
      yield* sql`ALTER TABLE deployments ADD COLUMN source TEXT`;
    }
    if (!columns.some((column) => column.name === "lifecycle")) {
      yield* sql`ALTER TABLE deployments ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'inline'`;
    }
    if (columns.some((column) => column.name === "sitePort")) {
      yield* sql`ALTER TABLE deployments DROP COLUMN sitePort`;
    }
    if (!columns.some((column) => column.name === "secondParentDeploymentId")) {
      yield* sql`ALTER TABLE deployments ADD COLUMN secondParentDeploymentId TEXT REFERENCES deployments(deploymentId)`;
    }
    yield* sql`CREATE TABLE IF NOT EXISTS instance (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    ) STRICT`;
    const select = sql`SELECT deploymentId, repositoryId, commitSha AS "commit", parentDeploymentId,
      secondParentDeploymentId, worktree, status, stage, displayName, source, lifecycle, createdAt FROM deployments`;
    const markStatus = (
      deploymentId: string,
      status: string,
      stage: DeployStage | null
    ) =>
      sql`UPDATE deployments SET status = ${status}, stage = ${stage} WHERE deploymentId = ${deploymentId}`;
    return {
      record: (input: NewDeployment) =>
        Effect.gen(function* () {
          const deployment =
            yield* Schema.decodeEffect(NewDeploymentSchema)(input);
          yield* sql`INSERT INTO deployments
            (deploymentId, repositoryId, commitSha, parentDeploymentId, secondParentDeploymentId, worktree, source, lifecycle, status, stage, createdAt)
            VALUES (${deployment.deploymentId}, ${deployment.repositoryId}, ${deployment.commit},
              ${deployment.parentDeploymentId}, ${deployment.secondParentDeploymentId}, ${deployment.worktree}, ${deployment.source}, ${deployment.lifecycle}, 'preparing', NULL, ${new Date().toISOString()})
            ON CONFLICT(deploymentId) DO NOTHING`;
        }),
      rename: (deploymentId: string, displayName: string) =>
        Effect.gen(function* () {
          const rows =
            yield* sql`UPDATE deployments SET displayName = ${displayName}
            WHERE deploymentId = ${deploymentId} RETURNING deploymentId`;
          return rows.length > 0;
        }),
      markReady: (deploymentId: string) =>
        markStatus(deploymentId, "ready", null),
      markFailed: (deploymentId: string, stage: DeployStage) =>
        markStatus(deploymentId, "failed", stage),
      markDegraded: (deploymentId: string, stage: DeployStage) =>
        markStatus(deploymentId, "degraded", stage),
      read: (deploymentId: string) =>
        Effect.gen(function* () {
          const [row] =
            yield* sql`${select} WHERE deploymentId = ${deploymentId}`;
          return row === undefined
            ? undefined
            : yield* Schema.decodeUnknownEffect(DeploymentSchema)(row);
        }),
      list: Effect.gen(function* () {
        const rows = yield* sql`${select} ORDER BY createdAt, deploymentId`;
        const deployments: Deployment[] = [];
        let unreadable = 0;
        for (const row of rows) {
          const decoded = yield* Effect.exit(
            Schema.decodeUnknownEffect(DeploymentSchema)(row)
          );
          if (Exit.isSuccess(decoded)) {
            deployments.push(decoded.value);
          } else {
            unreadable += 1;
          }
        }
        return { deployments, unreadable };
      }),
      appPort: Effect.gen(function* () {
        const [row] =
          yield* sql`SELECT value FROM instance WHERE key = ${APP_PORT}`;
        if (row === undefined) {
          return undefined;
        }
        const decoded = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ value: Schema.String })
        )(row);
        return yield* Schema.decodeEffect(PortSchema)(decoded.value);
      }),
      setAppPort: (port: number) =>
        Effect.gen(function* () {
          const value = yield* Schema.encodeUnknownEffect(PortSchema)(port);
          yield* sql`INSERT INTO instance (key, value) VALUES (${APP_PORT}, ${value})
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
        }),
    };
  });
