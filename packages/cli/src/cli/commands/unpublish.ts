import { Console, Data, Effect } from "effect";
import { Argument, Command } from "effect/cli";

import { unpublishLocalDeployment } from "../../infra/api/local-deploy.requests";
import { readConfig } from "../../infra/config/api";
import { withLocalApi } from "../api";

class UnpublishError extends Data.TaggedError("UnpublishError")<{
  message: string;
}> {}

export const unpublish = Command.make(
  "unpublish",
  { deploymentId: Argument.String("deployment-id") },
  ({ deploymentId }) =>
    Effect.gen(function* () {
      const target = (yield* Effect.tryPromise(readConfig))["local-target"];
      if (target === undefined) {
        return yield* new UnpublishError({
          message: "Attach a local server before unpublishing a deployment",
        });
      }
      yield* withLocalApi(target, unpublishLocalDeployment(deploymentId));
      return yield* Console.log(`Unpublished ${deploymentId}`);
    })
).pipe(Command.withDescription("Remove a local deployment's public route"));
