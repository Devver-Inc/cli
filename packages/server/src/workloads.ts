import { Schema } from "effect";

import { staticSiteKind } from "./workloads/static";
import type { DaemonSpec, WorkloadKind } from "./workloads/types";

const kinds: readonly WorkloadKind[] = [staticSiteKind];

export const kindByName = (name: string): WorkloadKind | undefined =>
  kinds.find((kind) => kind.name === name);

export const defaultKind: WorkloadKind = staticSiteKind;

export const workloadNames = kinds.map((kind) => kind.name);

const WorkloadSelection = Schema.Struct({
  workload: Schema.optional(Schema.String),
});

export async function prepareDaemon(worktree: string): Promise<DaemonSpec> {
  const { readDevverFile } = await import("./workloads/config");
  const file = await readDevverFile(worktree);
  const { workload } = Schema.decodeSync(WorkloadSelection)(file);
  const kind = workload === undefined ? defaultKind : kindByName(workload);
  if (kind === undefined) {
    throw new Error(`The workload must be one of: ${workloadNames.join(", ")}`);
  }
  return kind.resolve(worktree);
}

export type { DaemonSpec, WorkloadKind } from "./workloads/types";
export { portPlaceholder } from "./deployment-host";
