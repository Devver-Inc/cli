/**
 * One local deployment, stage by stage.
 *
 * Every stage either completes or removes what it attempted: a failed sync,
 * configuration, process start or readiness check leaves no route, no managed
 * process and no worktree, and records the deployment as failed at that stage
 * instead of ready. A deployment this server cannot record as ready is
 * unpublished for the same reason, before its record is rewritten. Only a real
 * request to the published app hostname declares a deployment ready.
 *
 * Deployments are daemons of one Pitchfork supervisor, addressed by their own
 * id. Pitchfork assigns their ports and its reverse proxy routes each stable
 * hostname to whichever port its process bound, so no port is chosen here.
 */

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
// Prose only: a detail with a path, URL or token in it never reaches the client.
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
 * Open the deployment state of one server instance: its durable records, the
 * deployment host its processes are published on, and the reconciliation that
 * brings the two back together after a restart.
 */
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
  /**
   * Serve one selected worktree and publish its route, proven by a request to
   * its own app URL. A failure here leaves no route and no managed process,
   * whether it happened during a deploy or while recovering one.
   */
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

  /**
   * Undo a publish, whatever the next step did. It runs before any record is
   * rewritten: a deployment that is no longer ready must not keep a route or a
   * process either way.
   */
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

  /**
   * Match persisted intent to reality once, at startup. Every recorded
   * deployment is withdrawn first, so a daemon an earlier run left behind is
   * stopped before this run publishes its own: exactly one process and one
   * route per deployment. Whatever cannot be served again becomes degraded
   * with no route, so it answers at its own address and nowhere else.
   *
   * A record this server cannot read stops it here, like any other unsafe
   * instance state: that record is left exactly as found, and nothing is
   * published beside a backend that may still be serving.
   */
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
      // An interrupted deploy never finished its worktree, so it is not
      // recovered: it may not end up served from a half-written checkout.
      if (status === "preparing") {
        store.markDegraded(deploymentId, "server");
        continue;
      }
      try {
        // The worktree of a deployment is where this server puts it, never a
        // path read back from a record.
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
  // Only a startup that got this far may replace the port the printed URLs of
  // healthy deployments carry.
  if (store.appPort() !== host.proxyPort) {
    store.setAppPort(host.proxyPort);
  }
  return deployer;
}
