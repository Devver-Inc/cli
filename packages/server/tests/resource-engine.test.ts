import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Schema } from "effect";
import type { Scope } from "effect";
import type { Json, JsonObject } from "effect/Schema";

import { openResourceEngine, ProviderFailure } from "../engine";
import type {
  EngineError,
  ProviderCall,
  ResourceDeclaration,
  ResourceEngine,
  ResourceProvider,
} from "../engine";

interface RecordedCall {
  readonly stage: "reconcile" | "remove";
  readonly id: string;
  readonly inputs: Json;
  readonly previousOutput: JsonObject | undefined;
}

interface ProviderOptions {
  readonly failWhen?: (inputs: Json) => boolean;
  readonly removeFailIds?: ReadonlySet<string>;
  readonly malformedOutputIds?: ReadonlySet<string>;
}

const makeProvider = (options: ProviderOptions = {}) => {
  const calls: RecordedCall[] = [];
  const provider: ResourceProvider = {
    id: "test",
    reconcile: (call) =>
      Effect.gen(function* () {
        calls.push({ stage: "reconcile", ...call });
        if (options.failWhen?.(call.inputs) === true) {
          return yield* new ProviderFailure({ message: "provider failed" });
        }
        if (options.malformedOutputIds?.has(call.id) === true) {
          const malformed: unknown = JSON.parse('["not-an-object"]');
          return malformed;
        }
        return { file: `resources/${call.id}.txt` };
      }),
    remove: (call) =>
      Effect.gen(function* () {
        calls.push({ stage: "remove", ...call });
        if (options.removeFailIds?.has(call.id) === true) {
          return yield* new ProviderFailure({ message: "remove failed" });
        }
        return undefined;
      }),
  };
  return { provider, calls };
};

const otherProvider: ResourceProvider = {
  id: "other",
  reconcile: () => Effect.succeed({ kind: "other" }),
  remove: () => Effect.void,
};

const declaration = (
  id: string,
  inputs: Json,
  protection: "delete" | "retain" = "delete",
  provider = "test"
): ResourceDeclaration => ({ id, provider, inputs, protection });

const tempDir = () => mkdtempSync(join(tmpdir(), "devver-engine-"));

const asRecord = (value: unknown): value is Record<string, Json> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sabotage = (call: ProviderCall): void => {
  const previous: unknown = call.previousOutput;
  if (asRecord(previous)) {
    previous.file = "MUTATED";
  }
  const inputs: unknown = call.inputs;
  if (asRecord(inputs)) {
    const database: unknown = inputs.database;
    if (database !== undefined && asRecord(database)) {
      database.file = "MUTATED";
    }
  }
};

const journalPath = (dir: string) => join(dir, "journal.sqlite");

const withEngine = async <T, E = EngineError>(
  dir: string,
  providers: readonly ResourceProvider[],
  use: (engine: ResourceEngine) => Effect.Effect<T, E, Scope.Scope>,
  concurrency = 4
): Promise<T> =>
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const engine = yield* openResourceEngine({
          path: journalPath(dir),
          providers,
          concurrency,
        });
        return yield* use(engine);
      })
    )
  );

const failureOf = async (
  promise: Promise<unknown>
): Promise<Error | undefined> => {
  try {
    await promise;
    return undefined;
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
};

const JournalRowSchema = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  dependencies: Schema.String,
  output: Schema.NullOr(Schema.String),
  inputs: Schema.String,
  protection: Schema.String,
});

interface JournalRow {
  id: string;
  status: string;
  dependencies: string;
  output: string | null;
  inputs: string;
  protection: string;
}

const journalRows = (dir: string): JournalRow[] => {
  const database = new Database(journalPath(dir), { readonly: true });
  try {
    const rows = database
      .query<unknown, []>(
        "SELECT id, status, dependencies, output, inputs, protection FROM resources ORDER BY id"
      )
      .all();
    return rows.map((row) => Schema.decodeUnknownSync(JournalRowSchema)(row));
  } finally {
    database.close();
  }
};

const rowOf = (dir: string, id: string): JournalRow | undefined =>
  journalRows(dir).find((row) => row.id === id);

const DependenciesText = Schema.fromJsonString(Schema.Array(Schema.String));

const dependenciesOf = (row: JournalRow | undefined): readonly string[] =>
  row === undefined
    ? []
    : Schema.decodeSync(DependenciesText)(row.dependencies);

const tagOf = (error: EngineError): string => error._tag;

describe("resource engine", () => {
  test("applies a referenced graph in dependency order and wires outputs literally", async () => {
    const dir = tempDir();
    const { provider, calls } = makeProvider();
    const result = await withEngine(dir, [provider], (engine) =>
      engine.apply({
        resources: [
          declaration("database", { engine: "postgres" }),
          declaration("backend", { database: { $ref: "database" } }),
          declaration("frontend", {
            backendFile: { $ref: "backend", output: "file" },
          }),
        ],
      })
    );
    expect(result.resources.map((resource) => resource.id)).toEqual([
      "database",
      "backend",
      "frontend",
    ]);
    expect(calls.map((call) => call.id)).toEqual([
      "database",
      "backend",
      "frontend",
    ]);
    const backend = calls.find((call) => call.id === "backend");
    expect(backend?.inputs).toEqual({
      database: { file: "resources/database.txt" },
    });
    const frontend = calls.find((call) => call.id === "frontend");
    expect(frontend?.inputs).toEqual({ backendFile: "resources/backend.txt" });
    expect(result.resources[2]?.output).toEqual({
      file: "resources/frontend.txt",
    });
  });

  test("bounds concurrent reconciliation to the configured limit", async () => {
    const dir = tempDir();
    let inFlight = 0;
    let maxInFlight = 0;
    const provider: ResourceProvider = {
      id: "test",
      reconcile: (call) =>
        Effect.gen(function* () {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          yield* Effect.sleep(40);
          inFlight -= 1;
          return { id: call.id };
        }),
      remove: () => Effect.void,
    };
    const result = await withEngine(
      dir,
      [provider],
      (engine) =>
        engine.apply({
          resources: [
            declaration("one", {}),
            declaration("two", {}),
            declaration("three", {}),
            declaration("four", {}),
          ],
        }),
      2
    );
    expect(result.resources).toHaveLength(4);
    expect(maxInFlight).toBe(2);
  });

  test("rejects an invalid graph before any provider effect", async () => {
    const dir = tempDir();
    const { provider, calls } = makeProvider();
    const failure = await failureOf(
      withEngine(dir, [provider], (engine) =>
        engine.apply({
          resources: [
            declaration("a", { b: { $ref: "b" } }),
            declaration("b", { a: { $ref: "a" } }),
          ],
        })
      )
    );
    expect(failure).toMatchObject({
      _tag: "EngineValidationError",
      reason: "cycle",
    });
    expect(calls).toHaveLength(0);
    expect(journalRows(dir)).toHaveLength(0);
  });

  test("blocks consumers after a failure and reports the failed stage", async () => {
    const dir = tempDir();
    const { provider, calls } = makeProvider({
      failWhen: (inputs) =>
        JSON.stringify(inputs) ===
        JSON.stringify({ database: { file: "resources/database.txt" } }),
    });
    const failure = await failureOf(
      withEngine(dir, [provider], (engine) =>
        engine.apply({
          resources: [
            declaration("database", {}),
            declaration("backend", { database: { $ref: "database" } }),
            declaration("frontend", { backend: { $ref: "backend" } }),
          ],
        })
      )
    );
    expect(failure).toMatchObject({
      _tag: "EngineOperationError",
      id: "backend",
      stage: "reconcile",
    });
    expect(calls.map((call) => call.id)).toEqual(["database", "backend"]);
    expect(rowOf(dir, "database")?.status).toBe("ready");
    expect(rowOf(dir, "backend")?.status).toBe("pending");
    expect(rowOf(dir, "frontend")).toBeUndefined();
  });

  test("reconciles idempotently on rerun without duplicating resources", async () => {
    const dir = tempDir();
    const { provider, calls } = makeProvider();
    const result = await withEngine(dir, [provider], (engine) =>
      Effect.gen(function* () {
        const graph = [declaration("database", { engine: "postgres" })];
        yield* engine.apply({ resources: graph });
        return yield* engine.apply({ resources: graph });
      })
    );
    expect(result.resources).toHaveLength(1);
    expect(calls).toHaveLength(2);
    const rows = journalRows(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("ready");
  });

  test("retains the previous output through a failed update and hands it back", async () => {
    const dir = tempDir();
    let failOnSecondVersion = true;
    const { provider, calls } = makeProvider({
      failWhen: (inputs) =>
        failOnSecondVersion && JSON.stringify(inputs) === '{"version":2}',
    });
    const failed = await withEngine(dir, [provider], (engine) =>
      Effect.flip(
        Effect.gen(function* () {
          yield* engine.apply({
            resources: [declaration("app", { version: 1 })],
          });
          return yield* engine.apply({
            resources: [declaration("app", { version: 2 })],
          });
        })
      )
    );
    expect(failed).toMatchObject({
      _tag: "EngineOperationError",
      id: "app",
    });
    expect(rowOf(dir, "app")?.status).toBe("pending");
    expect(JSON.parse(rowOf(dir, "app")?.output ?? "null")).toEqual({
      file: "resources/app.txt",
    });
    failOnSecondVersion = false;
    await withEngine(dir, [provider], (engine) =>
      engine.apply({ resources: [declaration("app", { version: 2 })] })
    );
    const lastCall = calls.at(-1);
    expect(lastCall?.previousOutput).toEqual({ file: "resources/app.txt" });
    expect(rowOf(dir, "app")?.status).toBe("ready");
  });

  test("keeps the union of old and new dependencies until an update succeeds", async () => {
    const dir = tempDir();
    let failOnRewire = true;
    const { provider } = makeProvider({
      failWhen: (inputs) =>
        failOnRewire &&
        JSON.stringify(inputs) ===
          JSON.stringify({ database: { file: "resources/database-two.txt" } }),
    });
    const outcome = await withEngine(dir, [provider], (engine) =>
      Effect.gen(function* () {
        yield* engine.apply({
          resources: [
            declaration("database-one", {}),
            declaration("backend", { database: { $ref: "database-one" } }),
          ],
        });
        const failed = yield* Effect.flip(
          engine.apply({
            resources: [
              declaration("database-two", {}),
              declaration("backend", { database: { $ref: "database-two" } }),
            ],
          })
        );
        const union = dependenciesOf(rowOf(dir, "backend"));
        const refusal = yield* Effect.flip(engine.teardown(["database-one"]));
        failOnRewire = false;
        yield* engine.apply({
          resources: [
            declaration("database-two", {}),
            declaration("backend", { database: { $ref: "database-two" } }),
          ],
        });
        const removed = yield* engine.teardown(["database-one"]);
        return { failed, refusal, removed, union };
      })
    );
    expect(tagOf(outcome.failed)).toBe("EngineOperationError");
    expect(outcome.union).toEqual(["database-one", "database-two"]);
    expect(tagOf(outcome.refusal)).toBe("EngineTeardownRefusal");
    expect(outcome.refusal).toMatchObject({
      reason: "in-use",
      ids: ["database-one"],
    });
    expect(dependenciesOf(rowOf(dir, "backend"))).toEqual(["database-two"]);
    expect(outcome.removed.removed).toEqual(["database-one"]);
  });

  test("fails closed for a corrupt journal without leaking its content", async () => {
    const dir = tempDir();
    const { provider, calls } = makeProvider();
    await withEngine(dir, [provider], (engine) =>
      engine.apply({
        resources: [declaration("database", { secret: "hunter2" })],
      })
    );
    const corrupt = new Database(journalPath(dir));
    try {
      corrupt.run(
        "UPDATE resources SET status = 'corrupt-status' WHERE id = 'database'"
      );
    } finally {
      corrupt.close();
    }
    const failure = await failureOf(
      withEngine(dir, [provider], (engine) =>
        engine.apply({
          resources: [declaration("database", { secret: "hunter2" })],
        })
      )
    );
    expect(failure).toMatchObject({
      _tag: "EngineStateError",
      message: "resource journal is unusable",
    });
    expect(failure?.message).not.toContain("corrupt-status");
    expect(failure?.message).not.toContain("hunter2");
    expect(calls).toHaveLength(1);
  });

  test("rejects a provider type change for an existing id", async () => {
    const dir = tempDir();
    const { provider, calls } = makeProvider();
    const failure = await failureOf(
      withEngine(dir, [provider, otherProvider], (engine) =>
        Effect.gen(function* () {
          yield* engine.apply({
            resources: [declaration("db", {}, "delete", "test")],
          });
          return yield* engine.apply({
            resources: [declaration("db", {}, "delete", "other")],
          });
        })
      )
    );
    expect(failure).toMatchObject({
      _tag: "EngineValidationError",
      reason: "type-change",
      id: "db",
    });
    expect(calls).toHaveLength(1);
  });

  test("refuses teardown of a protected resource", async () => {
    const dir = tempDir();
    const { provider, calls } = makeProvider();
    const refusal = await withEngine(dir, [provider], (engine) =>
      Effect.gen(function* () {
        yield* engine.apply({
          resources: [declaration("guarded", {}, "retain")],
        });
        return yield* Effect.flip(engine.teardown(["guarded"]));
      })
    );
    expect(refusal).toMatchObject({
      _tag: "EngineTeardownRefusal",
      reason: "protected",
      ids: ["guarded"],
    });
    expect(calls).toHaveLength(1);
    expect(rowOf(dir, "guarded")?.status).toBe("ready");
  });

  test("refuses an unsafe teardown set without deleting anything", async () => {
    const dir = tempDir();
    const { provider, calls } = makeProvider();
    const outcome = await withEngine(dir, [provider], (engine) =>
      Effect.gen(function* () {
        yield* engine.apply({
          resources: [
            declaration("database", {}, "retain"),
            declaration("backend", { database: { $ref: "database" } }),
            declaration("frontend", { backend: { $ref: "backend" } }, "retain"),
          ],
        });
        const protectedMember = yield* Effect.flip(
          engine.teardown(["backend", "database"])
        );
        const protectedConsumer = yield* Effect.flip(
          engine.teardown(["frontend", "backend"])
        );
        return { protectedMember, protectedConsumer };
      })
    );
    expect(outcome.protectedMember).toMatchObject({
      _tag: "EngineTeardownRefusal",
      reason: "protected",
      ids: ["database"],
    });
    expect(outcome.protectedConsumer).toMatchObject({
      _tag: "EngineTeardownRefusal",
      reason: "protected",
      ids: ["frontend"],
    });
    expect(calls.filter((call) => call.stage === "remove")).toHaveLength(0);
    for (const row of journalRows(dir)) {
      expect(row.status).toBe("ready");
    }
  });

  test("refuses teardown while an outside consumer survives", async () => {
    const dir = tempDir();
    const { provider } = makeProvider();
    const outcome = await withEngine(dir, [provider], (engine) =>
      Effect.gen(function* () {
        yield* engine.apply({
          resources: [
            declaration("database", {}),
            declaration("backend", { database: { $ref: "database" } }),
            declaration("frontend", { backend: { $ref: "backend" } }),
          ],
        });
        const refusal = yield* Effect.flip(engine.teardown(["backend"]));
        const rowsAfterRefusal = journalRows(dir).map((row) => row.id);
        const removed = yield* engine.teardown(["frontend", "backend"]);
        const database = yield* engine.teardown(["database"]);
        return { refusal, rowsAfterRefusal, removed, database };
      })
    );
    expect(outcome.refusal).toMatchObject({
      _tag: "EngineTeardownRefusal",
      reason: "in-use",
      ids: ["backend"],
    });
    expect(outcome.rowsAfterRefusal).toEqual([
      "backend",
      "database",
      "frontend",
    ]);
    expect(outcome.removed.removed).toEqual(["frontend", "backend"]);
    expect(outcome.database.removed).toEqual(["database"]);
    expect(journalRows(dir)).toHaveLength(0);
  });

  test("stops teardown at a failed remove and keeps deleting state retryable", async () => {
    const dir = tempDir();
    const removeFailures = new Set(["backend"]);
    const { provider, calls } = makeProvider({
      removeFailIds: removeFailures,
    });
    const failure = await failureOf(
      withEngine(dir, [provider], (engine) =>
        Effect.gen(function* () {
          yield* engine.apply({
            resources: [
              declaration("database", {}),
              declaration("backend", { database: { $ref: "database" } }),
              declaration("frontend", { backend: { $ref: "backend" } }),
            ],
          });
          return yield* engine.teardown(["frontend", "backend", "database"]);
        })
      )
    );
    expect(failure).toMatchObject({
      _tag: "EngineOperationError",
      id: "backend",
      stage: "remove",
    });
    expect(rowOf(dir, "frontend")).toBeUndefined();
    expect(rowOf(dir, "backend")?.status).toBe("deleting");
    expect(rowOf(dir, "database")?.status).toBe("deleting");
    const refusedApply = await failureOf(
      withEngine(dir, [provider], (engine) =>
        engine.apply({
          resources: [
            declaration("backend", { database: { $ref: "database" } }),
          ],
        })
      )
    );
    expect(refusedApply).toMatchObject({
      _tag: "EngineValidationError",
      reason: "deleting-resource",
      id: "backend",
    });
    removeFailures.clear();
    const retry = await withEngine(dir, [provider], (engine) =>
      engine.teardown(["frontend", "backend", "database"])
    );
    expect(retry.removed).toEqual(["backend", "database"]);
    expect(journalRows(dir)).toHaveLength(0);
    const again = await withEngine(dir, [provider], (engine) =>
      engine.teardown(["frontend", "backend", "database"])
    );
    expect(again.removed).toEqual([]);
    expect(
      calls.filter((call) => call.stage === "remove").map((call) => call.id)
    ).toEqual(["frontend", "backend", "backend", "database"]);
  });

  test("validates references, inputs, providers and ids strictly", async () => {
    const dir = tempDir();
    const { provider, calls } = makeProvider();
    const cases: {
      readonly resources: readonly ResourceDeclaration[];
      readonly reason: string;
    }[] = [
      {
        resources: [
          declaration("a", { b: { $ref: "missing" } }),
          declaration("b", {}),
        ],
        reason: "missing-dependency",
      },
      {
        resources: [
          declaration("a", { b: { $ref: "b", extra: 1 } }),
          declaration("b", {}),
        ],
        reason: "invalid-reference",
      },
      {
        resources: [
          declaration(
            "a",
            Schema.decodeUnknownSync(Schema.Json)(
              JSON.parse('{"__proto__": {"x": 1}}')
            )
          ),
        ],
        reason: "invalid-inputs",
      },
      {
        resources: [declaration("a", {}, "delete", "unknown-provider")],
        reason: "unknown-provider",
      },
      {
        resources: [declaration("a", {}), declaration("a", {})],
        reason: "duplicate-id",
      },
    ];
    for (const testCase of cases) {
      const failure = await failureOf(
        withEngine(dir, [provider], (engine) =>
          engine.apply({ resources: testCase.resources })
        )
      );
      expect(failure).toMatchObject({
        _tag: "EngineValidationError",
        reason: testCase.reason,
      });
    }
    expect(calls).toHaveLength(0);
    expect(journalRows(dir)).toHaveLength(0);
  });

  test("fails safely on malformed provider output and provider defects", async () => {
    const dir = tempDir();
    const { provider } = makeProvider({
      malformedOutputIds: new Set(["malformed"]),
    });
    const throwing: ResourceProvider = {
      id: "throwing",
      reconcile: () =>
        Effect.sync(() => {
          throw new Error("provider exploded with secret-token");
        }),
      remove: () => Effect.void,
    };
    const malformed = await failureOf(
      withEngine(dir, [provider], (engine) =>
        engine.apply({ resources: [declaration("malformed", {})] })
      )
    );
    expect(malformed).toMatchObject({
      _tag: "EngineOperationError",
      id: "malformed",
      stage: "reconcile",
    });
    expect(malformed?.message).not.toContain("not-an-object");
    expect(rowOf(dir, "malformed")?.status).toBe("pending");
    const defect = await failureOf(
      withEngine(dir, [provider, throwing], (engine) =>
        engine.apply({
          resources: [declaration("boom", {}, "delete", "throwing")],
        })
      )
    );
    expect(defect).toMatchObject({
      _tag: "EngineOperationError",
      id: "boom",
      stage: "reconcile",
    });
    expect(defect?.message).not.toContain("secret-token");
  });

  test("fails safely when a provider function throws synchronously", async () => {
    const dir = tempDir();
    const { provider } = makeProvider();
    const syncThrowing: ResourceProvider = {
      id: "sync-throwing",
      reconcile: () => {
        throw new Error("sync-reconcile-secret");
      },
      remove: () => Effect.void,
    };
    const removeThrowing: ResourceProvider = {
      id: "remove-throwing",
      reconcile: () => Effect.succeed({ kind: "fine" }),
      remove: () => {
        throw new Error("sync-remove-secret");
      },
    };
    const reconcileFailure = await failureOf(
      withEngine(dir, [provider, syncThrowing], (engine) =>
        engine.apply({
          resources: [declaration("boom", {}, "delete", "sync-throwing")],
        })
      )
    );
    expect(reconcileFailure).toMatchObject({
      _tag: "EngineOperationError",
      id: "boom",
      stage: "reconcile",
    });
    expect(reconcileFailure?.message).not.toContain("sync-reconcile-secret");
    expect(rowOf(dir, "boom")?.status).toBe("pending");
    const removeFailure = await failureOf(
      withEngine(dir, [provider, removeThrowing], (engine) =>
        Effect.gen(function* () {
          yield* engine.apply({
            resources: [declaration("victim", {}, "delete", "remove-throwing")],
          });
          return yield* engine.teardown(["victim"]);
        })
      )
    );
    expect(removeFailure).toMatchObject({
      _tag: "EngineOperationError",
      id: "victim",
      stage: "remove",
    });
    expect(removeFailure?.message).not.toContain("sync-remove-secret");
  });

  test("rejects unknown and duplicate teardown ids", async () => {
    const dir = tempDir();
    const { provider } = makeProvider();
    const outcome = await withEngine(dir, [provider], (engine) =>
      Effect.gen(function* () {
        yield* engine.apply({
          resources: [declaration("database", {})],
        });
        const invalid = yield* Effect.flip(
          engine.teardown(["../secrets/hunter2", "database"])
        );
        const unknown = yield* Effect.flip(engine.teardown(["nope"]));
        const duplicate = yield* Effect.flip(
          engine.teardown(["database", "database"])
        );
        return { invalid, unknown, duplicate };
      })
    );
    expect(outcome.invalid).toMatchObject({
      _tag: "EngineTeardownRefusal",
      reason: "invalid-id",
      ids: [],
    });
    expect(JSON.stringify(outcome.invalid)).not.toContain("hunter2");
    expect(outcome.unknown).toMatchObject({
      _tag: "EngineTeardownRefusal",
      reason: "unknown-id",
      ids: ["nope"],
    });
    expect(outcome.duplicate).toMatchObject({
      _tag: "EngineTeardownRefusal",
      reason: "duplicate-id",
      ids: ["database"],
    });
    expect(rowOf(dir, "database")?.status).toBe("ready");
  });

  test("rejects invalid concurrency and duplicate providers at open", async () => {
    const dir = tempDir();
    const { provider } = makeProvider();
    const concurrency = await failureOf(
      Effect.runPromise(
        Effect.scoped(
          openResourceEngine({
            path: journalPath(dir),
            providers: [provider],
            concurrency: 0,
          })
        )
      )
    );
    expect(concurrency).toMatchObject({
      _tag: "EngineValidationError",
      reason: "invalid-concurrency",
    });
    const duplicate = await failureOf(
      Effect.runPromise(
        Effect.scoped(
          openResourceEngine({
            path: journalPath(dir),
            providers: [provider, provider],
            concurrency: 4,
          })
        )
      )
    );
    expect(duplicate).toMatchObject({
      _tag: "EngineValidationError",
      reason: "duplicate-provider",
    });
  });

  test("preserves retain protection through a failed update and installs the requested policy on success", async () => {
    const dir = tempDir();
    let failDowngrade = true;
    const { provider } = makeProvider({
      failWhen: (inputs) =>
        failDowngrade && JSON.stringify(inputs) === '{"version":2}',
    });
    const outcome = await withEngine(dir, [provider], (engine) =>
      Effect.gen(function* () {
        yield* engine.apply({
          resources: [declaration("guarded", { version: 1 }, "retain")],
        });
        const failed = yield* Effect.flip(
          engine.apply({
            resources: [declaration("guarded", { version: 2 }, "delete")],
          })
        );
        const refused = yield* Effect.flip(engine.teardown(["guarded"]));
        failDowngrade = false;
        yield* engine.apply({
          resources: [declaration("guarded", { version: 2 }, "delete")],
        });
        const removed = yield* engine.teardown(["guarded"]);
        return { failed, refused, removed };
      })
    );
    expect(tagOf(outcome.failed)).toBe("EngineOperationError");
    expect(outcome.refused).toMatchObject({
      _tag: "EngineTeardownRefusal",
      reason: "protected",
      ids: ["guarded"],
    });
    expect(outcome.removed.removed).toEqual(["guarded"]);
  });

  test("clones provider call data and outputs so providers cannot mutate engine state", async () => {
    const dir = tempDir();
    const calls: RecordedCall[] = [];
    let failMutatingUpdate = true;
    const provider: ResourceProvider = {
      id: "test",
      reconcile: (call) =>
        Effect.gen(function* () {
          calls.push({
            stage: "reconcile",
            id: call.id,
            inputs: structuredClone(call.inputs),
            previousOutput:
              call.previousOutput === undefined
                ? undefined
                : structuredClone(call.previousOutput),
          });
          sabotage(call);
          if (
            call.previousOutput !== undefined &&
            failMutatingUpdate &&
            JSON.stringify(call.inputs) === '{"version":2}'
          ) {
            return yield* new ProviderFailure({ message: "provider failed" });
          }
          return { file: `resources/${call.id}.txt` };
        }),
      remove: () => Effect.void,
    };
    const outcome = await withEngine(dir, [provider], (engine) =>
      Effect.gen(function* () {
        yield* engine.apply({ resources: [declaration("database", {})] });
        return yield* engine.apply({
          resources: [
            declaration("backend", { database: { $ref: "database" } }),
            declaration("sibling", {
              database: { $ref: "database" },
              backend: { $ref: "backend" },
            }),
          ],
        });
      })
    );
    const pristine = { file: "resources/database.txt" };
    expect(calls.find((call) => call.id === "sibling")?.inputs).toEqual({
      database: pristine,
      backend: { file: "resources/backend.txt" },
    });
    expect(outcome.resources.map((resource) => resource.output)).toEqual([
      { file: "resources/backend.txt" },
      { file: "resources/sibling.txt" },
    ]);
    expect(JSON.parse(rowOf(dir, "sibling")?.inputs ?? "null")).toEqual({
      database: pristine,
      backend: { file: "resources/backend.txt" },
    });
    const failedUpdate = await failureOf(
      withEngine(dir, [provider], (engine) =>
        engine.apply({
          resources: [declaration("database", { version: 2 })],
        })
      )
    );
    expect(failedUpdate).toMatchObject({
      _tag: "EngineOperationError",
      id: "database",
    });
    expect(JSON.parse(rowOf(dir, "database")?.output ?? "null")).toEqual(
      pristine
    );
    failMutatingUpdate = false;
    const consumer = await withEngine(dir, [provider], (engine) =>
      Effect.gen(function* () {
        yield* engine.apply({
          resources: [declaration("database", { version: 2 })],
        });
        return yield* engine.apply({
          resources: [
            declaration("consumer", { database: { $ref: "database" } }),
          ],
        });
      })
    );
    expect(consumer.resources[0]?.output).toEqual({
      file: "resources/consumer.txt",
    });
    expect(calls.find((call) => call.id === "consumer")?.inputs).toEqual({
      database: pristine,
    });
  });

  test("refuses a consumer of a pending dependency until its update succeeds", async () => {
    const dir = tempDir();
    let failUpdate = true;
    const { provider, calls } = makeProvider({
      failWhen: (inputs) =>
        failUpdate && JSON.stringify(inputs) === '{"version":2}',
    });
    const failed = await failureOf(
      withEngine(dir, [provider], (engine) =>
        Effect.gen(function* () {
          yield* engine.apply({
            resources: [declaration("dep", { version: 1 })],
          });
          return yield* engine.apply({
            resources: [declaration("dep", { version: 2 })],
          });
        })
      )
    );
    expect(failed).toMatchObject({
      _tag: "EngineOperationError",
      id: "dep",
    });
    expect(rowOf(dir, "dep")?.status).toBe("pending");
    const refused = await failureOf(
      withEngine(dir, [provider], (engine) =>
        engine.apply({
          resources: [declaration("consumer", { dep: { $ref: "dep" } })],
        })
      )
    );
    expect(refused).toMatchObject({
      _tag: "EngineValidationError",
      reason: "unresolved-reference",
      id: "dep",
    });
    expect(calls.filter((call) => call.id === "consumer")).toHaveLength(0);
    expect(rowOf(dir, "consumer")).toBeUndefined();
    failUpdate = false;
    const recovered = await withEngine(dir, [provider], (engine) =>
      Effect.gen(function* () {
        yield* engine.apply({
          resources: [declaration("dep", { version: 2 })],
        });
        return yield* engine.apply({
          resources: [declaration("consumer", { dep: { $ref: "dep" } })],
        });
      })
    );
    expect(recovered.resources.map((resource) => resource.id)).toEqual([
      "consumer",
    ]);
  });

  test("rejects a persisted reference with an unknown output key before any effect", async () => {
    const dir = tempDir();
    const { provider, calls } = makeProvider();
    const failure = await failureOf(
      withEngine(dir, [provider], (engine) =>
        Effect.gen(function* () {
          yield* engine.apply({ resources: [declaration("base", {})] });
          return yield* engine.apply({
            resources: [
              declaration("sibling", {}),
              declaration("consumer", {
                base: { $ref: "base", output: "no-such-key" },
              }),
            ],
          });
        })
      )
    );
    expect(failure).toMatchObject({
      _tag: "EngineValidationError",
      reason: "invalid-reference",
      id: "consumer",
    });
    expect(calls.map((call) => call.id)).toEqual(["base"]);
    expect(rowOf(dir, "sibling")).toBeUndefined();
    const valid = await withEngine(dir, [provider], (engine) =>
      engine.apply({
        resources: [
          declaration("consumer", { base: { $ref: "base", output: "file" } }),
        ],
      })
    );
    expect(valid.resources[0]?.output).toEqual({
      file: "resources/consumer.txt",
    });
    expect(calls.find((call) => call.id === "consumer")?.inputs).toEqual({
      base: "resources/base.txt",
    });
  });

  test("releases the writer on clean close and reopens the same journal", async () => {
    const dir = tempDir();
    const { provider, calls } = makeProvider();
    await withEngine(dir, [provider], (engine) =>
      engine.apply({ resources: [declaration("database", {})] })
    );
    const reopened = await withEngine(dir, [provider], (engine) =>
      engine.apply({ resources: [declaration("database", {})] })
    );
    expect(reopened.resources.map((resource) => resource.id)).toEqual([
      "database",
    ]);
    expect(calls).toHaveLength(2);
  });

  test("fails closed on a corrupt persisted dependency cycle before any remove", async () => {
    const dir = tempDir();
    const { provider, calls } = makeProvider();
    await withEngine(dir, [provider], (engine) =>
      engine.apply({
        resources: [declaration("one", {}), declaration("two", {})],
      })
    );
    const corrupt = new Database(journalPath(dir));
    try {
      corrupt.run(
        "UPDATE resources SET dependencies = '[\"two\"]' WHERE id = 'one'"
      );
      corrupt.run(
        "UPDATE resources SET dependencies = '[\"one\"]' WHERE id = 'two'"
      );
    } finally {
      corrupt.close();
    }
    const failure = await failureOf(
      withEngine(dir, [provider], (engine) => engine.teardown(["one", "two"]))
    );
    expect(failure).toMatchObject({
      _tag: "EngineStateError",
      message: "resource journal is unusable",
    });
    expect(calls.filter((call) => call.stage === "remove")).toHaveLength(0);
    expect(journalRows(dir).map((row) => row.id)).toEqual(["one", "two"]);
  });

  test("serializes concurrent operations and rejects a second writer", async () => {
    const dir = tempDir();
    const { provider } = makeProvider();
    const outcome = await withEngine(dir, [provider], (engine) =>
      Effect.gen(function* () {
        const both = yield* Effect.all([
          engine.apply({ resources: [declaration("one", {})] }),
          engine.apply({ resources: [declaration("two", {})] }),
        ]);
        const busy = yield* Effect.flip(
          openResourceEngine({
            path: journalPath(dir),
            providers: [provider],
            concurrency: 4,
          })
        );
        return { both, busy };
      })
    );
    expect(
      outcome.both.map((result) => result.resources.map((r) => r.id))
    ).toEqual([["one"], ["two"]]);
    expect(journalRows(dir).map((row) => row.id)).toEqual(["one", "two"]);
    expect(outcome.busy).toMatchObject({ _tag: "EngineBusyError" });
  });
});
