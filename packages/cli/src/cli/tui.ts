import { basename } from "node:path";

import { Effect, Option } from "effect";
import { Argument, Command } from "effect/cli";

import pkg from "../../../../package.json" with { type: "json" };
import { getProjects } from "../api/projects.requests";
import { getOrganizationDetails } from "../auth/client";
import { getCurrentOrganization } from "../auth/organization";
import { readConfig } from "../config/api";
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
    const config = yield* Effect.tryPromise(readConfig);
    const local = config["local-target"];
    const runWithContext = Effect.runPromiseWith(yield* Effect.context());
    const { run } = yield* Effect.promise(async () => import("../tui/index"));
    if (local !== undefined) {
      yield* run({
        version: versionLine(pkg.version),
        target: {
          kind: "local",
          server: local.name,
          workspace: project ?? basename(process.cwd()),
        },
      });
      return;
    }
    if (Option.isNone(apiUrl) && config["cloud-target"] !== true) {
      yield* run({
        version: versionLine(pkg.version),
        target: { kind: "none" },
      });
      return;
    }
    const organizations = yield* Effect.tryPromise(getOrganizationDetails);
    const currentOrganization = yield* Effect.tryPromise(
      getCurrentOrganization
    );
    const currentProjectId = yield* Effect.tryPromise(getCurrentProjectId);
    yield* run({
      version: versionLine(pkg.version),
      target: {
        kind: "cloud",
        project,
        organizations,
        currentOrganization,
        currentProjectId,
        loadProjects: async () =>
          await runWithContext(withApiAt(apiUrl, getProjects)),
        onSwitchProject: async (id) => setCurrentProjectId(id),
        onSwitchOrganization: async (current, id) => {
          await runWithContext(switchOrganization(current, id));
        },
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
