import { Console, Effect } from "effect";

import { createLocalDeployment } from "../api/local-deploy.requests";
import type { LocalTargetSchema } from "../config/api";
import { getCurrentCommit, getRepositoryRoot } from "../util/git";
import { withLocalApi } from "./api";

const MILLISECONDS = 1000;

export const localDeploy = (target: typeof LocalTargetSchema.Type) =>
  withLocalApi(
    target,
    Effect.gen(function* () {
      const source = yield* Effect.tryPromise(getRepositoryRoot);
      const commit = yield* Effect.tryPromise(getCurrentCommit);
      yield* Console.log(
        `\n  Deploying to ${target.name} (${target.instanceId})\n    Repository: ${source}\n    Commit: ${commit}`
      );
      yield* Console.log(
        "  ⚠ Local deployments are not sandboxed: deployed code runs with your own user's access."
      );
      const start = performance.now();
      const deployment = yield* createLocalDeployment({ source, commit });
      yield* Console.log(
        `\nDeployment ready (${((performance.now() - start) / MILLISECONDS).toFixed(1)}s)`
      );
      yield* Console.log(`    Deployment ID: ${deployment.deploymentId}`);
      yield* Console.log(`    Commit: ${deployment.commit}`);
      yield* Console.log(`    App URL: ${deployment.url}`);
    })
  );
