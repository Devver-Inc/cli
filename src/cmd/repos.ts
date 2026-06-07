import { Effect } from "effect";
import { createRepository, listRepos } from "../api/deploy.requests";
import { FormatError } from "../error";
import { UI } from "../ui";
import { getCurrentProjectId } from "../util/project/storage";
import { Prompt } from "../util/prompts";
import {
  getLinkedRepoForCwd,
  linkRepoForCwd,
} from "../util/repository/storage";
import { disposeRuntime, runAuthenticated } from "../util/runtime";
import { cmd } from "./cmd";

const NEW_REPO = "new_repo";

const ListRepositoriesCommand = cmd({
  command: "list",
  describe: "list all repositories",
  async handler() {
    const currentProjectId = await getCurrentProjectId();
    if (!currentProjectId) {
      console.log("✗ No projects found");
      await disposeRuntime();
      return;
    }

    const repositories = await runAuthenticated(
      listRepos(currentProjectId)
    ).catch((error) => {
      UI.error(FormatError(error) ?? "Failed to fetch repositories");
      process.exit(1);
    });
    const linked = await getLinkedRepoForCwd();
    const spinner = Prompt.spinner();

    const choice = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Prompt.intro("Select active repository");
        const mappedRepositories: { value: string; label: string }[] =
          repositories.map((repository) => ({
            value: repository.name,
            label:
              linked && linked.repoName === repository.name
                ? `${repository.name} (linked)`
                : repository.name,
          }));
        mappedRepositories.push({
          value: NEW_REPO,
          label: "Create a new repository",
        });

        const choice = yield* Prompt.select({
          message: "Select active repository",
          options: mappedRepositories,
        });

        if (choice === "Canceled") {
          yield* Prompt.outro(" selection canceled");
          return null;
        }

        if (choice === NEW_REPO) {
          yield* spinner.start("Creating repository :::");
          return choice;
        }

        yield* spinner.start("Linking repository...");

        const selectedRepository = repositories.find((p) => p.name === choice);

        yield* spinner.stop("Repository linked successfully");
        yield* Prompt.outro(
          `Now using repository: ${selectedRepository?.name ?? choice}`
        );
        return choice;
      })
    );

    if (choice === NEW_REPO) {
      const name = await Effect.runPromise(
        Prompt.input("What is the name of the new repo ?")
      );
      const newRepository = await runAuthenticated(
        createRepository(currentProjectId, { name })
      ).catch((error) => {
        UI.error(FormatError(error) ?? "Failed to create repository");
        process.exit(1);
      });
      await linkRepoForCwd(newRepository.name, newRepository.pushUrl);
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* spinner.stop("Repository created successfully");
          yield* Prompt.outro(
            `Now using repository: ${newRepository?.name ?? choice}`
          );
        })
      );
    } else if (choice) {
      const selectedRepo = repositories.find((r) => r.name === choice);
      if (selectedRepo) {
        await linkRepoForCwd(selectedRepo.name, selectedRepo.pushUrl);
      }
    }

    await disposeRuntime();
    process.exit(0);
  },
});

export const RepositoryCommand = cmd({
  command: "repos",
  describe: "Manage Repositories",
  builder: (yargs) => yargs.command(ListRepositoriesCommand).demandCommand(),
  async handler() {
    await new Promise(() => ({}));
  },
});
