import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { DeployFailure } from "./api";
import { openDeploymentHost } from "./deployment-host";
import type { DeployStage } from "./deployment-store";
import { openDeploymentStore } from "./deployment-store";
import {
  addWorktree,
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

const stageMessage: Record<DeployStage, string> = {
  server: "server: this installation cannot deploy this workload",
  source: "source: the checkout or commit cannot be deployed",
  git: "git: the commit could not be synchronized",
  config: "config: the deployment configuration is not usable",
  process: "process: the deployment process could not be started",
  readiness: "readiness: the app URL did not serve the deployment",
};

const attempt = async <A>(stage: DeployStage, step: () => Promise<A>) => {
  try {
    return await step();
  } catch (error) {
    if (error instanceof DeployFailure) {
      throw error;
    }
    throw new DeployFailure({
      stage,
      message:
        error instanceof Error && SAFE_DETAIL.test(error.message)
          ? `${stage}: ${error.message}`
          : stageMessage[stage],
    });
  }
};

async function reachable(url: string) {
  const deadline = Date.now() + READINESS_DEADLINE;
  let answered = 0;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(READINESS_TIMEOUT),
      });
      await response.body?.cancel();
      const { status } = response;
      if (status >= 200 && status < 400) {
        return;
      }
      answered = status;
    } catch {
      await delay(READINESS_INTERVAL);
      continue;
    }
    await delay(READINESS_INTERVAL);
  }
  throw new Error(
    answered === 0
      ? "the app URL did not answer before the readiness deadline"
      : `the app URL answered with status ${answered}`
  );
}

export async function openDeployer(name: string) {
  const instanceDirectory = join(await instanceParent(name), name);
  const store = await openDeploymentStore(
    join(instanceDirectory, "deployments.sqlite")
  );
  let host;
  try {
    host = await openDeploymentHost({
      toolsDirectory: await packagedToolsDirectory(),
      instanceDirectory,
      proxyPort: store.appPort(),
    });
  } catch (error) {
    store.close();
    throw error;
  }
  const publish = async (deploymentId: string, worktree: string) => {
    const spec = await attempt("config", async () => prepareDaemon(worktree));
    try {
      await attempt("process", async () => host.publish(deploymentId, spec));
      await attempt("readiness", async () => reachable(host.url(deploymentId)));
    } catch (error) {
      await host.withdraw(deploymentId).catch(() => undefined);
      throw error;
    }
  };

  const unpublish = async (deploymentId: string) => {
    await host.withdraw(deploymentId).catch(() => undefined);
  };

  const deploy = async (input: {
    readonly source: string;
    readonly commit: string;
  }) => {
    const deploymentId = randomUUID();
    const source = await attempt("source", async () =>
      verifiedSource(input.source, input.commit)
    );
    const worktree = join(instanceDirectory, "worktrees", deploymentId);
    store.record({
      deploymentId,
      repositoryId: source.repositoryId,
      commit: input.commit,
      parentDeploymentId: null,
      worktree,
    });
    let bare: string | undefined;
    try {
      const synced = await attempt("git", async () =>
        syncCommit({
          repositories: join(instanceDirectory, "repositories"),
          repositoryId: source.repositoryId,
          source: source.path,
          commit: input.commit,
          deploymentId,
        })
      );
      bare = synced;
      const added = await attempt("git", async () =>
        addWorktree({
          bare: synced,
          worktrees: join(instanceDirectory, "worktrees"),
          deploymentId,
          commit: input.commit,
        })
      );
      await publish(deploymentId, added);
      store.markReady(deploymentId);
      return {
        deploymentId,
        repositoryId: source.repositoryId,
        commit: input.commit,
        parentDeploymentId: null,
        url: host.url(deploymentId),
      };
    } catch (error) {
      await unpublish(deploymentId);
      if (bare !== undefined) {
        await removeWorktree(bare, worktree).catch(() => undefined);
        await removeDeploymentRef(bare, deploymentId);
      }
      store.markFailed(
        deploymentId,
        error instanceof DeployFailure ? error.stage : "server"
      );
      throw error;
    }
  };

  const reconcile = async () => {
    const { deployments, unreadable } = store.list();
    if (unreadable > 0) {
      throw new Error(
        "Deployment records hold entries this server cannot read; they were not replaced"
      );
    }
    for (const deployment of deployments) {
      const { deploymentId, status } = deployment;
      if (status === "failed" || status === "degraded") {
        continue;
      }
      await host.withdraw(deploymentId).catch(() => undefined);
      if (status === "preparing") {
        store.markDegraded(deploymentId, "server");
        continue;
      }
      try {
        await publish(
          deploymentId,
          join(instanceDirectory, "worktrees", deploymentId)
        );
        store.markReady(deploymentId);
      } catch (error) {
        await unpublish(deploymentId);
        store.markDegraded(
          deploymentId,
          error instanceof DeployFailure ? error.stage : "server"
        );
      }
    }
  };

  const deployer = {
    appPort: host.proxyPort,
    deploy,
    close: async () => {
      await host.close();
      store.close();
    },
  };
  try {
    await reconcile();
  } catch (error) {
    await deployer.close();
    throw error;
  }
  if (store.appPort() !== host.proxyPort) {
    store.setAppPort(host.proxyPort);
  }
  return deployer;
}
