import { join } from "node:path";

import { commitSubjects } from "../git-source";
import type { Deployment } from "./record";

export async function subjectsOf(
  instanceDirectory: string,
  deployments: readonly { repositoryId: string; commit: string }[]
): Promise<ReadonlyMap<string, string>> {
  const byRepository = new Map<string, string[]>();
  for (const { repositoryId, commit } of deployments) {
    byRepository.set(repositoryId, [
      ...(byRepository.get(repositoryId) ?? []),
      commit,
    ]);
  }
  const subjects = new Map<string, string>();
  for (const [repositoryId, commits] of byRepository) {
    const bare = join(instanceDirectory, "repositories", `${repositoryId}.git`);
    for (const [commit, subject] of await commitSubjects(bare, commits)) {
      subjects.set(commit, subject);
    }
  }
  return subjects;
}

export function statusRows(
  deployments: readonly Deployment[],
  subjects: ReadonlyMap<string, string>,
  url: (deploymentId: string) => string,
  publicUrl: (deploymentId: string) => string | undefined
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
      publicUrl: publicUrl(deploymentId) ?? null,
    })
  );
}
