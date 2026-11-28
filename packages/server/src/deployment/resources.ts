import { join } from "node:path";

import { Context, Effect, Layer, Option, RcMap, Schema } from "effect";
import type { Scope } from "effect";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import type { ConstraintDecoder, Json, JsonObject } from "effect/Schema";

import {
  EngineOperationError,
  openResourceEngine,
  ProviderFailure,
} from "../../engine";
import type {
  EngineError,
  EngineTeardownRefusal,
  ProviderCall,
  ResourceDeclaration,
  ResourceEngine,
} from "../../engine";
import { DeployFailure } from "../api";
import { DeploymentHost } from "../deployment-host";
import type { HostService } from "../deployment-host";
import { DeploymentStore } from "../deployment-store";
import type { StoreService } from "../deployment-store";
import { Git, gitFailureFor } from "../git-source";
import type { GitFailure, GitService } from "../git-source";
import { InstanceDirectory } from "../instance-directory";
import type { InstanceDirectoryService } from "../instance-directory";
import { restorePrivateDirectory } from "../private-state";
import type { StaticDeploymentTarget } from "./create";
import { DeploymentStartupError, hostFailure, SAFE_DETAIL } from "./failures";
import { reachable } from "./readiness";
import { DeployStageSchema } from "./record";
import {
  specificationOf,
  DeploymentSpecificationSchema,
} from "./specification";
import type { DeploymentSpecification } from "./specification";
import { deploymentTypeFor, prepareWorkload, DeploymentType } from "./type";

type Spawner = Effect.Success<typeof ChildProcessSpawner>;
type HttpService = Effect.Success<typeof HttpClient.HttpClient>;

export const WorkspaceId = "workspace";
export const HostedWorkloadId = "hosted-workload";

// One resource engine per deployment: engines own one owner-only journal per
// deployment id, and the RcMap shares an opened engine among the workflow
// body, restart reconciliation and cleanup. A scope close releases only the
// engine's owner token; worktrees, journals and store rows are durable state
// that only an explicit teardown removes.
export interface EnginesService {
  readonly for: (
    deploymentId: string
  ) => Effect.Effect<ResourceEngine, EngineError, Scope.Scope>;
}

export const Engines = Context.Service<EnginesService>("devver/server/Engines");

const journalsDirectory = (instanceDirectory: string) =>
  join(instanceDirectory, "resource-journals");

const providerFailed = (failure: DeployFailure) =>
  new ProviderFailure({
    message: "the deployment resource could not be prepared",
    detail: { stage: failure.stage, message: failure.message },
  });

const providerInvalid = () =>
  new ProviderFailure({
    message: "the recorded deployment resource is not usable",
  });

const serverFailure = () =>
  new DeployFailure({
    stage: "server",
    message: "server: the deployment could not be completed",
  });

const EngineDetail = Schema.Struct({
  stage: DeployStageSchema,
  message: Schema.String,
});

const decodeDetail = Schema.decodeUnknownOption(EngineDetail);

export const deployFailureOf = (error: EngineError): DeployFailure =>
  error instanceof EngineOperationError
    ? Option.match(decodeDetail(error.detail ?? null), {
        onNone: () => serverFailure(),
        onSome: (detail) =>
          new DeployFailure({
            stage: detail.stage,
            message: detail.message,
          }),
      })
    : serverFailure();

const WorkspaceInputs = Schema.Struct({
  deploymentId: Schema.String,
  repositoryId: Schema.String,
  commit: Schema.String,
  source: Schema.NullOr(Schema.String),
});

const HostedWorkloadInputs = Schema.Struct({
  deploymentId: Schema.String,
  repositoryId: Schema.String,
  commit: Schema.String,
  worktree: Schema.String,
});

const decodeSpecification = Schema.decodeUnknownOption(
  DeploymentSpecificationSchema
);

const withSpawner = <A, E, R>(
  spawner: Spawner,
  effect: Effect.Effect<A, E, R | ChildProcessSpawner>
): Effect.Effect<A, E, Exclude<R, ChildProcessSpawner>> =>
  Effect.provideService(effect, ChildProcessSpawner, spawner);

const withClient = <A, E, R>(
  client: HttpService,
  effect: Effect.Effect<A, E, R | HttpClient.HttpClient>
): Effect.Effect<A, E, Exclude<R, HttpClient.HttpClient>> =>
  Effect.provideService(effect, HttpClient.HttpClient, client);

// The journal's persisted inputs parsed at this trust boundary; invalid
// records fail closed instead of guessing a shape.
const decodeInputs = <S extends ConstraintDecoder<unknown>>(
  schema: S,
  inputs: Json
): Effect.Effect<S["Type"], ProviderFailure> =>
  Effect.fromOption(Schema.decodeOption(schema)(inputs)).pipe(
    Effect.mapError(() => providerInvalid())
  );

const gitOfDeploy = (error: GitFailure) =>
  providerFailed(gitFailureFor("git")(error));

// The Schema encoder can leave explicit undefined optionals behind, which
// the engine journal's JsonObject cannot store; parsing the encoded JSON
// text through the JsonObject schema is the validated value it persists.
const encodedSpecification = Schema.decodeSync(
  Schema.fromJsonString(Schema.JsonObject)
);

const encodeSpecificationJson = (
  specification: DeploymentSpecification
): JsonObject =>
  encodedSpecification(
    JSON.stringify(
      Schema.encodeSync(DeploymentSpecificationSchema)(specification)
    )
  );

interface ProviderDeps {
  readonly git: GitService;
  readonly host: HostService;
  readonly store: StoreService;
  readonly spawner: Spawner;
  readonly client: HttpService;
  readonly worktrees: string;
}

const deploymentStillPreparing = (store: StoreService, deploymentId: string) =>
  Effect.gen(function* () {
    const record = yield* Effect.orDie(
      store.read(deploymentId).pipe(Effect.mapError(() => providerInvalid()))
    );
    return record?.status === "preparing";
  });

// The desired state of one deployment: a workspace checked out at the
// pinned revision, and the hosted workload that consumes its path. The
// hosted workload's input reference is what keeps removal order safe.
const workspaceProvider = (deps: ProviderDeps) => ({
  id: WorkspaceId,
  reconcile: ({ inputs, previousOutput }: ProviderCall) => {
    const step = Effect.gen(function* () {
      const input = yield* decodeInputs(WorkspaceInputs, inputs);
      const worktree = join(deps.worktrees, input.deploymentId);
      const status = yield* deps.git
        .inspectWorktree({
          repositoryId: input.repositoryId,
          worktree,
          commit: input.commit,
        })
        .pipe(Effect.mapError(gitOfDeploy));
      const intact =
        status.present && status.registered && status.checkedOutAtCommit;
      const preparing = yield* deploymentStillPreparing(
        deps.store,
        input.deploymentId
      );
      // Two-tier provenance. A workspace the engine already recorded, or
      // one whose deployment completed before the engine existed, may carry
      // legitimate tracked changes from install and build outputs, so it is
      // reused with them intact and never wiped. Only an unproven workspace
      // must still be a pristine checkout to be trusted as reusable.
      if (
        intact &&
        (status.trackedClean || previousOutput !== undefined || !preparing)
      ) {
        return { path: worktree };
      }
      // An existing tree without intact provenance fails closed: recorded
      // workspaces and completed deployments are never destructively
      // repaired here.
      if (status.present && (previousOutput !== undefined || !preparing)) {
        return yield* providerFailed(
          new DeployFailure({
            stage: "git",
            message: "git: the recorded deployment workspace cannot be reused",
          })
        );
      }
      // An absent path is a fresh acquisition. An unusable one can only be
      // this deployment's own interrupted acquisition — the path is
      // exclusive to the deployment, the engine never recorded it, and the
      // store still marks the deployment preparing — so it is repaired by
      // re-preparing, never by wiping a recorded workspace.
      yield* deps.git
        .prepareWorktree({
          repositoryId: input.repositoryId,
          deploymentId: input.deploymentId,
          commit: input.commit,
          source: input.source,
        })
        .pipe(Effect.mapError(gitOfDeploy));
      return { path: worktree };
    });
    return withSpawner(deps.spawner, step);
  },
  remove: ({ inputs }: ProviderCall) => {
    const step = Effect.gen(function* () {
      const input = yield* decodeInputs(WorkspaceInputs, inputs);
      yield* deps.git
        .removeWorktree(
          input.repositoryId,
          join(deps.worktrees, input.deploymentId)
        )
        .pipe(Effect.mapError(gitOfDeploy));
      yield* deps.git
        .removeDeploymentRef(input.repositoryId, input.deploymentId)
        .pipe(Effect.mapError(gitOfDeploy));
    });
    return withSpawner(deps.spawner, step);
  },
});

const resolveSpecification = (
  deps: ProviderDeps,
  repositoryId: string,
  commit: string
) =>
  Effect.gen(function* () {
    const committed = yield* deps.git
      .committedFile(repositoryId, commit, ".devver.yaml")
      .pipe(
        Effect.mapError((error) =>
          providerFailed(
            error.message !== "" && SAFE_DETAIL.test(error.message)
              ? new DeployFailure({
                  stage: "config",
                  message: `config: ${error.message}`,
                })
              : new DeployFailure({
                  stage: "config",
                  message:
                    "config: the committed configuration could not be read",
                })
          )
        )
      );
    const specification = specificationOf(committed);
    return specification instanceof DeployFailure
      ? yield* providerFailed(specification)
      : specification;
  });

const specificationStoreFailure = () =>
  providerFailed(
    new DeployFailure({
      stage: "config",
      message:
        "config: the recorded deployment specification could not be used",
    })
  );

const hostedWorkloadProvider = (deps: ProviderDeps) => ({
  id: HostedWorkloadId,
  reconcile: ({ inputs, previousOutput }: ProviderCall) => {
    const step = Effect.gen(function* () {
      const input = yield* decodeInputs(HostedWorkloadInputs, inputs);
      let specification = yield* deps.store
        .readSpecification(input.deploymentId)
        .pipe(Effect.mapError(specificationStoreFailure));
      if (specification === undefined) {
        const resolved =
          previousOutput === undefined
            ? yield* resolveSpecification(
                deps,
                input.repositoryId,
                input.commit
              )
            : yield* Effect.suspend(() =>
                decodeSpecification(previousOutput.specification ?? null).pipe(
                  Effect.fromOption,
                  Effect.mapError(() => providerInvalid())
                )
              );
        specification = yield* deps.store
          .recordSpecification(input.deploymentId, resolved)
          .pipe(Effect.mapError(specificationStoreFailure));
      }
      const slot = yield* deps.host
        .reserve(input.deploymentId)
        .pipe(
          Effect.mapError((error) =>
            providerFailed(hostFailure("config")(error))
          )
        );
      const prepared = yield* prepareWorkload(specification, {
        ...slot,
        worktree: input.worktree,
      }).pipe(
        Effect.provideService(
          DeploymentType,
          deploymentTypeFor(specification.kind)
        ),
        Effect.mapError(providerFailed)
      );
      yield* Effect.uninterruptible(
        deps.host
          .publish(input.deploymentId, prepared)
          .pipe(
            Effect.mapError((error) =>
              providerFailed(hostFailure("process")(error))
            )
          )
      );
      yield* reachable(deps.host.url(input.deploymentId)).pipe(
        Effect.mapError(providerFailed)
      );
      return {
        url: deps.host.url(input.deploymentId),
        // Schema encoding can leave explicit undefined optionals, which the
        // engine journal's JsonObject cannot store; the JSON round-trip
        // produces the exact JSON value it persists.
        // oxlint-disable-next-line unicorn/prefer-structured-clone -- structuredClone preserves undefined-valued keys; the journal needs them dropped.
        specification: encodeSpecificationJson(specification),
      };
    });
    return withClient(deps.client, withSpawner(deps.spawner, step));
  },
  remove: ({ inputs }: ProviderCall) => {
    const step = Effect.gen(function* () {
      const input = yield* decodeInputs(HostedWorkloadInputs, inputs);
      yield* deps.host.withdraw(input.deploymentId);
    });
    return withClient(deps.client, withSpawner(deps.spawner, step));
  },
});

const providersFor = (deps: ProviderDeps) => [
  workspaceProvider(deps),
  hostedWorkloadProvider(deps),
];

export const enginesLayer: Layer.Layer<
  EnginesService,
  DeploymentStartupError,
  | GitService
  | HostService
  | StoreService
  | ChildProcessSpawner
  | HttpClient.HttpClient
  | InstanceDirectoryService
> = Layer.effect(
  Engines,
  Effect.gen(function* () {
    const instance = yield* InstanceDirectory;
    yield* Effect.tryPromise({
      try: async () => {
        await restorePrivateDirectory(journalsDirectory(instance.directory));
      },
      catch: () =>
        new DeploymentStartupError({
          message: "The deployment resource journals could not be opened",
        }),
    });
    const git = yield* Git;
    const host = yield* DeploymentHost;
    const store = yield* DeploymentStore;
    const spawner = yield* ChildProcessSpawner;
    const client = yield* HttpClient.HttpClient;
    const providers = providersFor({
      git,
      host,
      store,
      spawner,
      client,
      worktrees: instance.worktrees,
    });
    const leases = yield* RcMap.make<
      string,
      ResourceEngine,
      EngineError,
      Scope.Scope
    >({
      lookup: (deploymentId) =>
        openResourceEngine({
          path: join(
            journalsDirectory(instance.directory),
            `${deploymentId}.sqlite`
          ),
          providers,
          concurrency: 1,
        }),
    });
    return { for: (deploymentId) => RcMap.get(leases, deploymentId) };
  })
);

// Providers author their failures as deployment-staged details, sanitized at
// construction; the engine stores the JSON opaquely and this seam maps it
// back without coupling the generic engine to deployment stages.
export const deploymentResources = (
  target: StaticDeploymentTarget
): readonly ResourceDeclaration[] => [
  {
    id: WorkspaceId,
    provider: WorkspaceId,
    protection: "delete",
    inputs: {
      deploymentId: target.deploymentId,
      repositoryId: target.repositoryId,
      commit: target.commit,
      source: target.originKind === "checkout" ? target.originPath : null,
    },
  },
  {
    id: HostedWorkloadId,
    provider: HostedWorkloadId,
    protection: "delete",
    inputs: {
      deploymentId: target.deploymentId,
      repositoryId: target.repositoryId,
      commit: target.commit,
      worktree: { $ref: WorkspaceId, output: "path" },
    },
  },
];

const unknownAlone = (refusal: EngineTeardownRefusal, id: string) =>
  refusal.reason === "unknown-id" &&
  refusal.ids.length === 1 &&
  refusal.ids[0] === id;

// Ordered removal of one deployment's resources. An unknown id is exactly
// that resource's legacy or never-recorded state, so only that resource
// falls back to its idempotent physical cleanup; every other refusal,
// corrupted journal or busy owner surfaces instead of bypassing the
// engine. The workload is removed before the workspace it consumed.
export const destroyDeployment =
  (deps: {
    readonly engines: EnginesService;
    readonly git: GitService;
    readonly host: HostService;
  }) =>
  (input: {
    readonly deploymentId: string;
    readonly repositoryId: string;
    readonly worktree: string;
  }) =>
    Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.flatMap(deps.engines.for(input.deploymentId), (engine) =>
          engine.teardown([HostedWorkloadId])
        )
      ).pipe(
        Effect.catchTag("EngineTeardownRefusal", (refusal) =>
          unknownAlone(refusal, HostedWorkloadId)
            ? deps.host.withdraw(input.deploymentId)
            : Effect.fail(refusal)
        )
      );
      yield* Effect.scoped(
        Effect.flatMap(deps.engines.for(input.deploymentId), (engine) =>
          engine.teardown([WorkspaceId])
        )
      ).pipe(
        Effect.catchTag("EngineTeardownRefusal", (refusal) =>
          unknownAlone(refusal, WorkspaceId)
            ? Effect.gen(function* () {
                // The legacy physical cleanup mirrors the pre-engine
                // behavior: best-effort removal that keeps converging.
                yield* Effect.ignore(
                  deps.git.removeWorktree(input.repositoryId, input.worktree)
                );
                yield* Effect.ignore(
                  deps.git.removeDeploymentRef(
                    input.repositoryId,
                    input.deploymentId
                  )
                );
              })
            : Effect.fail(refusal)
        )
      );
    });
