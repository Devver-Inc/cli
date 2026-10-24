import type { LocalDeploymentStatus } from "../api/local-deploy.requests";

export function visibleDeployments(
  deployments: readonly LocalDeploymentStatus[],
  repositoryId: string | undefined
): readonly LocalDeploymentStatus[] {
  return repositoryId === undefined
    ? deployments
    : deployments.filter(
        (deployment) => deployment.repositoryId === repositoryId
      );
}
