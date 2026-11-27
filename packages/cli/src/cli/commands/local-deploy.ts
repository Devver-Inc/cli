import { Console, Effect } from "effect";

import {
  createLocalDeployment,
  publishLocalDeployment,
} from "../../infra/api/local-deploy.requests";
import { openBrowser } from "../../infra/auth/browser";
import type { LocalTargetSchema } from "../../infra/config/api";
import { withLocalApi } from "../api";
import { getCurrentCommit, getRepositoryRoot } from "../git";

const MILLISECONDS = 1000;

export const localDeploy = (
  target: typeof LocalTargetSchema.Type,
  verbose: boolean,
  open: boolean,
  publicly: boolean
) =>
  withLocalApi(
    target,
    Effect.gen(function* () {
      const source = yield* getRepositoryRoot;
      const commit = yield* getCurrentCommit;
      if (verbose) {
        yield* Console.log(
          `\n  Deploying to ${target.name} (${target.instanceId})\n    Repository: ${source}\n    Commit: ${commit}`
        );
      }
      yield* Console.log(
        "  ⚠ Local deployments are not sandboxed: deployed code runs with your own user's access."
      );
      const start = performance.now();
      const deployment = yield* createLocalDeployment({ source, commit });
      if (verbose) {
        yield* Console.log(
          `\nDeployment ready (${((performance.now() - start) / MILLISECONDS).toFixed(1)}s)`
        );
        yield* Console.log(`    Deployment ID: ${deployment.deploymentId}`);
        yield* Console.log(`    Commit: ${deployment.commit}`);
      } else {
        yield* Console.log("\nDeployment ready");
      }
      yield* Console.log(`    App URL: ${deployment.url}`);
      if (publicly) {
        yield* Console.log(
          "Anyone with the public URL can access this deployment."
        );
        const publication = yield* publishLocalDeployment(
          deployment.deploymentId
        );
        yield* Console.log(`    Public URL: ${publication.url}`);
      }
      if (
        open &&
        !(yield* Effect.promise(async () => openBrowser(deployment.url)))
      ) {
        yield* Console.log("  ⚠ Could not open the app URL in a browser.");
      }
    })
  );
