import { Console, Data, Effect, Schema } from "effect";
import { Argument, Command } from "effect/cli";

import { mergeLocalDeployments } from "../api/local-deploy.requests";
import { readConfig } from "../config/api";
import { withLocalApi } from "./api";

class MergeError extends Data.TaggedError("MergeError")<{ message: string }> {}

const deploymentId = (name: string) =>
  Argument.String(name).pipe(
    Argument.withSchema(Schema.String.check(Schema.isUUID(4)))
  );

export const merge = Command.make(
  "merge",
  {
    first: deploymentId("first-deployment-id"),
    second: deploymentId("second-deployment-id"),
  },
  ({ first, second }) =>
    Effect.gen(function* () {
      const target = (yield* Effect.tryPromise(readConfig))["local-target"];
      if (target === undefined) {
        return yield* new MergeError({
          message: "Attach a local server before merging deployments",
        });
      }
      yield* Console.log(
        "  ⚠ Local deployments are not sandboxed: deployed code runs with your own user's access."
      );
      const result = yield* withLocalApi(
        target,
        mergeLocalDeployments(first, second)
      );
      return yield* Console.log(
        `Merged deployment ${result.deploymentId}\n    Commit: ${result.commit}\n    Parents: ${first}, ${second}\n    App URL: ${result.url}`
      );
    })
).pipe(Command.withDescription("Merge two ready local deployments"));
