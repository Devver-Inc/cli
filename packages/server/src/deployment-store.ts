import { Context, Data, Effect, Exit, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";

import type {
  DeployStage,
  Deployment,
  NewDeployment,
} from "./deployment/record";
import { DeploymentSchema, NewDeploymentSchema } from "./deployment/record";
import { privateFile } from "./private-state";

const PortSchema = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: 65_535 })
);

const APP_PORT = "appPort";

class DeploymentStoreError extends Data.TaggedError("DeploymentStoreError")<{
  message: string;
}> {}

// A build defines the runtime so its offline server bundles only that driver.
declare const DEVVER_NODE_SQLITE: boolean;
const useNodeSqlite =
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Build-only constant is absent when the server runs from source.
  typeof DEVVER_NODE_SQLITE === "boolean"
    ? DEVVER_NODE_SQLITE
    : process.versions.bun === undefined;

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
    const sql = useNodeSqlite
      ? yield* Effect.gen(function* () {
          const { layer } = yield* Effect.promise(
            async () => await import("@effect/sql-sqlite-node/SqliteClient")
          );
          const context = yield* Layer.build(
            layer({ filename: path, disableWAL: true, busyTimeout: 0 })
          );
          return Context.get(context, SqlClient.SqlClient);
        })
      : yield* Effect.gen(function* () {
          const { layer } = yield* Effect.promise(
            async () => await import("@effect/sql-sqlite-bun/SqliteClient")
          );
          const context = yield* Layer.build(
            layer({ filename: path, disableWAL: true, busyTimeout: 0 })
          );
          return Context.get(context, SqlClient.SqlClient);
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
      secondParentDeploymentId, worktree, status, stage, displayName, createdAt FROM deployments`;
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
            (deploymentId, repositoryId, commitSha, parentDeploymentId, secondParentDeploymentId, worktree, status, stage, createdAt)
            VALUES (${deployment.deploymentId}, ${deployment.repositoryId}, ${deployment.commit},
              ${deployment.parentDeploymentId}, ${deployment.secondParentDeploymentId}, ${deployment.worktree}, 'preparing', NULL, ${new Date().toISOString()})`;
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
