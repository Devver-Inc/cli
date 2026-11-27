import type { DaemonSlot } from "../deployment-host";

export interface WorkloadTarget extends DaemonSlot {
  readonly worktree: string;
}

export type { DaemonSlot, DaemonSpec } from "../deployment-host";
