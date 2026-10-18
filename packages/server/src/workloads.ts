/**
 * The registry of workload kinds: the one file a new workload type edits.
 *
 * Selection is explicit and fail-closed. `.devver.yaml` carries `workload:`,
 * its value must name a registered kind, and absence means `static`, which is
 * what every deployment made before kinds existed expects. An unknown value
 * fails at the config stage naming the allowed kinds, rather than silently
 * deploying as something else.
 */

import { Schema } from "effect";

import { staticSiteKind } from "./workloads/static";
import type { DaemonSpec, WorkloadKind } from "./workloads/types";

/** One entry per workload kind, in this package. */
const kinds: readonly WorkloadKind[] = [staticSiteKind];

export const kindByName = (name: string): WorkloadKind | undefined =>
  kinds.find((kind) => kind.name === name);

/** The kind a worktree with no `workload:` key gets. */
export const defaultKind: WorkloadKind = staticSiteKind;

/** The value `.devver.yaml`'s `workload:` key must carry to select a kind. */
export const workloadNames = kinds.map((kind) => kind.name);

/**
 * Turn a worktree into what the deployment host runs, through the kind its
 * committed configuration selects.
 */
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
