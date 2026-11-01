import type { DaemonSlot, DaemonSpec } from "../deployment-host";

export interface WorkloadTarget extends DaemonSlot {
  readonly worktree: string;
}

// Resolve only committed content; failures must not expose paths or secrets.
export interface WorkloadKind {
  readonly name: string;
  readonly resolve: (target: WorkloadTarget) => Promise<DaemonSpec>;
}

export type { DaemonSlot, DaemonSpec } from "../deployment-host";
