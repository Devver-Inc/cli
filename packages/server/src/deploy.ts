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
import type { NewDeployment } from "./deployment/record";
import {
  addWorktree,
  firstParentDeployment,
  mergeCommits,
  pinCommit,
  removeDeploymentRef,
  removeWorktree,
  syncCommit,
  verifiedSource,
} from "./git-source";
import { instanceParent } from "./identity";
import { packagedToolsDirectory } from "./packaged-tools";
import { prepareDaemon } from "./workloads";

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

    const create = (
      input: NewDeployment,
      pin: Effect.Effect<string, DeployFailure>,
      knownBare?: string
    ) => {
      const { worktree, ...response } = input;
      let bare = knownBare;
      let recorded = false;
      const { deploymentId, commit } = input;
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
        return { ...response, url: host.url(deploymentId) };
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
        return yield* create(
          {
            deploymentId,
            repositoryId: source.repositoryId,
            commit: input.commit,
            parentDeploymentId,
            secondParentDeploymentId: null,
            worktree,
          },
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
        );
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
        return yield* create(
          {
            deploymentId,
            repositoryId: decision.repositoryId,
            commit,
            parentDeploymentId: firstDeploymentId,
            secondParentDeploymentId: secondDeploymentId,
            worktree,
          },
          attempt("git", async () => {
            await pinCommit(bare, deploymentId, commit);
            return bare;
          }),
          bare
        );
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
          yield* store.markDegraded(deploymentId, "server");
          continue;
        }
        const exit = yield* Effect.exit(
          publish(
            deploymentId,
            join(instanceDirectory, "worktrees", deploymentId)
          )
        );
        yield* Exit.isSuccess(exit)
          ? store.markReady(deploymentId)
          : store.markDegraded(deploymentId, failureStage(exit));
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
