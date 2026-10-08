import { spawn } from "node:child_process";

import { DeployAbortError } from "../../error";
import { Prompt } from "../prompts";

const commitHash = /^[a-f0-9]{40,64}$/iu;
const aheadBehind = /^(?<ahead>\d+)\s+(?<behind>\d+)$/u;

async function git(...args: string[]): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: process.cwd() });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf-8").trim(),
        stderr: Buffer.concat(stderr).toString("utf-8").trim(),
      });
    });
  });
}

function requireSuccess(
  result: Awaited<ReturnType<typeof git>>,
  command: string
): string {
  if (result.code !== 0) {
    throw new DeployAbortError(
      `Git ${command} failed (exit ${result.code ?? "signal"})`
    );
  }
  return result.stdout;
}

export async function checkForGitRepo() {
  const result = await git("rev-parse", "--is-inside-work-tree");
  if (result.code !== 0) {
    if (!result.stderr.includes("not a git repository")) {
      requireSuccess(result, "rev-parse");
    }
    console.log("✗ No git repository found in current directory");
    if (
      !(await Prompt.promptYesNo(
        "Would you like to initialize a git repository?"
      ))
    ) {
      throw new DeployAbortError(
        "Deployment requires a git repository. Aborting."
      );
    }
    requireSuccess(await git("init"), "init");
    console.log("  ✓ Git repository initialized");
  } else if (result.stdout !== "true") {
    throw new DeployAbortError(
      "Current directory is not inside a Git work tree"
    );
  }

  // An unborn branch has no commits; other rev-parse failures must not be
  // mistaken for permission/transport success.
  const head = await git("rev-parse", "--verify", "HEAD");
  if (head.code !== 0) {
    if (!head.stderr.includes("Needed a single revision")) {
      requireSuccess(head, "rev-parse HEAD");
    }
    console.log("✗ No commits found in this repository");
    if (
      !(await Prompt.promptYesNo("Would you like to create an initial commit?"))
    ) {
      throw new DeployAbortError(
        "Deployment requires at least one commit. Aborting."
      );
    }
    requireSuccess(await git("add", "."), "add");
    requireSuccess(await git("commit", "-m", "Initial commit"), "commit");
    console.log("  ✓ Initial commit created");
  } else if (head.stdout === "") {
    throw new DeployAbortError("Git rev-parse HEAD returned an empty commit");
  }
}

export async function getCurrentBranch(): Promise<string> {
  const branch = requireSuccess(
    await git("rev-parse", "--abbrev-ref", "HEAD"),
    "rev-parse branch"
  );
  if (branch === "" || branch === "HEAD") {
    throw new DeployAbortError("Cannot deploy without a named Git branch");
  }
  console.log(`  Current branch: ${branch}`);
  return branch;
}

export async function getCurrentCommit(): Promise<string> {
  const commit = requireSuccess(
    await git("rev-parse", "--verify", "HEAD"),
    "rev-parse HEAD"
  );
  if (!commitHash.test(commit)) {
    throw new DeployAbortError("Git rev-parse returned an invalid commit");
  }
  return commit;
}

/** True only if the remote has this branch; network/auth errors always fail. */
export async function checkRemoteBranch(
  pushUrl: string,
  branch: string,
  confirm: (message: string) => Promise<boolean> = Prompt.promptYesNo
): Promise<boolean> {
  const output = requireSuccess(
    await git("ls-remote", "--heads", pushUrl, `refs/heads/${branch}`),
    "ls-remote"
  );
  if (output !== "") {
    console.log(`  ✓ Branch '${branch}' exists on remote`);
    return true;
  }
  console.log(`  Branch '${branch}' does not exist on remote yet`);
  if (
    !(await confirm(
      `Would you like to create branch '${branch}' on the remote?`
    ))
  ) {
    throw new DeployAbortError(
      "Deployment requires the branch to exist. Aborting."
    );
  }
  console.log(`  ✓ Branch '${branch}' will be created with the deployment`);
  return false;
}

export async function pushBranch(
  pushUrl: string,
  branch: string
): Promise<void> {
  const result = await git("push", pushUrl, `${branch}:${branch}`);
  if (result.code !== 0) {
    throw new DeployAbortError(
      `Failed to push to remote: ${result.stderr || `git push exited ${result.code ?? "on a signal"}`}`
    );
  }
}

export async function checkForConflicts(
  pushUrl: string,
  branch: string,
  remoteBranchExists: boolean
): Promise<void> {
  if (!remoteBranchExists) {
    return;
  }
  requireSuccess(await git("fetch", pushUrl, `refs/heads/${branch}`), "fetch");
  requireSuccess(await git("merge-base", "HEAD", "FETCH_HEAD"), "merge-base");
  const counts = aheadBehind.exec(
    requireSuccess(
      await git("rev-list", "--left-right", "--count", "HEAD...FETCH_HEAD"),
      "rev-list"
    )
  );
  if (counts === null) {
    throw new DeployAbortError(
      "Git rev-list returned invalid ahead/behind counts"
    );
  }
  const behind = Number(counts.groups?.behind);
  if (!Number.isSafeInteger(behind)) {
    throw new DeployAbortError("Git rev-list returned invalid behind count");
  }
  if (behind > 0) {
    console.log(`  ⚠ Your branch is ${behind} commit(s) behind the remote`);
    throw new DeployAbortError(
      "Please pull and resolve conflicts before deploying."
    );
  }
  console.log(`  ✓ No conflicts with remote ${branch}`);
}
