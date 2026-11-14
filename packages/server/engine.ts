import { Effect, Schema, Semaphore } from "effect";
import type { Scope } from "effect";
import type { JsonObject } from "effect/Schema";

import {
  EngineOperationError,
  EngineStateError,
  EngineTeardownRefusal,
  EngineValidationError,
  refusalMessage,
  validationMessage,
} from "./src/engine/errors";
import type {
  EngineError,
  TeardownRefusalReason,
  ValidationReason,
} from "./src/engine/errors";
import {
  deletionOrder,
  planApply,
  resolveInputs,
  ResourceDeclarationSchema,
  ResourceIdSchema,
  resourceIdPattern,
} from "./src/engine/graph";
import type {
  PersistedResource,
  ResourceDeclaration,
} from "./src/engine/graph";
import { openJournal } from "./src/engine/journal";
import type { ResourceJournal } from "./src/engine/journal";
import type { ResourceProvider } from "./src/engine/provider";

export {
  EngineBusyError,
  EngineOperationError,
  EngineStateError,
  EngineTeardownRefusal,
  EngineValidationError,
} from "./src/engine/errors";
export type {
  EngineError,
  TeardownRefusalReason,
  ValidationReason,
} from "./src/engine/errors";
export type { ResourceDeclaration } from "./src/engine/graph";
export { ResourceDeclarationSchema } from "./src/engine/graph";
export { ProviderFailure } from "./src/engine/provider";
export type { ProviderCall, ResourceProvider } from "./src/engine/provider";

const ConcurrencySchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: 64 })
);

export interface OpenResourceEngineOptions {
  readonly path: string;
  readonly providers: readonly ResourceProvider[];
  readonly concurrency: number;
}

export interface AppliedResource {
  readonly id: string;
  readonly output: JsonObject;
}

export interface ApplyResult {
  readonly resources: readonly AppliedResource[];
}

export interface TeardownResult {
  readonly removed: readonly string[];
}

export interface ResourceEngine {
  readonly apply: (request: {
    readonly resources: readonly ResourceDeclaration[];
  }) => Effect.Effect<ApplyResult, EngineError>;
  readonly teardown: (
    ids: readonly string[]
  ) => Effect.Effect<TeardownResult, EngineError>;
}

const invalid = (reason: ValidationReason, id?: string) =>
  new EngineValidationError({
    reason,
    id,
    message: validationMessage(reason),
  });

const operationFailure = (id: string, stage: "reconcile" | "remove") =>
  new EngineOperationError({
    id,
    stage,
    message:
      stage === "reconcile"
        ? "resource reconcile failed"
        : "resource remove failed",
  });

const cloneOutput = (
  output: JsonObject | null | undefined
): JsonObject | undefined =>
  output === undefined || output === null ? undefined : structuredClone(output);

const refusal = (reason: TeardownRefusalReason, ids: readonly string[]) =>
  new EngineTeardownRefusal({
    reason,
    ids,
    message: refusalMessage(reason),
  });

const decodeDeclarations = (resources: readonly ResourceDeclaration[]) =>
  Schema.decodeEffect(Schema.Array(ResourceDeclarationSchema))(resources).pipe(
    Effect.mapError(() => invalid("invalid-declaration"))
  );

export const openResourceEngine = (
  options: OpenResourceEngineOptions
): Effect.Effect<ResourceEngine, EngineError, Scope.Scope> =>
  Effect.gen(function* () {
    const concurrency = yield* Schema.decodeEffect(ConcurrencySchema)(
      options.concurrency
    ).pipe(Effect.mapError(() => invalid("invalid-concurrency")));

    const providers = new Map<string, ResourceProvider>();
    for (const provider of options.providers) {
      if (!resourceIdPattern.test(provider.id)) {
        return yield* invalid("invalid-provider");
      }
      if (providers.has(provider.id)) {
        return yield* invalid("duplicate-provider", provider.id);
      }
      providers.set(provider.id, provider);
    }

    const journal: ResourceJournal = yield* openJournal(options.path);
    const writer = yield* Semaphore.make(1);

    const reconcile = (
      declaration: ResourceDeclaration,
      state: ReadonlyMap<string, PersistedResource>,
      dependencies: readonly string[],
      outputs: Map<string, JsonObject>,
      externalOutputs: ReadonlyMap<string, JsonObject>
    ) =>
      Effect.gen(function* () {
        const previous: PersistedResource | undefined = state.get(
          declaration.id
        );
        const resolved = resolveInputs(
          declaration.inputs,
          outputs,
          externalOutputs
        );
        if (!resolved.ok) {
          return yield* invalid("invalid-reference", declaration.id);
        }
        const provider = providers.get(declaration.provider);
        if (provider === undefined) {
          return yield* invalid("unknown-provider", declaration.id);
        }
        yield* journal.checkpointPending({
          id: declaration.id,
          provider: declaration.provider,
          protection:
            previous?.protection === "retain" ||
            declaration.protection === "retain"
              ? "retain"
              : "delete",
          inputs: resolved.value,
          dependencies:
            previous === undefined
              ? dependencies
              : [...new Set([...previous.dependencies, ...dependencies])],
          output: previous?.output ?? null,
        });
        const stored = yield* Effect.suspend(() =>
          provider.reconcile({
            id: declaration.id,
            inputs: structuredClone(resolved.value),
            previousOutput: cloneOutput(previous?.output),
          })
        ).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.JsonObject)),
          Effect.map((output) => structuredClone(output)),
          Effect.mapError(() => operationFailure(declaration.id, "reconcile")),
          Effect.catchDefect(() =>
            operationFailure(declaration.id, "reconcile")
          )
        );
        yield* journal.markReady({
          id: declaration.id,
          output: stored,
          dependencies,
          protection: declaration.protection,
        });
        outputs.set(declaration.id, stored);
        return { id: declaration.id, output: stored };
      });

    const apply: ResourceEngine["apply"] = (request) =>
      writer.withPermits(1)(
        Effect.gen(function* () {
          const declarations = yield* decodeDeclarations(request.resources);
          const state = yield* journal.readAll;
          const planning = planApply(
            declarations,
            new Set(providers.keys()),
            state.rows
          );
          if (!planning.ok) {
            return yield* invalid(planning.reason, planning.id);
          }
          const outputs = new Map<string, JsonObject>();
          const externalOutputs = new Map<string, JsonObject>();
          for (const [id, row] of state.rows) {
            if (row.output !== null) {
              externalOutputs.set(id, row.output);
            }
          }
          const applied: AppliedResource[] = [];
          for (const level of planning.plan.levels) {
            const reconciled = yield* Effect.forEach(
              level,
              (declaration) =>
                reconcile(
                  declaration,
                  state.rows,
                  planning.plan.dependencies.get(declaration.id) ?? [],
                  outputs,
                  externalOutputs
                ),
              { concurrency }
            );
            for (const resource of reconciled) {
              applied.push(resource);
            }
          }
          const order = new Map(
            declarations.map((declaration, index) => [declaration.id, index])
          );
          return {
            resources: [...applied].toSorted(
              (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)
            ),
          };
        })
      );

    const teardown: ResourceEngine["teardown"] = (ids) =>
      writer.withPermits(1)(
        Effect.gen(function* () {
          const requested = yield* Schema.decodeEffect(
            Schema.Array(ResourceIdSchema)
          )(ids).pipe(Effect.mapError(() => refusal("invalid-id", [])));
          const seen = new Set<string>();
          for (const id of requested) {
            if (seen.has(id)) {
              return yield* refusal("duplicate-id", [id]);
            }
            seen.add(id);
          }
          const state = yield* journal.readAll;
          const unknown = requested.filter(
            (id) => !state.rows.has(id) && !state.removed.has(id)
          );
          if (unknown.length > 0) {
            return yield* refusal("unknown-id", unknown);
          }
          const members = requested.filter((id) => state.rows.has(id));
          const memberSet = new Set(members);
          const missingProvider = members.filter((id) => {
            const row = state.rows.get(id);
            return row !== undefined && !providers.has(row.provider);
          });
          if (missingProvider.length > 0) {
            return yield* refusal("missing-provider", missingProvider);
          }
          const protectedIds = members.filter((id) => {
            const row = state.rows.get(id);
            return row !== undefined && row.protection === "retain";
          });
          if (protectedIds.length > 0) {
            return yield* refusal("protected", protectedIds);
          }
          const consumed = (id: string): boolean => {
            for (const row of state.rows.values()) {
              if (!memberSet.has(row.id) && row.dependencies.includes(id)) {
                return true;
              }
            }
            return false;
          };
          const inUse = requested.filter(consumed);
          if (inUse.length > 0) {
            return yield* refusal("in-use", inUse);
          }
          const order = deletionOrder(members, state.rows);
          if (!order.ok) {
            return yield* new EngineStateError({
              message: "resource journal is unusable",
            });
          }
          yield* journal.markDeleting(members);
          const removed: string[] = [];
          for (const id of order.order) {
            const row = state.rows.get(id);
            if (row === undefined) {
              return yield* refusal("unknown-id", [id]);
            }
            const provider = providers.get(row.provider);
            if (provider === undefined) {
              return yield* refusal("missing-provider", [id]);
            }
            yield* Effect.suspend(() =>
              provider.remove({
                id,
                inputs: structuredClone(row.inputs),
                previousOutput: cloneOutput(row.output),
              })
            ).pipe(
              Effect.mapError(() => operationFailure(id, "remove")),
              Effect.catchDefect(() => operationFailure(id, "remove"))
            );
            yield* journal.removeRow(id);
            removed.push(id);
          }
          return { removed };
        })
      );

    return { apply, teardown };
  });
