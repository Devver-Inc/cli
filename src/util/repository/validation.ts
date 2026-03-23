import { Effect } from "effect";
import { createRepository, listRepos } from "../../api/deploy.requests";
import { DeployAbortError } from "../../error";
import { getCurrentProjectId } from "../project/storage";
import { Prompt } from "../prompts";
import { runAuthenticated } from "../runtime";
import { getLinkedRepoForCwd, linkRepoForCwd } from "./storage";

// ---------------------------------------------------------------------------
// Validated repository resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the repository linked to the current folder, validating that it
 * still exists on the server. If no link exists yet, prompt the user to
 * select or create a repository.
 */
export async function getValidatedRepository(): Promise<{
  projectId: string;
  repoName: string;
  pushUrl: string;
}> {
  const projectId = await getCurrentProjectId();
  if (!projectId) {
    throw new DeployAbortError("No projects found");
  }

  // Check if this folder is already linked to a repo
  const linked = await getLinkedRepoForCwd();
  if (linked) {
    console.log(`  Linked repository: ${linked.repoName}`);

    // Validate it still exists on the server
    const repositories = await runAuthenticated(listRepos(projectId));
    const repo = repositories.find((r) => r.name === linked.repoName);
    if (!repo) {
      console.log(
        `  ⚠ Repository '${linked.repoName}' no longer exists on the server.`
      );
      return promptAndLinkRepo(projectId);
    }

    return { projectId, repoName: linked.repoName, pushUrl: repo.pushUrl };
  }

  // No link for this folder yet – ask the user to pick or create one
  console.log("  No repository linked to this folder.");
  return promptAndLinkRepo(projectId);
}

// ---------------------------------------------------------------------------
// Prompt to select / create and link a repo
// ---------------------------------------------------------------------------

const NEW_REPO = "new_repo";

async function promptAndLinkRepo(projectId: string): Promise<{
  projectId: string;
  repoName: string;
  pushUrl: string;
}> {
  const repositories = await runAuthenticated(listRepos(projectId));

  const options: { value: string; label: string }[] = repositories.map((r) => ({
    value: r.name,
    label: r.name,
  }));
  options.push({ value: NEW_REPO, label: "Create a new repository" });

  const choice = await Effect.runPromise(
    Prompt.select({
      message: "Select a repository to link to this folder",
      options,
    })
  );

  if (choice === "Canceled") {
    throw new DeployAbortError("Repository selection cancelled.");
  }

  if (choice === NEW_REPO) {
    const name = await Effect.runPromise(
      Prompt.input("What is the name of the new repository?")
    );
    if (name === "Canceled") {
      throw new DeployAbortError("Repository creation cancelled.");
    }
    const newRepo = await runAuthenticated(
      createRepository(projectId, { name })
    );
    await linkRepoForCwd(newRepo.name, newRepo.pushUrl);
    console.log(`  ✓ Created and linked '${newRepo.name}' to ${process.cwd()}`);
    return { projectId, repoName: newRepo.name, pushUrl: newRepo.pushUrl };
  }

  const repo = repositories.find((r) => r.name === choice);
  if (!repo) {
    throw new DeployAbortError(`Repository '${choice}' not found.`);
  }

  await linkRepoForCwd(repo.name, repo.pushUrl);
  console.log(`  ✓ Linked '${repo.name}' to ${process.cwd()}`);

  return { projectId, repoName: repo.name, pushUrl: repo.pushUrl };
}
