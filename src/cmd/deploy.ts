import { Effect } from "effect";
import { createDeployment, listMongoDatabases } from "../api/deploy.requests";
import { getProjectById } from "../api/projects.requests";
import { checkForConfigFile, ensureGitignore, readConfigFile } from "../config";
import { getDeploymentEnv, mergeEnv } from "../config/secrets";
import { FormatError } from "../error";
import { UI } from "../ui";
import {
  checkForConflicts,
  checkForGitRepo,
  checkRemoteBranch,
  getCurrentBranch,
  getCurrentCommit,
} from "../util/git";
import { Prompt } from "../util/prompts";
import { getValidatedRepository } from "../util/repository/validation";
import { disposeRuntime, runAuthenticated } from "../util/runtime";
import { cmd } from "./cmd";

export const DeployCommand = cmd({
  command: "deploy",
  describe: "Create a deployment for the current commit",
  async handler() {
    try {
      await checkForConfigFile();
      await checkForGitRepo();
      ensureGitignore();

      const { projectId, repoName, pushUrl } = await getValidatedRepository();
      const currentBranch = await getCurrentBranch();

      await checkRemoteBranch(pushUrl, currentBranch);
      await checkForConflicts(pushUrl, currentBranch);

      const currentCommit = await getCurrentCommit();
      await confirmAndPush({
        repoName,
        currentBranch,
        currentCommit,
        pushUrl,
      });
      await createAndReportDeployment({
        projectId,
        repoName,
        currentBranch,
        currentCommit,
      });
    } catch (e) {
      // Log the raw error so opaque failures (e.g. "Error: [object Object]")
      // can be diagnosed. Set DEVVER_DEBUG for even more detail.
      if (process.env.DEVVER_DEBUG) {
        console.error("[devver] raw deploy error:", e);
      }
      const msg = FormatError(e);
      if (msg) {
        UI.error(msg);
      } else {
        UI.error(`Deployment failed: ${String(e)}`);
      }
    } finally {
      await disposeRuntime();
    }
  },
});

// ---------------------------------------------------------------------------
// Push & deploy (deploy-specific orchestration – stays here)
// ---------------------------------------------------------------------------

async function confirmAndPush(opts: {
  repoName: string;
  currentBranch: string;
  currentCommit: string;
  pushUrl: string;
}) {
  const { repoName, currentBranch, currentCommit, pushUrl } = opts;

  console.log("\n  Deployment Summary:");
  console.log(`    Repository: ${repoName}`);
  console.log(`    Branch: ${currentBranch}`);
  console.log(`    Commit: ${currentCommit.substring(0, 7)}`);
  console.log(`    Push URL: ${pushUrl}`);

  const shouldProceed = await Prompt.promptYesNo("Proceed with deployment?");
  if (!shouldProceed) {
    UI.println(
      `${UI.Style.TEXT_WARNING}Deployment cancelled.${UI.Style.TEXT_NORMAL}`
    );
    process.exit(0);
  }

  const spinner = Prompt.spinner();
  await Effect.runPromise(spinner.start(`Pushing to ${pushUrl}...`));

  const pushProcess = Bun.spawn(
    ["git", "push", pushUrl, `${currentBranch}:${currentBranch}`],
    { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" }
  );
  const pushExitCode = await pushProcess.exited;
  if (pushExitCode !== 0) {
    await Effect.runPromise(spinner.stop("Push failed"));
    const stderr = await new Response(pushProcess.stderr).text();
    UI.error(`Failed to push to remote: ${stderr}`);
    process.exit(1);
  }

  await Effect.runPromise(spinner.stop(`Successfully pushed to ${repoName}`));
}

async function createAndReportDeployment(opts: {
  projectId: string;
  repoName: string;
  currentBranch: string;
  currentCommit: string;
}) {
  const { projectId, repoName, currentBranch, currentCommit } = opts;

  const config = readConfigFile();
  if (!config) {
    UI.error("Config file not found. Run 'devver init' to create one.");
    process.exit(1);
  }

  const projectEnv: Record<string, string> = config.env ?? {};
  const deploymentEnv = getDeploymentEnv(repoName);
  const mergedEnv = mergeEnv(projectEnv, deploymentEnv);

  const dbLinks = await resolveDbLinks(projectId);

  const spinner = Prompt.spinner();
  await Effect.runPromise(spinner.start("Creating deployment..."));

  const startTime = performance.now();
  const deployment = await runAuthenticated(
    createDeployment(projectId, {
      repo: repoName,
      branch: currentBranch,
      commit: currentCommit,
      service: config.services,
      env: Object.keys(mergedEnv).length > 0 ? mergedEnv : undefined,
      dbLinks: dbLinks ?? undefined,
    })
  );
  const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);

  await Effect.runPromise(
    spinner.stop(`Deployment created successfully! (${elapsed}s)`)
  );
  console.log(`    Deployment ID: ${deployment.deploymentId}`);
  if (deployment.service.web) {
    console.log(`    Web URL: ${deployment.service.web.url}`);
  }
  if (deployment.service.api) {
    console.log(`    API URL: ${deployment.service.api.url}`);
  }
}

async function resolveDbLinks(
  projectId: string
): Promise<Record<string, string> | undefined> {
  const project = await runAuthenticated(getProjectById(projectId));

  if (!project.databaseConfiguration?.enabled) {
    return undefined;
  }

  const dbType = project.databaseConfiguration.type;
  console.log(`\n  Database detected: ${dbType} (enabled)`);

  if (dbType === "mongo") {
    return resolveMongoLinks(projectId);
  }

  // TODO: handle other database types
  console.log(`  Database type '${dbType}' linking not yet supported.`);
  return undefined;
}

async function resolveMongoLinks(
  projectId: string
): Promise<Record<string, string> | undefined> {
  let databases: ReadonlyArray<{
    name: string;
    sizeOnDisk: number;
    empty: boolean;
  }>;

  try {
    databases = await runAuthenticated(listMongoDatabases(projectId));
  } catch {
    console.log("  ⚠ Could not fetch databases from the server.");
    return undefined;
  }

  if (databases.length === 0) {
    console.log("  No databases found on this project's MongoDB instance.");
    const shouldCreate = await Prompt.promptYesNo(
      "Would you like to specify a database name?"
    );
    if (!shouldCreate) {
      return undefined;
    }
    const dbName = await Effect.runPromise(
      Prompt.input("Database name for MONGO_URL")
    );
    if (!dbName || dbName === "Canceled") {
      return undefined;
    }
    return { MONGO_URL: dbName };
  }

  const choices = [
    ...databases.map((db) => ({
      value: db.name,
      label: db.empty ? `${db.name} (empty)` : db.name,
    })),
    { value: "__new__", label: "Enter a new database name…" },
    { value: "__skip__", label: "Skip database linking" },
  ];

  const selection = await Effect.runPromise(
    Prompt.select({
      message: "Select a database to link:",
      options: choices,
    })
  );

  if (selection === "Canceled" || selection === "__skip__") {
    return undefined;
  }

  if (selection === "__new__") {
    const dbName = await Effect.runPromise(
      Prompt.input("New database name for MONGO_URL")
    );
    if (!dbName || dbName === "Canceled") {
      return undefined;
    }
    return { MONGO_URL: dbName };
  }

  return { MONGO_URL: selection as string };
}
