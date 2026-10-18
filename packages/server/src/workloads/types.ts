/**
 * The seam of the deployment subsystem: what one committed worktree runs as.
 *
 * A workload module owns everything about one deployment type: which section
 * of `.devver.yaml` is its own, what command the committed content needs, and
 * where the process runs. The deployment host runs what it is given and never
 * learns which workload it was, so adding a workload type is one new module in
 * this directory plus one line in the registry.
 */

/** What the host needs to run one deployment. It never interprets this. */
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
  /** Stable lowercase name, the spelling used in `.devver.yaml`. */
  readonly name: string;
  readonly resolve: (worktree: string) => Promise<DaemonSpec>;
}
