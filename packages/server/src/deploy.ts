import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { Cause, Data, Effect, Exit, Option } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import { DeployFailure, MergeRejected } from "./api";
import { openDeploymentHost } from "./deployment-host";
import type { DeployStage } from "./deployment-store";
import { openDeploymentStore } from "./deployment-store";
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

const READINESS_DEADLINE = 20_000;
const READINESS_INTERVAL = 200;
const READINESS_TIMEOUT = 1000;
const SAFE_DETAIL = /^(?=[^\n]* )[A-Za-z0-9 ,.'()-]{1,120}$/u;

class DeploymentStartupError extends Data.TaggedError(
  "DeploymentStartupError"
)<{
  message: string;
}> {}

const startup = <A>(step: () => Promise<A>) =>
  Effect.tryPromise({
    try: async () => await step(),
    catch: () =>
      new DeploymentStartupError({
        message: "Deployment state could not be opened",
      }),
  });

const failureStage = (exit: Exit.Exit<unknown, unknown>): DeployStage => {
  const error = Exit.isFailure(exit)
    ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
    : undefined;
  return error instanceof DeployFailure ? error.stage : "server";
};

const stageMessage: Record<DeployStage, string> = {
  server: "server: this installation cannot deploy this workload",
  source: "source: the checkout or commit cannot be deployed",
  git: "git: the commit could not be synchronized",
  config: "config: the deployment configuration is not usable",
  process: "process: the deployment process could not be started",
  readiness: "readiness: the app URL did not serve the deployment",
};

const attempt = <A>(stage: DeployStage, step: () => Promise<A>) =>
  Effect.tryPromise({
    try: async () => await step(),
    catch: (error) =>
      error instanceof DeployFailure
        ? error
        : new DeployFailure({
            stage,
            message:
              error instanceof Error && SAFE_DETAIL.test(error.message)
                ? `${stage}: ${error.message}`
                : stageMessage[stage],
          }),
  });

const reachable = (url: string) =>
  Effect.gen(function* () {
    const client = HttpClient.withScope(yield* HttpClient.HttpClient);
    const deadline = Date.now() + READINESS_DEADLINE;
    let answered = 0;
    while (Date.now() < deadline) {
      const status = yield* client.execute(HttpClientRequest.get(url)).pipe(
        Effect.map((response) => response.status),
        Effect.timeout(READINESS_TIMEOUT),
        Effect.provideService(FetchHttpClient.RequestInit, {
          redirect: "manual",
        }),
        Effect.scoped,
        Effect.orElseSucceed(() => 0)
      );
      if (status >= 200 && status < 300) {
        return undefined;
      }
      if (status !== 0) {
        answered = status;
      }
      yield* Effect.sleep(READINESS_INTERVAL);
    }
    return yield* new DeployFailure({
      stage: "readiness",
      message:
        answered === 0
          ? "readiness: the app URL did not answer before the readiness deadline"
          : `readiness: the app URL answered with status ${answered}`,
    });
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
    const unpublish = (deploymentId: string) =>
      Effect.promise(async () => {
        await host.withdraw(deploymentId).catch(() => undefined);
      });
    const publish = (deploymentId: string, worktree: string) =>
      Effect.gen(function* () {
        const spec = yield* attempt(
          "config",
          async () => await prepareDaemon(worktree)
        );
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
        let bare: string | undefined;
        let recorded = false;
        return yield* Effect.gen(function* () {
          yield* store.record({
            deploymentId,
            repositoryId: source.repositoryId,
            commit: input.commit,
            parentDeploymentId,
            secondParentDeploymentId: null,
            worktree,
          });
          recorded = true;
          const synced = yield* Effect.uninterruptible(
            Effect.gen(function* () {
              const repository = yield* attempt(
                "git",
                async () =>
                  await syncCommit({
                    repositories: join(instanceDirectory, "repositories"),
                    repositoryId: source.repositoryId,
                    source: source.path,
                    commit: input.commit,
                    deploymentId,
                  })
              );
              bare = repository;
              return repository;
            })
          );
          const added = yield* Effect.uninterruptible(
            attempt(
              "git",
              async () =>
                await addWorktree({
                  bare: synced,
                  worktrees: join(instanceDirectory, "worktrees"),
                  deploymentId,
                  commit: input.commit,
                })
            )
          );
          yield* publish(deploymentId, added);
          yield* store.markReady(deploymentId);
          return {
            deploymentId,
            repositoryId: source.repositoryId,
            commit: input.commit,
            parentDeploymentId,
            secondParentDeploymentId: null,
            url: host.url(deploymentId),
          };
        }).pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit)
              ? Effect.void
              : Effect.gen(function* () {
                  if (recorded) {
                    yield* unpublish(deploymentId);
                    yield* Effect.promise(async () => {
                      if (bare !== undefined) {
                        await removeWorktree(bare, worktree).catch(
                          () => undefined
                        );
                        await removeDeploymentRef(bare, deploymentId);
                      }
                    }).pipe(
                      Effect.onExit(() =>
                        store.markFailed(deploymentId, failureStage(exit))
                      )
                    );
                  }
                })
          )
        );
      });

    const merge = (firstDeploymentId: string, secondDeploymentId: string) =>
      Effect.gen(function* () {
        if (firstDeploymentId === secondDeploymentId) {
          return yield* new MergeRejected({
            message: "Choose two different deployments to merge",
          });
        }
        const first = yield* store.read(firstDeploymentId);
        const second = yield* store.read(secondDeploymentId);
        if (first === undefined || second === undefined) {
          return yield* new MergeRejected({
            message: "A source deployment was not found",
          });
        }
        if (first.repositoryId !== second.repositoryId) {
          return yield* new MergeRejected({
            message: "Both deployments must belong to the same repository",
          });
        }
        if (first.status !== "ready" || second.status !== "ready") {
          return yield* new MergeRejected({
            message: "Both source deployments must be ready",
          });
        }
        if (first.commit === second.commit) {
          return yield* new MergeRejected({
            message: "Both deployments already have the same revision",
          });
        }
        const bare = join(
          instanceDirectory,
          "repositories",
          `${first.repositoryId}.git`
        );
        const commit = yield* attempt(
          "git",
          async () => await mergeCommits(bare, first.commit, second.commit)
        );
        const deploymentId = randomUUID();
        const worktree = join(instanceDirectory, "worktrees", deploymentId);
        let recorded = false;
        return yield* Effect.gen(function* () {
          yield* store.record({
            deploymentId,
            repositoryId: first.repositoryId,
            commit,
            parentDeploymentId: firstDeploymentId,
            secondParentDeploymentId: secondDeploymentId,
            worktree,
          });
          recorded = true;
          yield* Effect.uninterruptible(
            attempt("git", async () => {
              await pinCommit(bare, deploymentId, commit);
            })
          );
          const added = yield* Effect.uninterruptible(
            attempt(
              "git",
              async () =>
                await addWorktree({
                  bare,
                  worktrees: join(instanceDirectory, "worktrees"),
                  deploymentId,
                  commit,
                })
            )
          );
          yield* publish(deploymentId, added);
          yield* store.markReady(deploymentId);
          return {
            deploymentId,
            repositoryId: first.repositoryId,
            commit,
            parentDeploymentId: firstDeploymentId,
            secondParentDeploymentId: secondDeploymentId,
            url: host.url(deploymentId),
          };
        }).pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit) || !recorded
              ? Effect.void
              : Effect.gen(function* () {
                  yield* unpublish(deploymentId);
                  yield* Effect.promise(async () => {
                    await removeWorktree(bare, worktree).catch(() => undefined);
                    await removeDeploymentRef(bare, deploymentId);
                  }).pipe(
                    Effect.onExit(() =>
                      store.markFailed(deploymentId, failureStage(exit))
                    )
                  );
                })
          )
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
    const statuses = store.list.pipe(
      Effect.flatMap(({ deployments, unreadable }) =>
        unreadable === 0
          ? Effect.succeed(
              deployments.map(
                ({
                  deploymentId,
                  repositoryId,
                  commit,
                  parentDeploymentId,
                  secondParentDeploymentId,
                  status,
                  stage,
                  displayName,
                }) => ({
                  deploymentId,
                  repositoryId,
                  commit,
                  parentDeploymentId,
                  secondParentDeploymentId,
                  status,
                  stage,
                  displayName,
                  url: status === "ready" ? host.url(deploymentId) : null,
                })
              )
            )
          : new DeployFailure({
              stage: "server",
              message: "server: deployment records could not be read",
            })
      )
    );
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
