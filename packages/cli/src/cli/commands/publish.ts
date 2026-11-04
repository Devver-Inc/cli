import { Console, Data, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import {
  listLocalDeployments,
  publishLocalDeployment,
} from "../../infra/api/local-deploy.requests";
import { openBrowser } from "../../infra/auth/browser";
import { readConfig } from "../../infra/config/api";
import { withLocalApi } from "../api";

class PublishError extends Data.TaggedError("PublishError")<{
  message: string;
}> {}

export const publish = Command.make(
  "publish",
  {
    deploymentId: Argument.String("deployment-id").pipe(Argument.optional),
    open: Flag.Boolean("open").pipe(Flag.withDefault(false)),
  },
  ({ deploymentId, open }) =>
    Effect.gen(function* () {
      const target = (yield* Effect.tryPromise(readConfig))["local-target"];
      if (target === undefined) {
        return yield* new PublishError({
          message: "Attach a local server before publishing a deployment",
        });
      }
      const result = yield* withLocalApi(
        target,
        Effect.gen(function* () {
          const id = Option.isSome(deploymentId)
            ? deploymentId.value
            : (yield* listLocalDeployments).at(-1)?.deploymentId;
          if (id === undefined) {
            return yield* new PublishError({
              message: "No deployments on the attached server. Deploy first.",
            });
          }
          yield* Console.log("Anyone with the URL can access this deployment.");
          return yield* publishLocalDeployment(id);
        })
      );
      yield* Console.log(`Published: ${result.url}`);
      if (
        open &&
        !(yield* Effect.promise(async () => openBrowser(result.url)))
      ) {
        yield* Console.log("Could not open the public URL in a browser.");
      }
      return undefined;
    })
).pipe(
  Command.withDescription(
    "Share a local deployment through OpenTunnel (defaults to the latest)"
  )
);
