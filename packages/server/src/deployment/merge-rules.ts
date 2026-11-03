interface MergeSource {
  readonly repositoryId: string;
  readonly commit: string;
  readonly status: string;
}

export type MergeDecision =
  | { readonly admitted: false; readonly message: string }
  | {
      readonly admitted: true;
      readonly repositoryId: string;
      readonly firstCommit: string;
      readonly secondCommit: string;
    };

const rejected = (message: string): MergeDecision => ({
  admitted: false,
  message,
});

export function mergeDecision(
  first: { readonly id: string; readonly source: MergeSource | undefined },
  second: { readonly id: string; readonly source: MergeSource | undefined }
): MergeDecision {
  if (first.id === second.id) {
    return rejected("Choose two different deployments to merge");
  }
  if (first.source === undefined || second.source === undefined) {
    return rejected("A source deployment was not found");
  }
  if (first.source.repositoryId !== second.source.repositoryId) {
    return rejected("Both deployments must belong to the same repository");
  }
  if (first.source.status !== "ready" || second.source.status !== "ready") {
    return rejected("Both source deployments must be ready");
  }
  if (first.source.commit === second.source.commit) {
    return rejected("Both deployments already have the same revision");
  }
  return {
    admitted: true,
    repositoryId: first.source.repositoryId,
    firstCommit: first.source.commit,
    secondCommit: second.source.commit,
  };
}
