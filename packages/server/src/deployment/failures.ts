import { Cause, Data, Effect, Exit, Option } from "effect";

import { DeployFailure } from "../api";
import type { DeployStage } from "./record";

// Subprocess output can name paths or secrets, so only a plain sentence passes.
const SAFE_DETAIL = /^(?=[^\n]* )[A-Za-z0-9 ,.'()-]{1,120}$/u;

const stageMessage: Record<DeployStage, string> = {
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

export const startup = <A>(step: () => Promise<A>) =>
  Effect.tryPromise({
    try: async () => await step(),
    catch: () =>
      new DeploymentStartupError({
        message: "Deployment state could not be opened",
      }),
  });

export const failureStage = (
  exit: Exit.Exit<unknown, unknown>
): DeployStage => {
  const error = Exit.isFailure(exit)
    ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
    : undefined;
  return error instanceof DeployFailure ? error.stage : "server";
};

export const attempt = <A>(stage: DeployStage, step: () => Promise<A>) =>
  Effect.tryPromise({
    try: async () => await step(),
    catch: (error) =>
      error instanceof DeployFailure
        ? error
        : new DeployFailure({
            stage,
            message:
              error instanceof Error && SAFE_DETAIL.test(error.message)
                ? `${stage}: ${error.message}`
                : stageMessage[stage],
          }),
  });
