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

export interface FlatDeployment {
  readonly id: string;
  readonly displayName: string | null | undefined;
  readonly parentId: string | undefined;
  readonly secondParentId: string | undefined;
  readonly depth?: number;
  readonly repositoryId: string | undefined;
  readonly commit: string | undefined;
  readonly status: LocalDeploymentStatus["status"];
  readonly stage: LocalDeploymentStatus["stage"];
  readonly url: string | null | undefined;
}

interface TreeNode extends FlatDeployment {
  readonly children: readonly TreeNode[];
}

export function flatten(
  nodes: readonly TreeNode[],
  depth = 0
): FlatDeployment[] {
  const flattened: FlatDeployment[] = [];
  for (const node of nodes) {
    flattened.push({ ...node, depth });
    for (const row of flatten(node.children, depth + 1)) {
      flattened.push(row);
    }
  }
  return flattened;
}

export function buildTree(rows: readonly FlatDeployment[]): TreeNode[] {
  const byId = new Map<string, FlatDeployment & { children: TreeNode[] }>();
  for (const row of rows) {
    byId.set(row.id, { ...row, children: [] });
  }
  const roots: (FlatDeployment & { children: TreeNode[] })[] = [];
  for (const row of rows) {
    const parent =
      row.parentId === undefined ? undefined : byId.get(row.parentId);
    const node = byId.get(row.id);
    if (node === undefined) {
      continue;
    }
    if (parent === undefined || parent === node) {
      roots.push(node);
    } else {
      parent.children.push(node);
    }
  }
  return roots;
}
