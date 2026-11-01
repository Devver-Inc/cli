import type { DaemonSlot, DaemonSpec } from "../deployment-host";

/** The reserved slot a workload resolves into, plus the checkout it serves. */
export interface WorkloadTarget extends DaemonSlot {
  readonly worktree: string;
}

/**
 * One workload kind: how a committed worktree becomes a daemon.
 *
 * `resolve` proves the worktree is deployable as this kind and fails with a
 * config-stage-safe message: prose only, no paths, no URLs, no secrets. It
 * reads only committed content under the worktree, and writes any generated
 * configuration into the target's own owner-only directory.
 */
export interface WorkloadKind {
  readonly name: string;
  readonly resolve: (target: WorkloadTarget) => Promise<DaemonSpec>;
}

export type { DaemonSlot, DaemonSpec } from "../deployment-host";
