/**
 * One local deployment, stage by stage.
 *
 * Every stage either completes or removes what it attempted: a failed sync,
 * configuration, process start or readiness check leaves no route, no managed
 * process and no worktree, and records the deployment as failed at that stage
 * instead of ready. Only a real request to the published app hostname declares
 * a deployment ready.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { DeployFailure } from "./api";
import { allocatePort, startAppListener } from "./app-listener";
import type { DeployStage } from "./deployment-store";
import { openDeploymentStore } from "./deployment-store";
import {
  addWorktree,
  removeWorktree,
  syncCommit,
  verifiedSource,
} from "./git-source";
import { instanceParent } from "./identity";
import { packagedToolsDirectory } from "./packaged-tools";
import { startStaticSite, stopStaticSite } from "./static-site";
import { staticSourceDirectory } from "./static-source";

const READINESS_DEADLINE = 20_000;
const READINESS_INTERVAL = 200;
const READINESS_TIMEOUT = 1000;
// Prose only: a detail with a path, URL or token in it never reaches the client.
const SAFE_DETAIL = /^(?=[^\n]* )[A-Za-z0-9 ,.'()-]{1,120}$/u;

const stageMessage: Record<DeployStage, string> = {
  server: "server: this installation cannot deploy static sites",
  source: "source: the checkout or commit cannot be deployed",
  git: "git: the commit could not be synchronized",
  config: "config: the static configuration is not usable",
  process: "process: the static site could not be started",
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

/** Readiness is the printed app URL answering, not a Host header trick. */
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
      // The supervised static server may not be listening yet.
    }
    await delay(READINESS_INTERVAL);
  }
  throw new Error(
    answered === 0
      ? "the app URL did not answer before the readiness deadline"
      : `the app URL answered with status ${answered}`
  );
}

/**
 * Open the deployment state of one server instance: its durable records and
 * the single app-facing listener its deployments are published on.
 */
export async function openDeployer(name: string) {
  const instanceDirectory = join(await instanceParent(name), name);
  const store = await openDeploymentStore(
    join(instanceDirectory, "deployments.sqlite")
  );
  let listener;
  try {
    listener = await startAppListener();
  } catch (error) {
    store.close();
    throw error;
  }
  const running = new Map<
    string,
    { readonly toolsDirectory: string; readonly port: number }
  >();

  const deploy = async (input: {
    readonly source: string;
    readonly commit: string;
  }) => {
    const deploymentId = randomUUID();
    const appDirectory = join(instanceDirectory, "apps", deploymentId);
    const url = `http://${deploymentId}.localhost:${listener.port}/`;
    const toolsDirectory = await attempt("server", packagedToolsDirectory);
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
    let port: number | undefined;
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
      const site = await attempt("config", async () =>
        staticSourceDirectory(added)
      );
      const allocated = await attempt("process", allocatePort);
      port = allocated;
      await attempt("process", async () =>
        startStaticSite({
          toolsDirectory,
          instanceDirectory: appDirectory,
          siteDirectory: site,
          port: allocated,
        })
      );
      listener.publish(deploymentId, allocated);
      await attempt("readiness", async () => reachable(url));
      store.markReady(deploymentId);
      running.set(deploymentId, { toolsDirectory, port: allocated });
      return {
        deploymentId,
        repositoryId: source.repositoryId,
        commit: input.commit,
        parentDeploymentId: null,
        url,
      };
    } catch (error) {
      listener.withdraw(deploymentId);
      if (port !== undefined) {
        await stopStaticSite({
          toolsDirectory,
          instanceDirectory: appDirectory,
          port,
        }).catch(() => undefined);
      }
      if (bare !== undefined) {
        await removeWorktree(bare, worktree).catch(() => undefined);
      }
      store.markFailed(
        deploymentId,
        error instanceof DeployFailure ? error.stage : "server"
      );
      throw error;
    }
  };

  return {
    appPort: listener.port,
    deploy,
    close: async () => {
      for (const [deploymentId, site] of running) {
        listener.withdraw(deploymentId);
        await stopStaticSite({
          toolsDirectory: site.toolsDirectory,
          instanceDirectory: join(instanceDirectory, "apps", deploymentId),
          port: site.port,
        }).catch(() => undefined);
      }
      running.clear();
      await listener.close();
      store.close();
    },
  };
}
