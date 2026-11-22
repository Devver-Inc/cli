import { join } from "node:path";

import { NodeCrypto } from "@effect/platform-node";
import { Effect, Layer, Schema } from "effect";
import type { Scope } from "effect";
import { ClusterWorkflowEngine, SingleRunner } from "effect/cluster";
import type { ConfigError } from "effect/Config";
import { FetchHttpClient } from "effect/http";
import type { SqlError } from "effect/sql";
import { Activity, Workflow } from "effect/workflow";

import { DeployFailure } from "./api";
import type { DaemonSlot, DaemonSpec } from "./deployment-host";
import { attempt, DeploymentStartupError } from "./deployment/failures";
import { reachable } from "./deployment/readiness";
import { addWorktree, pinCommit, syncCommit } from "./git-source";
import { privateFile } from "./private-state";
import { sqliteClientLayer } from "./sqlite-driver";
import { prepareDaemon } from "./workloads";

export const StaticDeploymentTargetSchema = Schema.Struct({
  deploymentId: Schema.String.check(Schema.isUUID(4)),
  repositoryId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  commit: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u)),
  originKind: Schema.Literals(["checkout", "repository"]),
  originPath: Schema.String.check(Schema.isNonEmpty()),
});

export type StaticDeploymentTarget = typeof StaticDeploymentTargetSchema.Type;

export const staticDeploymentCreate = Workflow.make("StaticDeploymentCreate", {
  payload: StaticDeploymentTargetSchema,
  success: Schema.Struct({
    url: Schema.String.check(Schema.isNonEmpty()),
  }),
  error: DeployFailure,
  idempotencyKey: ({ deploymentId }) => deploymentId,
});

export interface StaticDeploymentRunner {
  readonly create: (
    target: StaticDeploymentTarget
  ) => Effect.Effect<{ readonly url: string }, DeployFailure>;
  readonly interrupt: (target: StaticDeploymentTarget) => Effect.Effect<void>;
}

export interface StaticDeploymentDependencies {
  readonly journalPath: string;
  readonly instanceDirectory: string;
  readonly host: {
    readonly reserve: (deploymentId: string) => Promise<DaemonSlot>;
    readonly publish: (deploymentId: string, spec: DaemonSpec) => Promise<void>;
    readonly url: (deploymentId: string) => string;
  };
  readonly markReady: (
    deploymentId: string
  ) => Effect.Effect<unknown, SqlError.SqlError>;
}

const pinnedOriginRepo = async (payload: StaticDeploymentTarget) => {
  await pinCommit(payload.originPath, payload.deploymentId, payload.commit);
  return payload.originPath;
};

const createBody = (
  dependencies: StaticDeploymentDependencies,
  payload: StaticDeploymentTarget
) =>
  Effect.gen(function* () {
    const { host, instanceDirectory, markReady } = dependencies;
    const worktrees = join(instanceDirectory, "worktrees");
    yield* Activity.make({
      name: "git",
      success: Schema.Struct({
        worktree: Schema.String.check(Schema.isNonEmpty()),
      }),
      error: DeployFailure,
      execute: attempt("git", async () => {
        const bare =
          payload.originKind === "checkout"
            ? await syncCommit({
                repositories: join(instanceDirectory, "repositories"),
                repositoryId: payload.repositoryId,
                source: payload.originPath,
                commit: payload.commit,
                deploymentId: payload.deploymentId,
              })
            : await pinnedOriginRepo(payload);
        return {
          worktree: await addWorktree({
            bare,
            worktrees,
            deploymentId: payload.deploymentId,
            commit: payload.commit,
          }),
        };
      }),
    });
    // Reserve, publish, readiness and the ready mark stay outside the memoized
    // activity so a replayed run re-establishes liveness instead of trusting
    // a recorded past.
    const worktree = join(worktrees, payload.deploymentId);
    const spec = yield* attempt("config", async () => {
      const slot = await host.reserve(payload.deploymentId);
      return await prepareDaemon({ ...slot, worktree });
    });
    yield* Effect.uninterruptible(
      attempt("process", async () => {
        await host.publish(payload.deploymentId, spec);
      })
    );
    yield* reachable(host.url(payload.deploymentId));
    yield* markReady(payload.deploymentId).pipe(Effect.orDie);
    return { url: host.url(payload.deploymentId) };
  });

export const openStaticDeploymentRunner = (
  dependencies: StaticDeploymentDependencies
): Effect.Effect<
  StaticDeploymentRunner,
  ConfigError | DeploymentStartupError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: async () => {
        await privateFile(dependencies.journalPath);
      },
      catch: () =>
        new DeploymentStartupError({
          message: "The durable deployment journal must be owner-only",
        }),
    });
    const runtime = ClusterWorkflowEngine.layer.pipe(
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
          filename: dependencies.journalPath,
          disableWAL: true,
          busyTimeout: 0,
        })
      ),
      Layer.provide(NodeCrypto.layer),
      Layer.provide(FetchHttpClient.layer)
    );
    const handler = staticDeploymentCreate.toLayer((payload) =>
      createBody(dependencies, payload)
    );
    const context = yield* Layer.build(
      handler.pipe(
        Layer.provide(FetchHttpClient.layer),
        Layer.provideMerge(runtime)
      )
    );
    return {
      create: (target) =>
        staticDeploymentCreate.execute(target).pipe(Effect.provide(context)),
      interrupt: (target) =>
        staticDeploymentCreate.executionId(target).pipe(
          Effect.flatMap((executionId) =>
            staticDeploymentCreate.interrupt(executionId)
          ),
          Effect.provide(context)
        ),
    };
  });
