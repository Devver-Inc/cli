import { join } from "node:path";

import { NodeCrypto } from "@effect/platform-node";
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Schema,
} from "effect";
import { ClusterWorkflowEngine, SingleRunner } from "effect/cluster";
import type { ConfigError } from "effect/Config";
import { FetchHttpClient } from "effect/http";
import { Workflow } from "effect/workflow";
import type { WorkflowEngine } from "effect/workflow/WorkflowEngine";

import type { EngineError } from "../../engine";
import { DeployFailure } from "../api";
import { DeploymentHost } from "../deployment-host";
import type { HostService } from "../deployment-host";
import { DeploymentStore } from "../deployment-store";
import type { StoreService } from "../deployment-store";
import { InstanceDirectory } from "../instance-directory";
import type { InstanceDirectoryService } from "../instance-directory";
import { privateFile } from "../private-state";
import { sqliteClientLayer } from "../sqlite-driver";
import { DeploymentStartupError } from "./failures";
import { deployFailureOf, deploymentResources, Engines } from "./resources";
import type { EnginesService } from "./resources";

export const StaticDeploymentTargetSchema = Schema.Struct({
  deploymentId: Schema.String.check(Schema.isUUID(4)),
  repositoryId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  commit: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u)),
  originKind: Schema.Literals(["checkout", "repository"]),
  originPath: Schema.String.check(Schema.isNonEmpty()),
});

export type StaticDeploymentTarget = typeof StaticDeploymentTargetSchema.Type;

// The workflow's runtime identity, including its name, payload schema and
// idempotency key, predates the unified lifecycle; keeping it identical lets
// in-flight executions resume across upgrades.
export const deploymentCreate = Workflow.make("StaticDeploymentCreate", {
  payload: StaticDeploymentTargetSchema,
  success: Schema.Struct({
    url: Schema.String.check(Schema.isNonEmpty()),
  }),
  error: DeployFailure,
  idempotencyKey: ({ deploymentId }) => deploymentId,
});

const WorkflowRuntime = (
  journalPath: string
): Layer.Layer<WorkflowEngine, ConfigError> =>
  ClusterWorkflowEngine.layer.pipe(
    Layer.provide(
      SingleRunner.layer({
        shardingConfig: {
          entityMessagePollInterval: 50,
          refreshAssignmentsInterval: 50,
        },
      })
    ),
    Layer.provide(
      sqliteClientLayer({
        filename: journalPath,
        disableWAL: true,
        busyTimeout: 0,
      })
    ),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(FetchHttpClient.layer)
  );

const engineFailure = (error: EngineError | DeployFailure): DeployFailure =>
  error instanceof DeployFailure ? error : deployFailureOf(error);

const storageFailure = () =>
  new DeployFailure({
    stage: "server",
    message: "server: the deployment status could not be recorded",
  });

const cancelledFailure = () =>
  new DeployFailure({
    stage: "server",
    message: "server: the deployment create was cancelled",
  });

// Cancellation ownership for one deployment create. The workflow engine's
// durable interrupt only lands at suspension points this body no longer
// reaches, activity fibers no longer run the work, and the engine has no
// gate that stops a queued run from starting, so the runner registers a
// guard when a create is requested: `cancel` signals the running body and
// the guard interrupts the cancelled body and awaits its complete unwind,
// while `stop` completes only once the body has actually terminated, so
// cleanup may withdraw and remove the worktree without racing a writer.
export interface CreateGuard {
  readonly deploymentId: string;
  readonly cancel: Deferred.Deferred<undefined>;
  readonly stop: Deferred.Deferred<undefined>;
  phase: "registered" | "claimed" | "ended";
}

export interface DeploymentGuardsService {
  readonly register: (deploymentId: string) => Effect.Effect<CreateGuard>;
  readonly claim: (deploymentId: string) => Effect.Effect<CreateGuard>;
  readonly pending: (deploymentId: string) => CreateGuard | undefined;
  readonly answeredWithoutRun: (guard: CreateGuard) => Effect.Effect<void>;
  readonly ended: (guard: CreateGuard) => Effect.Effect<void>;
  readonly releaseAll: Effect.Effect<void>;
}

export const DeploymentGuards = Context.Service<DeploymentGuardsService>(
  "devver/server/DeploymentGuards"
);

export const deploymentGuardsLayer = Layer.effect(
  DeploymentGuards,
  Effect.gen(function* () {
    const active = new Map<string, CreateGuard>();
    const stopOf = (guard: CreateGuard): Effect.Effect<void> =>
      Effect.suspend(() => {
        if (guard.phase === "ended") {
          return Effect.void;
        }
        guard.phase = "ended";
        if (active.get(guard.deploymentId) === guard) {
          active.delete(guard.deploymentId);
        }
        return Effect.asVoid(Deferred.succeed(guard.stop, undefined));
      });
    const releaseAll = Effect.suspend(() => {
      const pending = [...active.values()];
      return Effect.forEach(pending, (guard) => stopOf(guard), {
        discard: true,
      }).pipe(
        Effect.andThen(
          Effect.forEach(
            pending,
            (guard) => Effect.asVoid(Deferred.succeed(guard.cancel, undefined)),
            {
              discard: true,
            }
          )
        )
      );
    });
    yield* Effect.addFinalizer(
      () =>
        // Server shutdown interrupts normal cleanup paths; release every
        // guard waiter so an interrupt cannot block shutdown on a live body.
        releaseAll
    );
    return {
      register: (deploymentId) =>
        Effect.suspend(() => {
          const guard = active.get(deploymentId);
          if (guard !== undefined) {
            return Effect.succeed(guard);
          }
          return Effect.map(
            Effect.all({
              cancel: Deferred.make<undefined>(),
              stop: Deferred.make<undefined>(),
            }),
            (deferred) => {
              const registered: CreateGuard = {
                deploymentId,
                phase: "registered",
                ...deferred,
              };
              active.set(deploymentId, registered);
              return registered;
            }
          );
        }),
      claim: (deploymentId) =>
        Effect.suspend(() => {
          const guard = active.get(deploymentId);
          if (guard === undefined) {
            return Effect.orDie(
              Effect.map(
                Effect.all({
                  cancel: Deferred.make<undefined>(),
                  stop: Deferred.make<undefined>(),
                }),
                (deferred) => {
                  const claimed: CreateGuard = {
                    deploymentId,
                    phase: "claimed",
                    ...deferred,
                  };
                  active.set(deploymentId, claimed);
                  return claimed;
                }
              )
            );
          }
          // The engine starts a run even when a durable interrupt was
          // persisted before any body could claim, so the claimed guard is
          // how cancellation reaches such a late body.
          guard.phase = "claimed";
          return Effect.succeed(guard);
        }),
      pending: (deploymentId) => active.get(deploymentId),
      answeredWithoutRun: (guard) => stopOf(guard),
      ended: (guard) => stopOf(guard),
      releaseAll,
    };
  })
);

// A cancelled run records nothing: the engine redelivers a resultless
// interrupted run, which resurrects the deployment through replay. The
// guard therefore interrupts the cancelled body, awaits its full unwind —
// every scoped subprocess the body started is killed and awaited inside
// it — and the body completes the run durably as a typed failure.
const cancellableBody = <A, E, R>(
  guard: CreateGuard,
  body: Effect.Effect<A, E, R>
): Effect.Effect<A, E | DeployFailure, R> =>
  Effect.gen(function* () {
    const cancelled = yield* Effect.forkChild(
      Effect.as(Deferred.await(guard.cancel), "cancelled" as const)
    );
    const fiber = yield* Effect.forkChild(body);
    const first = yield* Effect.raceFirst(
      Effect.as(Fiber.await(fiber), "body" as const),
      Effect.as(Fiber.await(cancelled), "cancelled" as const)
    );
    yield* Fiber.interrupt(cancelled);
    if (first === "cancelled") {
      yield* Fiber.interrupt(fiber);
      return yield* cancelledFailure();
    }
    const exit = yield* Fiber.await(fiber);
    return yield* Exit.match(exit, {
      onSuccess: Effect.succeed,
      onFailure: Effect.failCause,
    });
  });

// A create can finish while no run body live-ran, because a recorded
// execution already held the answer. The registered guard is released then;
// a cancelled caller keeps it, because the engine still starts the queued
// detached run and cancellation must reach that body.
const answeredWithoutRun = (exit: Exit.Exit<unknown, unknown>): boolean =>
  Exit.isSuccess(exit) ||
  (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause));

const createBody = (payload: StaticDeploymentTarget) =>
  Effect.gen(function* () {
    const guards = yield* DeploymentGuards;
    const engines = yield* Engines;
    const store = yield* DeploymentStore;
    const host = yield* DeploymentHost;
    const guard = yield* guards.claim(payload.deploymentId);
    const body = Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.flatMap(engines.for(payload.deploymentId), (engine) =>
          Effect.gen(function* () {
            // Apply converges the deployment's workspace and hosted
            // workload from the pinned revision; live readiness is
            // re-established on every run instead of trusting a recorded
            // past. The workflow journal owns the operation's identity and
            // terminal result, the engine journals own what exists.
            yield* engine
              .apply({ resources: deploymentResources(payload) })
              .pipe(Effect.mapError(engineFailure));
            yield* store
              .markReady(payload.deploymentId)
              .pipe(Effect.mapError(storageFailure));
          })
        )
      ).pipe(Effect.mapError(engineFailure));
      return { url: host.url(payload.deploymentId) };
    });
    return yield* cancellableBody(guard, body).pipe(
      Effect.onExit(() => guards.ended(guard))
    );
  });

// One runner per instance: `create` requests the durable create; `interrupt`
// persists the engine's durable interrupt, then stops this process's body
// and returns only after the requested run body has terminated, so a caller
// may then withdraw and remove the deployment without racing a writer.
export interface DeploymentCreateService {
  readonly create: (
    target: StaticDeploymentTarget
  ) => Effect.Effect<{ readonly url: string }, DeployFailure, WorkflowEngine>;
  readonly interrupt: (
    target: StaticDeploymentTarget
  ) => Effect.Effect<void, never, WorkflowEngine>;
}

/**
 * @effect-expect-leaking WorkflowEngine
 */
export const DeploymentCreate = Context.Service<DeploymentCreateService>(
  "devver/server/DeploymentCreate"
);

export const deploymentCreateLayer = Layer.effect(
  DeploymentCreate,
  Effect.gen(function* () {
    const guards = yield* DeploymentGuards;
    return {
      create: (target) =>
        Effect.flatMap(
          Effect.orDie(guards.register(target.deploymentId)),
          (guard) =>
            deploymentCreate
              .execute(target)
              .pipe(
                Effect.onExit((exit) =>
                  guards.pending(target.deploymentId) === guard &&
                  answeredWithoutRun(exit)
                    ? guards.answeredWithoutRun(guard)
                    : Effect.void
                )
              )
        ),
      interrupt: (target) =>
        Effect.gen(function* () {
          const executionId = yield* deploymentCreate.executionId(target);
          yield* deploymentCreate.interrupt(executionId);
          // A recorded result means the run is terminal: its body already
          // ended and released its guard, so no live body can be waited on
          // and registering a fresh guard would only ever await a stop
          // nobody completes. A pending execution is live in this process:
          // its create registered the guard before requesting the run, and
          // that same guard is signalled and awaited, so the pre-start
          // race still lands on the one live guard.
          const recorded = yield* deploymentCreate.poll(executionId);
          if (Option.isSome(recorded)) {
            return;
          }
          const guard = yield* Effect.orDie(
            guards.register(target.deploymentId)
          );
          yield* Deferred.succeed(guard.cancel, undefined);
          yield* Deferred.await(guard.stop);
        }),
    };
  })
).pipe(Layer.provide(deploymentGuardsLayer));

// The durable create runs on the historical workflow journal under the
// historical identity; building this layer registers the runner's body with
// the composed runtime once, and its journal keeps the original owner-only
// contract.
export const deploymentWorkflowLayer: Layer.Layer<
  WorkflowEngine,
  DeploymentStartupError | ConfigError,
  | EnginesService
  | StoreService
  | HostService
  | DeploymentGuardsService
  | InstanceDirectoryService
> = Layer.effectContext(
  Effect.gen(function* () {
    const instance = yield* InstanceDirectory;
    const journalPath = join(instance.directory, "workflow.sqlite");
    yield* Effect.tryPromise({
      try: async () => {
        await privateFile(journalPath);
      },
      catch: () =>
        new DeploymentStartupError({
          message: "The durable deployment journal must be owner-only",
        }),
    });
    const registered = deploymentCreate
      .toLayer(createBody)
      .pipe(Layer.provide(FetchHttpClient.layer));
    return yield* Layer.build(
      registered.pipe(Layer.provideMerge(WorkflowRuntime(journalPath)))
    );
  })
);
