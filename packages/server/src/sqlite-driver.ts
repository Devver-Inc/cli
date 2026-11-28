import { Effect, Layer } from "effect";
import type { SqlClient } from "effect/sql";

// A build defines the runtime so its offline server bundles only that driver.
declare const DEVVER_NODE_SQLITE: boolean;
const useNodeSqlite =
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Build-only constant is absent when the server runs from source.
  typeof DEVVER_NODE_SQLITE === "boolean"
    ? DEVVER_NODE_SQLITE
    : process.versions.bun === undefined;

export interface SqliteJournalOptions {
  readonly filename: string;
  readonly disableWAL: boolean;
  readonly busyTimeout: number;
}

export const sqliteClientLayer = (
  options: SqliteJournalOptions
): Layer.Layer<SqlClient.SqlClient> =>
  Layer.unwrap(
    Effect.promise(async () =>
      useNodeSqlite
        ? (await import("@effect/sql-sqlite-node/SqliteClient")).layer(options)
        : (await import("@effect/sql-sqlite-bun/SqliteClient")).layer(options)
    )
  );
