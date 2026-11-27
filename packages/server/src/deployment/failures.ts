import { Cause, Data, Exit, Option } from "effect";
import type { Effect } from "effect";

import { DeployFailure } from "../api";
import { runAbortable } from "../exec";
import type { DeployStage } from "./record";

// Subprocess output can name paths or secrets, so only a plain sentence passes.
export const SAFE_DETAIL = /^(?=[^\n]* )[A-Za-z0-9 ,.'()-]{1,120}$/u;

export const stageMessage: Record<DeployStage, string> = {
  server: "server: this installation cannot deploy this workload",
  source: "source: the checkout or commit cannot be deployed",
  git: "git: the commit could not be synchronized",
  config: "config: the deployment configuration is not usable",
  process: "process: the deployment process could not be started",
  readiness: "readiness: the app URL did not serve the deployment",
};

export class DeploymentStartupError extends Data.TaggedError(
  "DeploymentStartupError"
)<{
  message: string;
}> {}

export const startup = <A>(step: (signal: AbortSignal) => Promise<A>) =>
  runAbortable(
    step,
    () =>
      new DeploymentStartupError({
        message: "Deployment state could not be opened",
      })
  );

export const failureStage = (
  exit: Exit.Exit<unknown, unknown>
): DeployStage => {
  const error = Exit.isFailure(exit)
    ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
    : undefined;
  return error instanceof DeployFailure ? error.stage : "server";
};

export class HostFailure extends Data.TaggedError("HostFailure")<{
  message: string;
}> {}

// Renders one crafted sentence at the deployment stage; anything the
// sentence filters would leak, so it falls back to the stage's fixed text.
export const stagedFailure = (stage: DeployStage, message: string) =>
  new DeployFailure({
    stage,
    message: SAFE_DETAIL.test(message)
      ? `${stage}: ${message}`
      : stageMessage[stage],
  });

export const attemptHost = <A>(
  step: (signal: AbortSignal) => Promise<A>
): Effect.Effect<A, HostFailure> =>
  runAbortable(
    step,
    (error) =>
      new HostFailure({
        message:
          error instanceof Error && SAFE_DETAIL.test(error.message)
            ? error.message
            : "this installation cannot deploy the workload",
      })
  );

export const hostFailure = (stage: DeployStage) => (error: HostFailure) =>
  new DeployFailure({ stage, message: `${stage}: ${error.message}` });

export const attempt = <A>(
  stage: DeployStage,
  step: (signal: AbortSignal) => Promise<A>
) =>
  runAbortable<A, DeployFailure>(step, (error) =>
    error instanceof DeployFailure
      ? error
      : stagedFailure(stage, error instanceof Error ? error.message : "")
  );
