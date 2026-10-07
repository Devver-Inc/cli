import { Console, Effect } from "effect";
import { Command } from "effect/cli";
import { createRepository, listRepos } from "../api/deploy.requests";
import { getCurrentProjectId } from "../util/project/storage";
import { Prompt } from "../util/prompts";
import {
  getLinkedRepoForCwd,
  linkRepoForCwd,
} from "../util/repository/storage";
import { withApi } from "./api";

const newRepo = "new_repo";
const list = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const projectId = yield* Effect.tryPromise(getCurrentProjectId);
    if (!projectId) {
      yield* Console.log("✗ No projects found");
      return;
    }
    return yield* withApi(
      Effect.gen(function* () {
        const repositories = yield* listRepos(projectId);
        const linked = yield* Effect.tryPromise(getLinkedRepoForCwd);
        yield* Prompt.intro("Select active repository");
        const choice = yield* Prompt.select({
          message: "Select active repository",
          options: [
            ...repositories.map((repo) => ({
              value: repo.name,
              label:
                linked?.repoName === repo.name
                  ? `${repo.name} (linked)`
                  : repo.name,
            })),
            { value: newRepo, label: "Create a new repository" },
          ],
        });
        if (choice === "Canceled") {
          yield* Prompt.outro("Selection canceled");
          return;
        }
        if (choice === newRepo) {
          const name = yield* Prompt.input("What is the name of the new repo?");
          if (!name || name === "Canceled") {
            yield* Prompt.outro("Selection canceled");
            return;
          }
          const created = yield* createRepository(projectId, { name });
          yield* Effect.tryPromise(() =>
            linkRepoForCwd(created.name, created.pushUrl)
          );
          yield* Prompt.outro(`Now using repository: ${created.name}`);
          return;
        }
        const repo = repositories.find((item) => item.name === choice);
        if (!repo) {
          return yield* Effect.fail(
            new Error("Repository selection is no longer valid")
          );
        }
        yield* Effect.tryPromise(() => linkRepoForCwd(repo.name, repo.pushUrl));
        yield* Prompt.outro(`Now using repository: ${repo.name}`);
      })
    );
  })
);

export const repos = Command.make("repos").pipe(
  Command.withDescription("Manage repositories"),
  Command.withSubcommands([list])
);
