import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { Effect, Exit } from "effect";

import { DeployFailure, MergeRejected } from "./api";
import { openDeploymentHost } from "./deployment-host";
import { openDeploymentStore } from "./deployment-store";
import {
  attempt,
  DeploymentStartupError,
  failureStage,
  startup,
} from "./deployment/failures";
import { statusRows, subjectsOf } from "./deployment/listing";
import { mergeDecision } from "./deployment/merge-rules";
import { reachable } from "./deployment/readiness";
import type { Deployment, NewDeployment } from "./deployment/record";
import {
  addWorktree,
  firstParentDeployment,
  hasCommittedDevverConfig,
  mergeCommits,
  pinCommit,
  removeDeploymentRef,
  removeWorktree,
  syncCommit,
  verifiedSource,
} from "./git-source";
import { instanceParent } from "./identity";
import { packagedToolsDirectory } from "./packaged-tools";
import { openStaticDeploymentRunner } from "./static-deployment";
import type { StaticDeploymentTarget } from "./static-deployment";
import { prepareDaemon } from "./workloads";

const publicResponse = (input: NewDeployment, url: string) => ({
  deploymentId: input.deploymentId,
  repositoryId: input.repositoryId,
  commit: input.commit,
  parentDeploymentId: input.parentDeploymentId,
  secondParentDeploymentId: input.secondParentDeploymentId,
  url,
});

const openDeployerFor = (name: string) =>
  Effect.gen(function* () {
    const instanceDirectory = join(
      yield* startup(async () => await instanceParent(name)),
      name
    );
    return {
      instanceDirectory,
      store: yield* openDeploymentStore(
        join(instanceDirectory, "deployments.sqlite")
      ),
    };
  });

export const openDeployer = (name: string) =>
  Effect.gen(function* () {
    const { instanceDirectory, store } = yield* openDeployerFor(name);
    const appPort = yield* store.appPort;
    const host = yield* Effect.acquireRelease(
      startup(
        async () =>
          await openDeploymentHost({
            toolsDirectory: await packagedToolsDirectory(),
            instanceDirectory,
            proxyPort: appPort,
          })
      ),
      (opened) =>
        Effect.promise(async () => {
          await opened.close();
        })
    );
    if (appPort !== undefined && appPort !== host.proxyPort) {
      return yield* new DeploymentStartupError({
        message:
          "The saved app port is occupied; deployment URLs were not changed",
      });
    }
    const durable = yield* openStaticDeploymentRunner({
      journalPath: join(instanceDirectory, "workflow.sqlite"),
      instanceDirectory,
      host,
      markReady: store.markReady,
    });
    const unpublish = (deploymentId: string) =>
      Effect.promise(async () => {
        await host.withdraw(deploymentId).catch(() => undefined);
      });
    const publish = (deploymentId: string, worktree: string) =>
      Effect.gen(function* () {
        const spec = yield* attempt("config", async () => {
          const slot = await host.reserve(deploymentId);
          return await prepareDaemon({ ...slot, worktree });
        });
        yield* Effect.uninterruptible(
          attempt("process", async () => {
            await host.publish(deploymentId, spec);
          })
        );
        yield* reachable(host.url(deploymentId));
      }).pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit) ? Effect.void : unpublish(deploymentId)
        )
      );

    const staticTarget = (input: {
      readonly deploymentId: string;
      readonly repositoryId: string;
      readonly commit: string;
      readonly source: string | null;
    }): StaticDeploymentTarget => ({
      deploymentId: input.deploymentId,
      repositoryId: input.repositoryId,
      commit: input.commit,
      originKind: input.source === null ? "repository" : "checkout",
      originPath:
        input.source ??
        join(instanceDirectory, "repositories", `${input.repositoryId}.git`),
    });

    const createStatic = (input: NewDeployment) => {
      const { worktree } = input;
      const target = staticTarget(input);
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
                // A cancelled create can leave the workflow run detached; stop
                // it before removing its worktree and deployment ref.
                yield* durable.interrupt(target);
                yield* unpublish(input.deploymentId);
                const bare =
                  target.originKind === "repository"
                    ? target.originPath
                    : join(
                        instanceDirectory,
                        "repositories",
                        `${input.repositoryId}.git`
                      );
                yield* Effect.promise(async () => {
                  await removeWorktree(bare, worktree).catch(() => undefined);
                  await removeDeploymentRef(bare, input.deploymentId);
                }).pipe(
                  Effect.onExit(() =>
                    store.markFailed(input.deploymentId, failureStage(exit))
                  )
                );
              })
        )
      );
    };

    const create = (
      input: NewDeployment,
      pin: Effect.Effect<string, DeployFailure>,
      knownBare?: string
    ) => {
      let bare = knownBare;
      let recorded = false;
      const { deploymentId, commit, worktree } = input;
      return Effect.gen(function* () {
        yield* store.record(input);
        recorded = true;
        const pinned = yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const repository = yield* pin;
            bare = repository;
            return repository;
          })
        );
        const added = yield* Effect.uninterruptible(
          attempt(
            "git",
            async () =>
              await addWorktree({
                bare: pinned,
                worktrees: join(instanceDirectory, "worktrees"),
                deploymentId,
                commit,
              })
          )
        );
        yield* publish(deploymentId, added);
        yield* store.markReady(deploymentId);
        return publicResponse(input, host.url(deploymentId));
      }).pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit) || !recorded
            ? Effect.void
            : Effect.gen(function* () {
                yield* unpublish(deploymentId);
                yield* Effect.promise(async () => {
                  if (bare !== undefined) {
                    await removeWorktree(bare, worktree).catch(() => undefined);
                    await removeDeploymentRef(bare, deploymentId);
                  }
                }).pipe(
                  Effect.onExit(() =>
                    store.markFailed(deploymentId, failureStage(exit))
                  )
                );
              })
        )
      );
    };

    const deploy = (input: {
      readonly source: string;
      readonly commit: string;
    }) =>
      Effect.gen(function* () {
        const deploymentId = randomUUID();
        const source = yield* attempt(
          "source",
          async () => await verifiedSource(input.source, input.commit)
        );
        const worktree = join(instanceDirectory, "worktrees", deploymentId);
        const { deployments, unreadable } = yield* store.list;
        if (unreadable > 0) {
          return yield* new DeployFailure({
            stage: "server",
            message: "server: deployment records could not be read",
          });
        }
        const parentDeploymentId = yield* attempt(
          "git",
          async () =>
            await firstParentDeployment(
              source.path,
              input.commit,
              deployments.filter(
                (entry) =>
                  entry.repositoryId === source.repositoryId &&
                  entry.status === "ready"
              )
            )
        );
        const committedWorkload = yield* attempt(
          "git",
          async () => await hasCommittedDevverConfig(source.path, input.commit)
        );
        const record: NewDeployment = {
          deploymentId,
          repositoryId: source.repositoryId,
          commit: input.commit,
          parentDeploymentId,
          secondParentDeploymentId: null,
          worktree,
          source: source.path,
          lifecycle: committedWorkload ? "inline" : "workflow",
        };
        return yield* committedWorkload
          ? create(
              record,
              attempt(
                "git",
                async () =>
                  await syncCommit({
                    repositories: join(instanceDirectory, "repositories"),
                    repositoryId: source.repositoryId,
                    source: source.path,
                    commit: input.commit,
                    deploymentId,
                  })
              )
            )
          : createStatic(record);
      });

    const merge = (firstDeploymentId: string, secondDeploymentId: string) =>
      Effect.gen(function* () {
        const sameDeployment = firstDeploymentId === secondDeploymentId;
        const decision = mergeDecision(
          {
            id: firstDeploymentId,
            source: sameDeployment
              ? undefined
              : yield* store.read(firstDeploymentId),
          },
          {
            id: secondDeploymentId,
            source: sameDeployment
              ? undefined
              : yield* store.read(secondDeploymentId),
          }
        );
        if (!decision.admitted) {
          return yield* new MergeRejected({ message: decision.message });
        }
        const bare = join(
          instanceDirectory,
          "repositories",
          `${decision.repositoryId}.git`
        );
        const commit = yield* attempt(
          "git",
          async () =>
            await mergeCommits(
              bare,
              decision.firstCommit,
              decision.secondCommit
            )
        );
        const deploymentId = randomUUID();
        const worktree = join(instanceDirectory, "worktrees", deploymentId);
        const committedWorkload = yield* attempt(
          "git",
          async () => await hasCommittedDevverConfig(bare, commit)
        );
        const record: NewDeployment = {
          deploymentId,
          repositoryId: decision.repositoryId,
          commit,
          parentDeploymentId: firstDeploymentId,
          secondParentDeploymentId: secondDeploymentId,
          worktree,
          source: null,
          lifecycle: committedWorkload ? "inline" : "workflow",
        };
        return yield* committedWorkload
          ? create(
              record,
              attempt("git", async () => {
                await pinCommit(bare, deploymentId, commit);
                return bare;
              }),
              bare
            )
          : createStatic(record);
      });

    const interrupted: Deployment[] = [];
    const restoreLive = (deployment: Deployment) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          publish(
            deployment.deploymentId,
            join(instanceDirectory, "worktrees", deployment.deploymentId)
          )
        );
        yield* Exit.isSuccess(exit)
          ? store.markReady(deployment.deploymentId)
          : store.markDegraded(deployment.deploymentId, failureStage(exit));
      });
    const reconcile = Effect.gen(function* () {
      const { deployments, unreadable } = yield* store.list;
      if (unreadable > 0) {
        return yield* new DeploymentStartupError({
          message:
            "Deployment records hold entries this server cannot read; they were not replaced",
        });
      }
      for (const deployment of deployments) {
        const { deploymentId, status } = deployment;
        if (status === "failed" || status === "degraded") {
          continue;
        }
        yield* unpublish(deploymentId);
        if (status === "preparing") {
          if (deployment.lifecycle !== "workflow") {
            yield* store.markDegraded(deploymentId, "server");
            continue;
          }
          interrupted.push(deployment);
          continue;
        }
        yield* restoreLive(deployment);
      }
      for (const deployment of interrupted) {
        // Re-running the create replays or resumes the recorded workflow; its
        // cleanup marks the deployment failed when resuming is not possible.
        yield* Effect.exit(createStatic(deployment));
        const resumed = yield* store.read(deployment.deploymentId);
        if (resumed?.status === "preparing") {
          // The recorded run had already completed, so re-running it returns
          // without re-publishing; liveness has to be re-established here.
          yield* restoreLive(deployment);
        }
      }
      return undefined;
    });
    yield* Effect.uninterruptible(reconcile);
    if (appPort === undefined) {
      yield* store.setAppPort(host.proxyPort);
    }
    const statuses = Effect.gen(function* () {
      const { deployments, unreadable } = yield* store.list;
      if (unreadable !== 0) {
        return yield* new DeployFailure({
          stage: "server",
          message: "server: deployment records could not be read",
        });
      }
      const subjects = yield* Effect.promise(
        async () => await subjectsOf(instanceDirectory, deployments)
      );
      return statusRows(deployments, subjects, host.url);
    });
    return {
      appPort: host.proxyPort,
      deploy,
      merge,
      statuses,
      rename: store.rename,
    };
  }).pipe(
    Effect.mapError((error) =>
      error instanceof DeploymentStartupError
        ? error
        : new DeploymentStartupError({
            message: "Deployment state could not be opened",
          })
    )
  );
