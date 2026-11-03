import { Console, Effect } from "effect";
import { Command } from "effect/cli";

import { getProjectById } from "../../infra/api/projects.requests";
import { openBrowser } from "../../infra/auth/browser";
import { getOrganizationDetails } from "../../infra/auth/client";
import { getCurrentOrganization } from "../../infra/auth/organization";
import {
  logout as endSession,
  getUser,
  login as startLogin,
} from "../../infra/auth/session";
import { getCurrentProjectId } from "../../infra/state/project";
import { getLinkedRepoForCwd } from "../../infra/state/repository";
import { withApi } from "../api";

const login = Command.make("login", {}, () =>
  Effect.gen(function* () {
    const { authUrl, completed } = yield* startLogin;
    yield* Console.log("Opening browser for login...");
    const opened = yield* Effect.promise(async () => openBrowser(authUrl));
    if (!opened) {
      yield* Console.log(`Open this URL to continue:\n  ${authUrl}`);
    }
    yield* completed;
    yield* Console.log("✓ Login successful!");
  }).pipe(Effect.scoped)
).pipe(Command.withDescription("Log in through the browser"));

const logout = Command.make("logout", {}, () =>
  Effect.gen(function* () {
    const url = yield* Effect.tryPromise(endSession);
    if (url !== undefined && url !== "") {
      yield* Console.log("Opening browser to complete logout...");
      const opened = yield* Effect.promise(async () => openBrowser(url));
      if (!opened) {
        yield* Console.log(`Open this URL to finish signing out:\n  ${url}`);
      }
    }
    yield* Console.log("✓ Logged out");
  })
).pipe(Command.withDescription("Log out of your account"));

const status = Command.make("status", {}, () =>
  Effect.gen(function* () {
    const user = yield* Effect.tryPromise(getUser);
    if (user === null) {
      yield* Console.log("✗ Not logged in");
      return;
    }
    yield* Console.log("✓ Logged in as:", user.username ?? user.sub);
    const organizations = yield* Effect.tryPromise(getOrganizationDetails);
    const currentOrg = yield* Effect.tryPromise(getCurrentOrganization);
    if (organizations.length === 0) {
      yield* Console.log("✗ Not part of any organization");
    } else {
      yield* Console.log("\nOrganizations:");
      for (const org of organizations) {
        yield* Console.log(`${org.id === currentOrg ? "* " : "  "}${org.name}`);
      }
      const selected = organizations.find((org) => org.id === currentOrg);
      yield* Console.log(
        selected === undefined
          ? `\nCurrent organization: ${organizations[0]?.name ?? "Unknown"} (default)`
          : `\nCurrent organization: ${selected.name}`
      );
    }
    const projectId = yield* Effect.tryPromise(getCurrentProjectId);
    if (projectId !== null && projectId !== "") {
      const name = yield* withApi(getProjectById(projectId)).pipe(
        Effect.map((project) => project.name),
        Effect.orElseSucceed(() => `${projectId} (details unavailable)`)
      );
      yield* Console.log(`\nCurrent project: ${name}`);
    }
    const linked = yield* Effect.tryPromise(getLinkedRepoForCwd);
    yield* Console.log(
      `\nCurrent repository: ${linked === null ? "No repository linked to this folder" : linked.repoName}`
    );
  })
).pipe(Command.withDescription("Show your login and account status"));

export const auth = Command.make("auth").pipe(
  Command.withDescription("Manage authentication"),
  Command.withSubcommands([login, logout, status])
);
