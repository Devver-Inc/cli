import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename } from "node:path";

import { Effect, Option } from "effect";
import { Argument, Command } from "effect/cli";

import pkg from "../../../../package.json" with { type: "json" };
import { ApiClient } from "../api/client";
import {
  listLocalDeployments,
  renameLocalDeployment,
} from "../api/local-deploy.requests";
import { getProjects } from "../api/projects.requests";
import { getAccessToken, getOrganizationDetails } from "../auth/client";
import { getCurrentOrganization } from "../auth/organization";
import { readConfig } from "../config/api";
import { getRepositoryRoot } from "../util/git";
import {
  getCurrentProjectId,
  setCurrentProjectId,
} from "../util/project/storage";
import { withApiAt, withLocalApi } from "./api";
import { switchOrganization } from "./organization";
import { root } from "./root";
import { availableUpdate } from "./update";
import { versionLine } from "./version";

const projectArgument = Argument.String("project").pipe(Argument.optional);

export const launchTui = (project?: string, apiUrl = Option.none<string>()) =>
  Effect.gen(function* () {
    const config = yield* Effect.tryPromise(readConfig);
    const local = config["local-target"];
    const runWithContext = Effect.runPromiseWith(yield* Effect.context());
    const { run } = yield* Effect.promise(async () => import("../tui/index"));
    const checkUpdate = async () => await runWithContext(availableUpdate);
    if (local !== undefined) {
      const repositoryRoot = yield* getRepositoryRoot.pipe(
        Effect.asSome,
        Effect.catchIf(
          (error) =>
            error.message.startsWith("This folder is not a Git repository"),
          () => Effect.succeed(Option.none<string>())
        )
      );
      const repositoryId = Option.isSome(repositoryRoot)
        ? createHash("sha256")
            .update(
              yield* Effect.tryPromise(
                async () => await realpath(repositoryRoot.value)
              )
            )
            .digest("hex")
        : undefined;
      yield* withLocalApi(
        local,
        Effect.gen(function* () {
          const api = yield* ApiClient;
          yield* run({
            version: versionLine(pkg.version),
            checkUpdate,
            target: {
              kind: "local",
              server: local.name,
              workspace: project ?? basename(process.cwd()),
              repositoryId,
              renameDeployment: async (id, name) =>
                await runWithContext(
                  renameLocalDeployment(id, name).pipe(
                    Effect.provideService(ApiClient, api)
                  )
                ),
              loadDeployments: async () =>
                await runWithContext(
                  listLocalDeployments.pipe(
                    Effect.provideService(ApiClient, api),
                    Effect.catchTag("ApiError", (error) =>
                      error.status === 404 || error.status === 405
                        ? Effect.succeed(null)
                        : Effect.fail(error)
                    )
                  )
                ),
            },
          });
        })
      );
      return;
    }
    if (Option.isNone(apiUrl) && config["cloud-target"] !== true) {
      yield* run({
        version: versionLine(pkg.version),
        checkUpdate,
        target: { kind: "none" },
      });
      return;
    }
    const organizations = yield* Effect.tryPromise(getOrganizationDetails);
    const currentOrganization = yield* Effect.tryPromise(
      getCurrentOrganization
    );
    const currentProjectId = yield* Effect.tryPromise(getCurrentProjectId);
    let token = yield* Effect.tryPromise(getAccessToken);
    yield* withApiAt(
      apiUrl,
      Effect.gen(function* () {
        const api = yield* ApiClient;
        yield* run({
          version: versionLine(pkg.version),
          checkUpdate,
          target: {
            kind: "cloud",
            project,
            organizations,
            currentOrganization,
            currentProjectId,
            loadProjects: async () =>
              await runWithContext(
                getProjects.pipe(Effect.provideService(ApiClient, api))
              ),
            onSwitchProject: async (id) => setCurrentProjectId(id),
            onSwitchOrganization: async (current, id) => {
              token = await runWithContext(switchOrganization(current, id));
            },
          },
        });
      }),
      () => token
    );
  });

export const tui = Command.make(
  "tui",
  { project: projectArgument },
  ({ project }) =>
    Effect.gen(function* () {
      const { apiUrl } = yield* root;
      yield* launchTui(Option.getOrUndefined(project), apiUrl);
    })
).pipe(Command.withDescription("Start the terminal UI"));
