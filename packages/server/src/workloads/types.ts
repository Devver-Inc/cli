export interface DaemonSpec {
  readonly command: readonly string[];
  readonly dir: string;
}

/**
 * One workload kind: how a committed worktree becomes a daemon.
 *
 * `resolve` proves the worktree is deployable as this kind and fails with a
 * config-stage-safe message: prose only, no paths, no URLs, no secrets. It
 * reads only committed content under the worktree.
 */
export interface WorkloadKind {
  readonly name: string;
  readonly resolve: (worktree: string) => Promise<DaemonSpec>;
}
