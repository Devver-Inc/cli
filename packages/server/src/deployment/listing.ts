import type { Deployment } from "./record";

export function statusRows(
  deployments: readonly Deployment[],
  subjects: ReadonlyMap<string, string>,
  url: (deploymentId: string) => string
) {
  return deployments.map(
    ({
      deploymentId,
      repositoryId,
      commit,
      parentDeploymentId,
      secondParentDeploymentId,
      status,
      stage,
      displayName,
      createdAt,
    }) => ({
      deploymentId,
      repositoryId,
      commit,
      commitSubject: subjects.get(commit) ?? null,
      createdAt,
      parentDeploymentId,
      secondParentDeploymentId,
      status,
      stage,
      displayName,
      url: status === "ready" ? url(deploymentId) : null,
    })
  );
}
