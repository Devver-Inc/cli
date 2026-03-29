import { Effect } from "effect";
import { createDeployment } from "../api/deploy.requests";
import { checkForConfigFile, readConfigFile } from "../config";
import { DeployAbortError } from "../error";
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

      const { projectId, repoName, pushUrl } = await getValidatedRepository();
      const currentBranch = await getCurrentBranch();

      await checkRemoteBranch(pushUrl, currentBranch);
      await checkForConflicts(pushUrl, currentBranch);

      const currentCommit = await getCurrentCommit();
      await confirmAndPush({ repoName, currentBranch, currentCommit, pushUrl });
      await createAndReportDeployment({
        projectId,
        repoName,
        currentBranch,
        currentCommit,
      });
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
    throw new DeployAbortError("Deployment cancelled.");
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
    throw new DeployAbortError(`Failed to push to remote: ${stderr}`);
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
    throw new DeployAbortError(
      "Config file not found. This should not happen."
    );
  }

  const spinner = Prompt.spinner();
  await Effect.runPromise(spinner.start("Creating deployment..."));

  const startTime = performance.now();
  const deployment = await runAuthenticated(
    createDeployment(projectId, {
      repo: repoName,
      branch: currentBranch,
      commit: currentCommit,
      service: config.services,
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
