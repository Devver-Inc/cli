import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { Context, Effect, Exit, Layer } from "effect";
import type { HttpClient } from "effect/http";
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import type { SchemaError } from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";
import type { WorkflowEngine } from "effect/workflow/WorkflowEngine";

import type { EngineError } from "../engine";
import { DeployFailure, MergeRejected } from "./api";
import type { DeploymentResponse } from "./api";
import {
  openDeploymentHost,
  hostService,
  DeploymentHost,
} from "./deployment-host";
import type { HostService } from "./deployment-host";
import { DeploymentStore, openDeploymentStore } from "./deployment-store";
import type { StoreService } from "./deployment-store";
import { DeploymentCreate } from "./deployment/create";
import type {
  DeploymentCreateService,
  StaticDeploymentTarget,
} from "./deployment/create";
import {
  DeploymentStartupError,
  failureStage,
  startup,
} from "./deployment/failures";
import { statusRows } from "./deployment/listing";
import { mergeDecision } from "./deployment/merge-rules";
import type { Deployment, NewDeployment } from "./deployment/record";
import {
  destroyDeployment,
  deployFailureOf,
  deploymentResources,
  Engines,
  enginesLayer as resourceEnginesLayer,
} from "./deployment/resources";
import type { EnginesService } from "./deployment/resources";
import { Git, gitFailureFor, openGit } from "./git-source";
import type { GitService } from "./git-source";
import {
  InstanceDirectory,
  instanceDirectoryLayer,
} from "./instance-directory";
import type { InstanceDirectoryService } from "./instance-directory";
import { packagedToolsDirectory } from "./packaged-tools";

// One deployment operation can surface its own typed failure and the typed
// storage or engine errors its record funnel passes through; the HTTP
// handlers render the fallback stage for the storage ones, as before.
export type DeploymentOperationFailure =
  | DeployFailure
  | EngineError
  | SchemaError
  | SqlError;

const publicResponse = (
  input: NewDeployment,
  url: string
): typeof DeploymentResponse.Type => ({
  deploymentId: input.deploymentId,
  repositoryId: input.repositoryId,
  commit: input.commit,
  parentDeploymentId: input.parentDeploymentId,
  secondParentDeploymentId: input.secondParentDeploymentId,
  url,
});

const startupError = () =>
  new DeploymentStartupError({
    message: "Deployment state could not be opened",
  });

// The instance services each own their acquisition through a layer; the
// host depends on the stored app port, and the engines depend on the Git,
// host and store capabilities, all expressed as typed requirements the
// server edge composes once.
const storeLayer = Layer.effect(
  DeploymentStore,
  Effect.flatMap(InstanceDirectory, (instance) =>
    openDeploymentStore(join(instance.directory, "deployments.sqlite")).pipe(
      Effect.mapError(() => startupError())
    )
  )
);

const hostLayer = Layer.effect(
  DeploymentHost,
  Effect.gen(function* () {
    const store = yield* DeploymentStore;
    const instance = yield* InstanceDirectory;
    const storedPort = yield* store.appPort.pipe(
      Effect.mapError(() => startupError())
    );
    const toolsDirectory = yield* startup(
      async () => await packagedToolsDirectory()
    );
    const opened = yield* Effect.acquireRelease(
      startup(
        async () =>
          await openDeploymentHost({
            toolsDirectory,
            instanceDirectory: instance.directory,
            proxyPort: storedPort,
          })
      ),
      (host) =>
        Effect.promise(async () => {
          await host.close();
        })
    );
    if (storedPort !== undefined && storedPort !== opened.proxyPort) {
      return yield* new DeploymentStartupError({
        message:
          "The saved app port is occupied; deployment URLs were not changed",
      });
    }
    return hostService(opened);
  })
);

const gitLayer = Layer.effect(
  Git,
  Effect.flatMap(InstanceDirectory, (instance) =>
    openGit({
      repositories: instance.repositories,
      worktrees: instance.worktrees,
    }).pipe(Effect.mapError(() => startupError()))
  )
);

export const instanceServicesLayer = (
  name: string
): Layer.Layer<
  | StoreService
  | HostService
  | GitService
  | EnginesService
  | InstanceDirectoryService,
  DeploymentStartupError,
  ChildProcessSpawner | HttpClient.HttpClient
> => {
  const directory = instanceDirectoryLayer(name);
  const stores = storeLayer.pipe(Layer.provide(directory));
  const hosts = hostLayer.pipe(Layer.provide(stores), Layer.provide(directory));
  const gits = gitLayer.pipe(Layer.provide(directory));
  const engines = resourceEnginesLayer.pipe(
    Layer.provide(gits),
    Layer.provide(hosts),
    Layer.provide(stores),
    Layer.provide(directory)
  );
  return Layer.mergeAll(directory, stores, hosts, gits, engines);
};

export interface DeploymentsService {
  readonly deploy: (input: {
    readonly source: string;
    readonly commit: string;
  }) => Effect.Effect<
    typeof DeploymentResponse.Type,
    DeploymentOperationFailure,
    WorkflowEngine | ChildProcessSpawner
  >;
  readonly merge: (
    firstDeploymentId: string,
    secondDeploymentId: string
  ) => Effect.Effect<
    typeof DeploymentResponse.Type,
    MergeRejected | DeploymentOperationFailure,
    WorkflowEngine | ChildProcessSpawner
  >;
  readonly statuses: Effect.Effect<
    ReturnType<typeof statusRows>,
    DeployFailure | SchemaError | SqlError,
    ChildProcessSpawner
  >;
  readonly rename: (
    deploymentId: string,
    displayName: string
  ) => Effect.Effect<boolean, DeploymentStartupError>;
}

export const Deployments = Context.Service<DeploymentsService>(
  "devver/server/Deployments"
);

const storageFailure = () =>
  new DeployFailure({
    stage: "server",
    message: "server: deployment records could not be read",
  });

const unreadableStartup = (message: string) =>
  new DeploymentStartupError({ message });

// One deployment service per instance. The layer's constructor captures the
// instance capabilities through its typed requirements, runs the restart
// reconciliation, and exposes the operations the HTTP handlers consume.
export const deploymentsLayer: Layer.Layer<
  DeploymentsService,
  DeploymentStartupError,
  | StoreService
  | HostService
  | GitService
  | EnginesService
  | DeploymentCreateService
  | InstanceDirectoryService
  | ChildProcessSpawner
  | WorkflowEngine
> = Layer.effect(
  Deployments,
  Effect.gen(function* () {
    const instance = yield* InstanceDirectory;
    const store = yield* DeploymentStore;
    const git = yield* Git;
    const host = yield* DeploymentHost;
    const engines = yield* Engines;
    const durable = yield* DeploymentCreate;
    const unpublish = (deploymentId: string) => host.withdraw(deploymentId);
    const destroy = destroyDeployment({ engines, git, host });
    const appPort = yield* store.appPort.pipe(
      Effect.mapError(() => startupError())
    );

    const targetOf = (
      input:
        | NewDeployment
        | Pick<
            Deployment,
            "deploymentId" | "repositoryId" | "commit" | "source"
          >
    ): StaticDeploymentTarget => ({
      deploymentId: input.deploymentId,
      repositoryId: input.repositoryId,
      commit: input.commit,
      originKind: input.source === null ? "repository" : "checkout",
      originPath:
        input.source ??
        join(instance.repositories, `${input.repositoryId}.git`),
    });

    // The engine converges the deployment's recorded desired state:
    // one journal apply re-establishes liveness rather than trusting a
    // completed workflow's memoized success.
    const activateLive = (deployment: Deployment) =>
      Effect.scoped(
        Effect.flatMap(
          engines
            .for(deployment.deploymentId)
            .pipe(Effect.mapError(deployFailureOf)),
          (engine) =>
            engine
              .apply({
                resources: deploymentResources(targetOf(deployment)),
              })
              .pipe(Effect.mapError(deployFailureOf))
        )
      ).pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : unpublish(deployment.deploymentId)
        )
      );

    const restoreLive = (deployment: Deployment) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(activateLive(deployment));
        yield* Effect.orDie(
          Exit.isSuccess(exit)
            ? store.markReady(deployment.deploymentId)
            : store.markDegraded(deployment.deploymentId, failureStage(exit))
        );
      });

    const createDeployment = (input: NewDeployment) => {
      const target = targetOf(input);
      const { deploymentId, repositoryId, worktree } = input;
      let recorded = false;
      return Effect.gen(function* () {
        yield* store.record(input);
        recorded = true;
        const finished = yield* durable.create(target);
        return publicResponse(input, finished.url);
      }).pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit) || !recorded
            ? Effect.void
            : Effect.gen(function* () {
                // The cancelled create's run continues detached;
                // interrupting persists the durable stop and returns only
                // once the run's body has terminated, so this cleanup
                // never races a still-executing writer.
                yield* durable.interrupt(target);
                yield* destroy({
                  deploymentId,
                  repositoryId,
                  worktree,
                });
              }).pipe(
                Effect.onExit(() =>
                  store
                    .markFailed(deploymentId, failureStage(exit))
                    .pipe(Effect.ignore)
                )
              )
        )
      );
    };

    const deploy = (input: {
      readonly source: string;
      readonly commit: string;
    }) =>
      Effect.gen(function* () {
        const deploymentId = randomUUID();
        const source = yield* git
          .verifiedSource(input.source, input.commit)
          .pipe(Effect.mapError(gitFailureFor("source")));
        const worktree = join(instance.worktrees, deploymentId);
        const { deployments, unreadable } = yield* Effect.orDie(store.list);
        if (unreadable > 0) {
          return yield* storageFailure();
        }
        const parentDeploymentId = yield* git
          .firstParentDeployment(
            source.path,
            input.commit,
            deployments.filter(
              (entry) =>
                entry.repositoryId === source.repositoryId &&
                entry.status === "ready"
            )
          )
          .pipe(Effect.mapError(gitFailureFor("git")));
        const record: NewDeployment = {
          deploymentId,
          repositoryId: source.repositoryId,
          commit: input.commit,
          parentDeploymentId,
          secondParentDeploymentId: null,
          worktree,
          source: source.path,
          lifecycle: "workflow",
        };
        return yield* createDeployment(record);
      });

    const merge = (firstDeploymentId: string, secondDeploymentId: string) =>
      Effect.gen(function* () {
        const sameDeployment = firstDeploymentId === secondDeploymentId;
        const decision = mergeDecision(
          {
            id: firstDeploymentId,
            source: sameDeployment
              ? undefined
              : yield* Effect.orDie(store.read(firstDeploymentId)),
          },
          {
            id: secondDeploymentId,
            source: sameDeployment
              ? undefined
              : yield* Effect.orDie(store.read(secondDeploymentId)),
          }
        );
        if (!decision.admitted) {
          return yield* new MergeRejected({ message: decision.message });
        }
        const commit = yield* git
          .mergeCommits({
            repositoryId: decision.repositoryId,
            first: decision.firstCommit,
            second: decision.secondCommit,
          })
          .pipe(Effect.mapError(gitFailureFor("git")));
        const deploymentId = randomUUID();
        const record: NewDeployment = {
          deploymentId,
          repositoryId: decision.repositoryId,
          commit,
          parentDeploymentId: firstDeploymentId,
          secondParentDeploymentId: secondDeploymentId,
          worktree: join(instance.worktrees, deploymentId),
          source: null,
          lifecycle: "workflow",
        };
        return yield* createDeployment(record);
      });

    const statuses = Effect.gen(function* () {
      const { deployments, unreadable } = yield* store.list;
      if (unreadable !== 0) {
        return yield* storageFailure();
      }
      const subjects = yield* git.subjectsOf(deployments);
      return statusRows(deployments, subjects, host.url);
    });

    const reconcile = Effect.gen(function* () {
      const { deployments, unreadable } = yield* Effect.orDie(store.list);
      if (unreadable > 0) {
        return yield* unreadableStartup(
          "Deployment records hold entries this server cannot read; they were not replaced"
        );
      }
      const interrupted: Deployment[] = [];
      for (const deployment of deployments) {
        const { deploymentId, status } = deployment;
        if (status === "failed" || status === "degraded") {
          continue;
        }
        if (status === "preparing") {
          if (deployment.lifecycle !== "workflow") {
            yield* unpublish(deploymentId);
            yield* Effect.orDie(store.markDegraded(deploymentId, "server"));
            continue;
          }
          interrupted.push(deployment);
          continue;
        }
        yield* unpublish(deploymentId);
        yield* restoreLive(deployment);
      }
      for (const deployment of interrupted) {
        // Re-running the create replays or resumes the recorded workflow;
        // its cleanup marks the deployment failed when resuming is not
        // possible.
        yield* Effect.exit(createDeployment(deployment));
        const resumed = yield* Effect.orDie(
          store.read(deployment.deploymentId)
        );
        if (resumed?.status === "preparing") {
          // The recorded run had already completed, so re-running it
          // returns without re-publishing; liveness has to be
          // re-established here.
          yield* restoreLive(deployment);
        }
      }
      return undefined;
    });
    yield* Effect.uninterruptible(reconcile);
    if (appPort === undefined) {
      yield* store
        .setAppPort(host.proxyPort)
        .pipe(Effect.mapError(() => startupError()));
    }
    return {
      deploy,
      merge,
      statuses,
      rename: (deploymentId: string, displayName: string) =>
        store
          .rename(deploymentId, displayName)
          .pipe(Effect.mapError(() => startupError())),
    };
  }).pipe(
    Effect.mapError((error): DeploymentStartupError =>
      error instanceof DeploymentStartupError ? error : startupError()
    )
  )
);
