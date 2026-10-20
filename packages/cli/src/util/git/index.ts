import { spawn } from "node:child_process";

import { Console, Data, Effect } from "effect";

import { Prompt } from "../prompts";

export class DeployAbortError extends Data.TaggedError("DeployAbortError")<{
  message: string;
}> {}

const commitHash = /^[a-f0-9]{40,64}$/iu;
const aheadBehind = /^(?<ahead>\d+)\s+(?<behind>\d+)$/u;

const git = (...args: string[]) =>
  Effect.tryPromise({
    try: async (signal) =>
      await new Promise<{
        code: number | null;
        stdout: string;
        stderr: string;
      }>((resolve, reject) => {
        const child = spawn("git", args, { cwd: process.cwd(), signal });
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
      }),
    catch: () =>
      new DeployAbortError({ message: "Git subprocess could not start" }),
  });

const requireSuccess = (command: string, ...args: string[]) =>
  Effect.gen(function* () {
    const result = yield* git(...args);
    if (result.code !== 0) {
      return yield* new DeployAbortError({
        message: `Git ${command} failed (exit ${result.code ?? "signal"})`,
      });
    }
    return result.stdout;
  });

export const checkForGitRepo = Effect.gen(function* () {
  const result = yield* git("rev-parse", "--is-inside-work-tree");
  if (result.code !== 0) {
    if (!result.stderr.includes("not a git repository")) {
      return yield* new DeployAbortError({
        message: `Git rev-parse failed (exit ${result.code ?? "signal"})`,
      });
    }
    yield* Console.log("✗ No git repository found in current directory");
    const initialize = yield* Prompt.select({
      message: "Would you like to initialize a git repository?",
      options: Prompt.Questions.YNOpts,
    });
    if (initialize !== "Yes") {
      return yield* new DeployAbortError({
        message: "Deployment requires a git repository. Aborting.",
      });
    }
    yield* requireSuccess("init", "init");
    yield* Console.log("  ✓ Git repository initialized");
  } else if (result.stdout !== "true") {
    return yield* new DeployAbortError({
      message: "Current directory is not inside a Git work tree",
    });
  }

  const head = yield* git("rev-parse", "--verify", "HEAD");
  if (head.code !== 0) {
    if (!head.stderr.includes("Needed a single revision")) {
      return yield* new DeployAbortError({
        message: `Git rev-parse HEAD failed (exit ${head.code ?? "signal"})`,
      });
    }
    yield* Console.log("✗ No commits found in this repository");
    const commit = yield* Prompt.select({
      message: "Would you like to create an initial commit?",
      options: Prompt.Questions.YNOpts,
    });
    if (commit !== "Yes") {
      return yield* new DeployAbortError({
        message: "Deployment requires at least one commit. Aborting.",
      });
    }
    yield* requireSuccess("add", "add", ".");
    yield* requireSuccess("commit", "commit", "-m", "Initial commit");
    yield* Console.log("  ✓ Initial commit created");
  } else if (head.stdout === "") {
    return yield* new DeployAbortError({
      message: "Git rev-parse HEAD returned an empty commit",
    });
  }
  return undefined;
});

export const getCurrentBranch = Effect.gen(function* () {
  const branch = yield* requireSuccess(
    "rev-parse branch",
    "rev-parse",
    "--abbrev-ref",
    "HEAD"
  );
  if (branch === "" || branch === "HEAD") {
    return yield* new DeployAbortError({
      message: "Cannot deploy without a named Git branch",
    });
  }
  yield* Console.log(`  Current branch: ${branch}`);
  return branch;
});

export const getRepositoryRoot = Effect.gen(function* () {
  const root = yield* requireSuccess(
    "rev-parse --show-toplevel",
    "rev-parse",
    "--show-toplevel"
  );
  if (root === "") {
    return yield* new DeployAbortError({
      message: "Cannot deploy outside a Git work tree",
    });
  }
  return root;
});

export const getCurrentCommit = Effect.gen(function* () {
  const commit = yield* requireSuccess(
    "rev-parse HEAD",
    "rev-parse",
    "--verify",
    "HEAD"
  );
  if (!commitHash.test(commit)) {
    return yield* new DeployAbortError({
      message: "Git rev-parse returned an invalid commit",
    });
  }
  return commit;
});

export const checkRemoteBranch = (pushUrl: string, branch: string) =>
  Effect.gen(function* () {
    const output = yield* requireSuccess(
      "ls-remote",
      "ls-remote",
      "--heads",
      pushUrl,
      `refs/heads/${branch}`
    );
    if (output !== "") {
      yield* Console.log(`  ✓ Branch '${branch}' exists on remote`);
      return true;
    }
    yield* Console.log(`  Branch '${branch}' does not exist on remote yet`);
    const choice = yield* Prompt.select({
      message: `Would you like to create branch '${branch}' on the remote?`,
      options: Prompt.Questions.YNOpts,
    });
    if (choice !== "Yes") {
      return yield* new DeployAbortError({
        message: "Deployment requires the branch to exist. Aborting.",
      });
    }
    yield* Console.log(
      `  ✓ Branch '${branch}' will be created with the deployment`
    );
    return false;
  });

export const pushBranch = (pushUrl: string, branch: string) =>
  Effect.gen(function* () {
    const result = yield* git("push", pushUrl, `${branch}:${branch}`);
    if (result.code !== 0) {
      return yield* new DeployAbortError({
        message: `Failed to push to remote (exit ${result.code ?? "signal"})`,
      });
    }
    return undefined;
  });

export const checkForConflicts = (
  pushUrl: string,
  branch: string,
  remoteBranchExists: boolean
) =>
  Effect.gen(function* () {
    if (!remoteBranchExists) {
      return undefined;
    }
    yield* requireSuccess("fetch", "fetch", pushUrl, `refs/heads/${branch}`);
    yield* requireSuccess("merge-base", "merge-base", "HEAD", "FETCH_HEAD");
    const counts = aheadBehind.exec(
      yield* requireSuccess(
        "rev-list",
        "rev-list",
        "--left-right",
        "--count",
        "HEAD...FETCH_HEAD"
      )
    );
    if (counts === null) {
      return yield* new DeployAbortError({
        message: "Git rev-list returned invalid ahead/behind counts",
      });
    }
    const behind = Number(counts.groups?.behind);
    if (!Number.isSafeInteger(behind)) {
      return yield* new DeployAbortError({
        message: "Git rev-list returned invalid behind count",
      });
    }
    if (behind > 0) {
      yield* Console.log(
        `  ⚠ Your branch is ${behind} commit(s) behind the remote`
      );
      return yield* new DeployAbortError({
        message: "Please pull and resolve conflicts before deploying.",
      });
    }
    yield* Console.log(`  ✓ No conflicts with remote ${branch}`);
    return undefined;
  });
