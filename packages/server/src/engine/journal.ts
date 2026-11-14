import { randomUUID } from "node:crypto";

import { Context, Effect, Layer, Schema } from "effect";
import type { Scope } from "effect";
import type { Json, JsonObject } from "effect/Schema";
import { SqlClient } from "effect/sql";
import { SqlError } from "effect/sql/SqlError";

import { privateFile } from "../private-state";
import { EngineBusyError, EngineStateError } from "./errors";
import type { PersistedResource } from "./graph";
import {
  ProtectionSchema,
  ResourceIdSchema,
  ResourceStatusSchema,
} from "./graph";

const InputsText = Schema.fromJsonString(Schema.Json);
const OutputText = Schema.fromJsonString(Schema.JsonObject);
const DependenciesText = Schema.fromJsonString(Schema.Array(ResourceIdSchema));

const RowSchema = Schema.Struct({
  id: ResourceIdSchema,
  provider: ResourceIdSchema,
  protection: ProtectionSchema,
  status: ResourceStatusSchema,
  inputs: InputsText,
  output: Schema.NullOr(OutputText),
  dependencies: DependenciesText,
});

const OwnerSchema = Schema.Struct({
  token: Schema.String,
  pid: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1, maximum: 2_147_483_647 })
  ),
});

const unusable = () =>
  new EngineStateError({ message: "resource journal is unusable" });

const busy = () =>
  new EngineBusyError({
    message: "another writer holds this resource journal",
  });

const write = (effect: Effect.Effect<unknown, EngineStateError | SqlError>) =>
  effect.pipe(
    Effect.asVoid,
    Effect.mapError((error) => (error instanceof SqlError ? unusable() : error))
  );

const isNoSuchProcess = (error: unknown): error is Error & { code: "ESRCH" } =>
  error instanceof Error && "code" in error && error.code === "ESRCH";

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNoSuchProcess(error);
  }
};

const connect = (path: string) =>
  Effect.gen(function* () {
    if (process.versions.bun === undefined) {
      const { layer } = yield* Effect.promise(
        async () => await import("@effect/sql-sqlite-node/SqliteClient")
      );
      const context = yield* Layer.build(
        layer({ filename: path, disableWAL: true, busyTimeout: 0 })
      );
      return Context.get(context, SqlClient.SqlClient);
    }
    const { layer } = yield* Effect.promise(
      async () => await import("@effect/sql-sqlite-bun/SqliteClient")
    );
    const context = yield* Layer.build(
      layer({ filename: path, disableWAL: true, busyTimeout: 0 })
    );
    return Context.get(context, SqlClient.SqlClient);
  });

const createTables = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql`CREATE TABLE IF NOT EXISTS resources (
      id TEXT PRIMARY KEY NOT NULL,
      provider TEXT NOT NULL,
      protection TEXT NOT NULL,
      status TEXT NOT NULL,
      inputs TEXT NOT NULL,
      output TEXT,
      dependencies TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    ) STRICT`;
    yield* sql`CREATE TABLE IF NOT EXISTS removed (
      id TEXT PRIMARY KEY NOT NULL,
      removedAt TEXT NOT NULL
    ) STRICT`;
    yield* sql`CREATE TABLE IF NOT EXISTS engine_owner (
      key INTEGER PRIMARY KEY NOT NULL,
      token TEXT NOT NULL,
      pid INTEGER NOT NULL,
      claimedAt TEXT NOT NULL
    ) STRICT`;
  });

const claimOwner = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const token = randomUUID();
    const { blocked } = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const [row] =
            yield* sql`SELECT token, pid FROM engine_owner WHERE key = 0`;
          const owner =
            row === undefined
              ? undefined
              : yield* Schema.decodeUnknownEffect(OwnerSchema)(row).pipe(
                  Effect.mapError(() => unusable())
                );
          const held =
            owner !== undefined &&
            (owner.pid === process.pid
              ? owner.token !== token
              : pidAlive(owner.pid));
          if (held) {
            return { blocked: true };
          }
          yield* sql`INSERT INTO engine_owner (key, token, pid, claimedAt)
            VALUES (0, ${token}, ${process.pid}, ${new Date().toISOString()})
            ON CONFLICT(key) DO UPDATE SET token = excluded.token,
              pid = excluded.pid, claimedAt = excluded.claimedAt`;
          return { blocked: false };
        })
      )
      .pipe(
        Effect.mapError((error) => (error instanceof SqlError ? busy() : error))
      );
    if (blocked) {
      return yield* busy();
    }
    return token;
  });

const releaseOwner = (sql: SqlClient.SqlClient, token: string) =>
  sql`DELETE FROM engine_owner WHERE key = 0 AND token = ${token}`.pipe(
    Effect.asVoid,
    Effect.mapError((error) =>
      error instanceof SqlError ? unusable() : error
    ),
    Effect.orDie
  );

export interface JournalState {
  readonly rows: ReadonlyMap<string, PersistedResource>;
  readonly removed: ReadonlySet<string>;
}

export interface PendingCheckpoint {
  readonly id: string;
  readonly provider: string;
  readonly protection: "delete" | "retain";
  readonly inputs: Json;
  readonly dependencies: readonly string[];
  readonly output: JsonObject | null;
}

export interface ResourceJournal {
  readonly readAll: Effect.Effect<JournalState, EngineStateError>;
  readonly checkpointPending: (
    checkpoint: PendingCheckpoint
  ) => Effect.Effect<void, EngineStateError>;
  readonly markReady: (input: {
    readonly id: string;
    readonly protection: "delete" | "retain";
    readonly output: JsonObject;
    readonly dependencies: readonly string[];
  }) => Effect.Effect<void, EngineStateError>;
  readonly markDeleting: (
    ids: readonly string[]
  ) => Effect.Effect<void, EngineStateError>;
  readonly removeRow: (id: string) => Effect.Effect<void, EngineStateError>;
}

const journal = (sql: SqlClient.SqlClient): ResourceJournal => ({
  readAll: Effect.gen(function* () {
    const rows = yield* sql`SELECT id, provider, protection, status,
      inputs, output, dependencies FROM resources ORDER BY id`;
    const decoded = new Map<string, PersistedResource>();
    for (const row of rows) {
      const resource = yield* Schema.decodeUnknownEffect(RowSchema)(row).pipe(
        Effect.mapError(() => unusable())
      );
      decoded.set(resource.id, resource);
    }
    const removedRows = yield* sql`SELECT id FROM removed`;
    const removed = new Set<string>();
    for (const row of removedRows) {
      const id = yield* Schema.decodeUnknownEffect(ResourceIdSchema)(
        row.id
      ).pipe(Effect.mapError(() => unusable()));
      removed.add(id);
    }
    return { rows: decoded, removed };
  }).pipe(
    Effect.mapError((error) => (error instanceof SqlError ? unusable() : error))
  ),
  checkpointPending: (checkpoint) =>
    write(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM removed WHERE id = ${checkpoint.id}`;
          yield* sql`INSERT INTO resources
            (id, provider, protection, status, inputs, output, dependencies, updatedAt)
            VALUES (${checkpoint.id}, ${checkpoint.provider}, ${checkpoint.protection},
              'pending', ${JSON.stringify(checkpoint.inputs)},
              ${checkpoint.output === null ? null : JSON.stringify(checkpoint.output)},
              ${JSON.stringify(checkpoint.dependencies)}, ${new Date().toISOString()})
            ON CONFLICT(id) DO UPDATE SET provider = excluded.provider,
              protection = excluded.protection, status = 'pending',
              inputs = excluded.inputs, output = excluded.output,
              dependencies = excluded.dependencies, updatedAt = excluded.updatedAt`;
        })
      )
    ),
  markReady: (input) =>
    write(
      sql`UPDATE resources SET status = 'ready',
        protection = ${input.protection},
        output = ${JSON.stringify(input.output)},
        dependencies = ${JSON.stringify(input.dependencies)},
        updatedAt = ${new Date().toISOString()}
        WHERE id = ${input.id}`
    ),
  markDeleting: (ids) =>
    write(
      Effect.forEach(
        ids,
        (id) =>
          sql`UPDATE resources SET status = 'deleting',
            updatedAt = ${new Date().toISOString()} WHERE id = ${id}`,
        { discard: true }
      )
    ),
  removeRow: (id) =>
    write(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM resources WHERE id = ${id}`;
          yield* sql`INSERT INTO removed (id, removedAt)
            VALUES (${id}, ${new Date().toISOString()})
            ON CONFLICT(id) DO UPDATE SET removedAt = excluded.removedAt`;
        })
      )
    ),
});

export const openJournal = (
  path: string
): Effect.Effect<
  ResourceJournal,
  EngineBusyError | EngineStateError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: async () => {
        await privateFile(path);
      },
      catch: () =>
        new EngineStateError({
          message: "resource journal path is unusable or not owner-only",
        }),
    });
    const sql = yield* connect(path).pipe(Effect.mapError(() => unusable()));
    yield* createTables(sql).pipe(Effect.mapError(() => unusable()));
    yield* Effect.acquireRelease(claimOwner(sql), (claimed) =>
      releaseOwner(sql, claimed)
    );
    return journal(sql);
  });
