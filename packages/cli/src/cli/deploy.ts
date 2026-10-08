import { Console, Data, Effect } from "effect";
import { Command } from "effect/cli";

import {
  createDeployment,
  createRepository,
  listMongoDatabases,
  listRepos,
} from "../api/deploy.requests";
import { getProjectById } from "../api/projects.requests";
import { checkForConfigFile, readConfigFile } from "../config";
import { getDeploymentEnv, mergeEnv } from "../config/secrets";
import {
  checkForConflicts,
  checkForGitRepo,
  checkRemoteBranch,
  getCurrentBranch,
  getCurrentCommit,
  pushBranch,
} from "../util/git";
import { getCurrentProjectId } from "../util/project/storage";
import { Prompt } from "../util/prompts";
import {
  getLinkedRepoForCwd,
  linkRepoForCwd,
} from "../util/repository/storage";
import { withApi } from "./api";

class DeploymentError extends Data.TaggedError("DeploymentError")<{
  message: string;
}> {}

const resolveRepository = Effect.gen(function* () {
  const projectId = yield* Effect.tryPromise(getCurrentProjectId);
  if (projectId === null || projectId === "") {
    return yield* Effect.fail(
      new DeploymentError({ message: "No projects found" })
    );
  }
  const linked = yield* Effect.tryPromise(getLinkedRepoForCwd);
  const repositories = yield* listRepos(projectId);
  const current = repositories.find((repo) => repo.name === linked?.repoName);
  if (current) {
    yield* Console.log(`  Linked repository: ${current.name}`);
    return { projectId, repoName: current.name, pushUrl: current.pushUrl };
  }
  yield* Console.log(
    linked === null
      ? "  No repository linked to this folder."
      : `  ⚠ Repository '${linked.repoName}' no longer exists on the server.`
  );
  const choice = yield* Prompt.select({
    message: "Select a repository to link to this folder",
    options: [
      ...repositories.map((repo) => ({ value: repo.name, label: repo.name })),
      { value: "new_repo", label: "Create a new repository" },
    ],
  });
  if (choice === "Canceled") {
    return yield* Effect.fail(
      new DeploymentError({ message: "Repository selection cancelled." })
    );
  }
  if (choice === "new_repo") {
    const name = yield* Prompt.input("What is the name of the new repository?");
    if (name === "" || name === "Canceled") {
      return yield* Effect.fail(
        new DeploymentError({ message: "Repository creation cancelled." })
      );
    }
    const created = yield* createRepository(projectId, { name });
    yield* Effect.tryPromise(async () =>
      linkRepoForCwd(created.name, created.pushUrl)
    );
    return { projectId, repoName: created.name, pushUrl: created.pushUrl };
  }
  const repo = repositories.find((item) => item.name === choice);
  if (!repo) {
    return yield* Effect.fail(
      new DeploymentError({ message: `Repository '${choice}' not found.` })
    );
  }
  yield* Effect.tryPromise(async () => linkRepoForCwd(repo.name, repo.pushUrl));
  return { projectId, repoName: repo.name, pushUrl: repo.pushUrl };
});

const readDbName = (message: string) =>
  Prompt.input(message).pipe(
    Effect.map((name) =>
      name !== "" && name !== "Canceled" ? { MONGO_URL: name } : undefined
    )
  );

const resolveDbLinks = (projectId: string) =>
  Effect.gen(function* () {
    const project = yield* getProjectById(projectId);
    if (project.databaseConfiguration?.enabled !== true) {
      // oxlint-disable-next-line unicorn/no-useless-undefined
      return undefined;
    }
    yield* Console.log(
      `\n  Database detected: ${project.databaseConfiguration.type} (enabled)`
    );
    if (project.databaseConfiguration.type !== "mongo") {
      yield* Console.log("  Database type linking not yet supported.");
      // oxlint-disable-next-line unicorn/no-useless-undefined
      return undefined;
    }
    const databases = yield* listMongoDatabases(projectId).pipe(
      Effect.orElseSucceed(() => [])
    );
    if (databases.length === 0) {
      yield* Console.log(
        "  No databases found on this project's MongoDB instance."
      );
      const create = yield* Prompt.select({
        message: "Would you like to specify a database name?",
        options: Prompt.Questions.YNOpts,
      });
      if (create !== "Yes") {
        // oxlint-disable-next-line unicorn/no-useless-undefined
        return undefined;
      }
      return yield* readDbName("Database name for MONGO_URL");
    }
    const choice = yield* Prompt.select({
      message: "Select a database to link:",
      options: [
        ...databases.map((db) => ({
          value: db.name,
          label: db.empty ? `${db.name} (empty)` : db.name,
        })),
        { value: "__new__", label: "Enter a new database name…" },
        { value: "__skip__", label: "Skip database linking" },
      ],
    });
    if (choice === "Canceled" || choice === "__skip__") {
      // oxlint-disable-next-line unicorn/no-useless-undefined
      return undefined;
    }
    return choice === "__new__"
      ? yield* readDbName("New database name for MONGO_URL")
      : { MONGO_URL: choice };
  });

export const deploy = Command.make("deploy", {}, () =>
  withApi(
    Effect.gen(function* () {
      yield* Effect.tryPromise(checkForConfigFile);
      yield* Effect.tryPromise(checkForGitRepo);
      const config = yield* Effect.try(() => readConfigFile());
      if (config === null) {
        return yield* Effect.fail(
          new DeploymentError({
            message: "Config file not found. Run 'devver init' to create one.",
          })
        );
      }
      const { projectId, repoName, pushUrl } = yield* resolveRepository;
      const branch = yield* Effect.tryPromise(getCurrentBranch);
      const remoteBranchExists = yield* Effect.tryPromise(async () =>
        checkRemoteBranch(pushUrl, branch)
      );
      yield* Effect.tryPromise(async () =>
        checkForConflicts(pushUrl, branch, remoteBranchExists)
      );
      const commit = yield* Effect.tryPromise(getCurrentCommit);
      yield* Console.log(
        `\n  Deployment Summary:\n    Repository: ${repoName}\n    Branch: ${branch}\n    Commit: ${commit.slice(0, 7)}\n    Push URL: ${pushUrl}`
      );
      const confirm = yield* Prompt.select({
        message: "Proceed with deployment?",
        options: Prompt.Questions.YNOpts,
      });
      if (confirm !== "Yes") {
        yield* Console.log("Deployment cancelled.");
        // A cancellation must stop before push or deployment creation.
        // oxlint-disable-next-line typescript/consistent-return
        return;
      }
      yield* Effect.tryPromise(async () => pushBranch(pushUrl, branch));
      yield* Console.log(`Successfully pushed to ${repoName}`);
      const env = mergeEnv(config.env ?? {}, getDeploymentEnv(repoName));
      const dbLinks = yield* resolveDbLinks(projectId);
      const start = performance.now();
      const result = yield* createDeployment(projectId, {
        repo: repoName,
        branch,
        commit,
        service: config.services,
        env: Object.keys(env).length ? env : undefined,
        dbLinks,
      });
      yield* Console.log(
        `Deployment created successfully! (${((performance.now() - start) / 1000).toFixed(1)}s)`
      );
      yield* Console.log(`    Deployment ID: ${result.deploymentId}`);
      if (result.service.web) {
        yield* Console.log(`    Web URL: ${result.service.web.url}`);
      }
      if (result.service.api) {
        yield* Console.log(`    API URL: ${result.service.api.url}`);
      }
    })
  )
);
