import { Context, Effect } from "effect";
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";

import { DeployFailure } from "../api";
import { prepareProcess, ProcessPrepareFailure } from "../workloads/process";
import { prepareStaticSite } from "../workloads/static";
import type { StaticPrepareFailure } from "../workloads/static";
import type { DaemonSpec, WorkloadTarget } from "../workloads/types";
import { stagedFailure, stageMessage } from "./failures";
import type { DeploymentSpecification } from "./specification";

export type DeploymentKind = DeploymentSpecification["kind"];

// The capability that prepares a workload from the deployment specification.
// The runtime selects an implementation per deployment from decoded data and
// provides it locally to the operation; an implementation receiving another
// kind has been composed incorrectly and fails closed instead of guessing.
export interface WorkloadPreparer {
  readonly prepare: (
    specification: DeploymentSpecification,
    target: WorkloadTarget
  ) => Effect.Effect<DaemonSpec, DeployFailure, ChildProcessSpawner>;
}

export const DeploymentType = Context.Service<WorkloadPreparer>(
  "devver/server/DeploymentType"
);

const mismatched = () =>
  new DeployFailure({
    stage: "config",
    message: "config: the deployment configuration is not usable",
  });

const staticDeploymentType: WorkloadPreparer = {
  prepare: (specification, target) =>
    specification.kind === "static"
      ? prepareStaticSite(specification, target).pipe(
          Effect.mapError((error: StaticPrepareFailure) =>
            stagedFailure("config", error.message)
          )
        )
      : Effect.fail(mismatched()),
};

const processDeploymentType: WorkloadPreparer = {
  prepare: (specification, target) =>
    specification.kind === "process"
      ? prepareProcess(specification, target).pipe(
          Effect.mapError(
            (error: ProcessPrepareFailure | { readonly message: string }) =>
              error instanceof ProcessPrepareFailure
                ? stagedFailure("config", error.message)
                : new DeployFailure({
                    stage: "config",
                    message: stageMessage.config,
                  })
          )
        )
      : Effect.fail(mismatched()),
};

const deploymentTypes: Record<DeploymentKind, WorkloadPreparer> = {
  process: processDeploymentType,
  static: staticDeploymentType,
};

export const deploymentTypeFor = (kind: DeploymentKind): WorkloadPreparer =>
  deploymentTypes[kind];

export const prepareWorkload = (
  specification: DeploymentSpecification,
  target: WorkloadTarget
) =>
  Effect.gen(function* () {
    const type = yield* DeploymentType;
    return yield* type.prepare(specification, target);
  });
