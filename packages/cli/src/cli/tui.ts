import { Effect, Option } from "effect";
import { Argument, Command } from "effect/cli";

import pkg from "../../../../package.json" with { type: "json" };
import { getProjects } from "../api/projects.requests";
import { getOrganizationDetails } from "../auth/client";
import { getCurrentOrganization } from "../auth/organization";
import {
  getCurrentProjectId,
  setCurrentProjectId,
} from "../util/project/storage";
import { withApiAt } from "./api";
import { switchOrganization } from "./organization";
import { root } from "./root";
import { versionLine } from "./version";

const projectArgument = Argument.String("project").pipe(Argument.optional);

export const launchTui = (project?: string, apiUrl = Option.none<string>()) =>
  Effect.gen(function* () {
    const organizations = yield* Effect.tryPromise(getOrganizationDetails);
    const currentOrganization = yield* Effect.tryPromise(
      getCurrentOrganization
    );
    const currentProjectId = yield* Effect.tryPromise(getCurrentProjectId);
    const runWithContext = Effect.runPromiseWith(yield* Effect.context());
    const { run } = yield* Effect.promise(async () => import("../tui/index"));
    yield* run({
      project,
      version: versionLine(pkg.version),
      organizations,
      currentOrganization,
      currentProjectId,
      loadProjects: async () =>
        await runWithContext(withApiAt(apiUrl, getProjects)),
      onSwitchProject: async (id) => setCurrentProjectId(id),
      onSwitchOrganization: async (current, id) => {
        await runWithContext(switchOrganization(current, id));
      },
    });
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
