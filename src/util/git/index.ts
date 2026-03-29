import { DeployAbortError } from "../../error";
import { Prompt } from "../prompts";

const aheadBehindRegex = /\s+/;

const getBasename = () =>
  Bun.spawn(["basename", "$(git rev-parse --show-toplevel)"], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });

const getCurrentBranchProcess = () =>
  Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });

const Commands = { getCurrentBranchProcess, getBasename };

export async function checkForGitRepo() {
  const gitCheckProcess = Bun.spawn(
    ["git", "rev-parse", "--is-inside-work-tree"],
    { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" }
  );

  const exitCode = await gitCheckProcess.exited;
  if (exitCode !== 0) {
    console.log("✗ No git repository found in current directory");

    const shouldInit = await Prompt.promptYesNo(
      "Would you like to initialize a git repository?"
    );
    if (!shouldInit) {
      throw new DeployAbortError(
        "Deployment requires a git repository. Aborting."
      );
    }

    const initProcess = Bun.spawn(["git", "init"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const initExit = await initProcess.exited;
    if (initExit !== 0) {
      const stderr = await new Response(initProcess.stderr).text();
      throw new DeployAbortError(
        `Failed to initialize git repository: ${stderr}`
      );
    }
    console.log("  ✓ Git repository initialized");
  }

  await ensureCommitExists();
}

async function ensureCommitExists() {
  const process_ = Bun.spawn(["git", "rev-parse", "HEAD"], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await process_.exited;

  if (exitCode !== 0) {
    console.log("✗ No commits found in this repository");

    const shouldCommit = await Prompt.promptYesNo(
      "Would you like to create an initial commit?"
    );
    if (!shouldCommit) {
      throw new DeployAbortError(
        "Deployment requires at least one commit. Aborting."
      );
    }

    const addProcess = Bun.spawn(["git", "add", "."], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    if ((await addProcess.exited) !== 0) {
      const stderr = await new Response(addProcess.stderr).text();
      throw new DeployAbortError(`Failed to stage files: ${stderr}`);
    }

    const commitProcess = Bun.spawn(["git", "commit", "-m", "Initial commit"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    if ((await commitProcess.exited) !== 0) {
      const stderr = await new Response(commitProcess.stderr).text();
      throw new DeployAbortError(`Failed to create commit: ${stderr}`);
    }

    console.log("  ✓ Initial commit created");
  }
}

export async function getCurrentBranch(): Promise<string> {
  const branchProcess = Commands.getCurrentBranchProcess();
  const exitCode = await branchProcess.exited;
  if (exitCode !== 0) {
    throw new DeployAbortError("Failed to get current branch");
  }

  const branch = (await new Response(branchProcess.stdout).text()).trim();
  console.log(`  Current branch: ${branch}`);
  return branch;
}

export async function getCurrentCommit(): Promise<string> {
  const commitProcess = Bun.spawn(["git", "rev-parse", "HEAD"], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  await commitProcess.exited;
  return (await new Response(commitProcess.stdout).text()).trim();
}

export async function checkRemoteBranch(pushUrl: string, branch: string) {
  const lsRemoteProcess = Bun.spawn(
    ["git", "ls-remote", "--heads", pushUrl, branch],
    { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" }
  );
  await lsRemoteProcess.exited;

  const output = (await new Response(lsRemoteProcess.stdout).text()).trim();

  if (output.length > 0) {
    console.log(`  ✓ Branch '${branch}' exists on remote`);
  } else {
    console.log(`  Branch '${branch}' does not exist on remote yet`);

    const shouldCreate = await Prompt.promptYesNo(
      `Would you like to create branch '${branch}' on the remote?`
    );
    if (!shouldCreate) {
      throw new DeployAbortError(
        "Deployment requires the branch to exist. Aborting."
      );
    }

    console.log(`  ✓ Branch '${branch}' will be created with the deployment`);
  }
}

export async function checkForConflicts(pushUrl: string, branch: string) {
  const fetchProcess = Bun.spawn(["git", "fetch", pushUrl, branch], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const fetchExit = await fetchProcess.exited;

  if (fetchExit !== 0) {
    return;
  }

  const mergeBaseProcess = Bun.spawn(
    ["git", "merge-base", "HEAD", "FETCH_HEAD"],
    { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" }
  );
  if ((await mergeBaseProcess.exited) !== 0) {
    return;
  }

  const aheadBehindProcess = Bun.spawn(
    ["git", "rev-list", "--left-right", "--count", "HEAD...FETCH_HEAD"],
    { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" }
  );
  await aheadBehindProcess.exited;

  const aheadBehind = (
    await new Response(aheadBehindProcess.stdout).text()
  ).trim();
  const [, behind] = aheadBehind.split(aheadBehindRegex).map(Number);

  if (behind && behind > 0) {
    console.log(`  ⚠ Your branch is ${behind} commit(s) behind the remote`);
    throw new DeployAbortError(
      "Please pull and resolve conflicts before deploying."
    );
  }

  console.log(`  ✓ No conflicts with remote ${branch}`);
}

export const Git = { aheadBehindRegex, Commands };
