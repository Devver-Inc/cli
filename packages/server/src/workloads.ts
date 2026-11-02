import { readDevverFile } from "./workloads/config";
import { processKind } from "./workloads/process";
import { staticSiteKind } from "./workloads/static";
import type { DaemonSpec, WorkloadTarget } from "./workloads/types";

export async function prepareDaemon(
  target: WorkloadTarget
): Promise<DaemonSpec> {
  const file = await readDevverFile(target.worktree);
  const names = Object.keys(file);
  if (names.length === 0 || (names.length === 1 && names[0] === "static")) {
    return staticSiteKind.resolve(target);
  }
  if (names.length === 1 && names[0] === "process") {
    return processKind.resolve(target);
  }
  throw new Error(
    "The deployment configuration must declare one local workload"
  );
}

export type {
  DaemonSlot,
  DaemonSpec,
  WorkloadKind,
  WorkloadTarget,
} from "./workloads/types";
