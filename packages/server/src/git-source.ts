import { createHash } from "node:crypto";
import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { execute } from "./exec";
import { isAlreadyExists } from "./fs-errors";
import { verifyWindowsPrivate } from "./windows-acl";

const COMMIT = /^[0-9a-f]{40}$/u;
const PRIVATE_DIRECTORY = 0o700;

async function git(cwd: string, operation: string, args: string[]) {
  try {
    const { stdout } = await execute("git", args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      timeout: 60_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim();
  } catch {
    throw new Error(`Git ${operation} failed`);
  }
}

async function privateDirectory(path: string) {
  try {
    await mkdir(path, { mode: PRIVATE_DIRECTORY, recursive: false });
  } catch (error) {
    if (!isAlreadyExists(error)) {
      throw error;
    }
  }
  if (process.platform === "win32") {
    await verifyWindowsPrivate({ path, kind: "directory" });
    return;
  }
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    stat.mode % 0o1000 !== PRIVATE_DIRECTORY
  ) {
    throw new Error("Server deployment state must be owner-only");
  }
}

async function contains(repository: string, commit: string) {
  try {
    await git(repository, "cat-file", ["cat-file", "-e", `${commit}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

export async function verifiedSource(source: string, commit: string) {
  if (!(isAbsolute(source) && COMMIT.test(commit))) {
    throw new Error(
      "A deployment needs an absolute checkout path and a full commit object name"
    );
  }
  const path = await realpath(source);
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    (process.platform !== "win32" && stat.uid !== process.getuid?.())
  ) {
    throw new Error("The deployment source must be a directory you own");
  }
  const top = await git(path, "rev-parse", ["rev-parse", "--show-toplevel"]);
  if (top === "" || (await realpath(top)) !== path) {
    throw new Error("The deployment source must be a Git work tree root");
  }
  if (!(await contains(path, commit))) {
    throw new Error("The checkout does not contain the selected commit");
  }
  return {
    path,
    repositoryId: createHash("sha256").update(path).digest("hex"),
  };
}

export async function pinCommit(
  bare: string,
  deploymentId: string,
  commit: string
) {
  await git(bare, "update-ref", [
    "update-ref",
    `refs/devver/deployments/${deploymentId}`,
    commit,
  ]);
}

export async function syncCommit(options: {
  readonly repositories: string;
  readonly repositoryId: string;
  readonly source: string;
  readonly commit: string;
  readonly deploymentId: string;
}) {
  await privateDirectory(options.repositories);
  const bare = join(options.repositories, `${options.repositoryId}.git`);
  await privateDirectory(bare);
  await git(bare, "init", ["init", "--bare", "--quiet"]);
  if (!(await contains(bare, options.commit))) {
    await git(bare, "fetch", [
      "fetch",
      "--no-tags",
      "--quiet",
      options.source,
      options.commit,
    ]);
    if (!(await contains(bare, options.commit))) {
      throw new Error(
        "The requested commit is not available in this repository"
      );
    }
  }
  await pinCommit(bare, options.deploymentId, options.commit);
  return bare;
}

export async function mergeCommits(
  bare: string,
  first: string,
  second: string
) {
  const base = await git(bare, "merge-base", [
    "merge-base",
    first,
    second,
  ]).catch(() => {
    throw new Error("Git histories are unrelated or unavailable");
  });
  if (!COMMIT.test(base)) {
    throw new Error("Git histories are unrelated");
  }
  let tree: string;
  try {
    tree = await git(bare, "merge-tree", [
      "merge-tree",
      "--write-tree",
      first,
      second,
    ]);
  } catch {
    throw new Error("Merge conflicts prevent combining these revisions");
  }
  if (!COMMIT.test(tree)) {
    throw new Error("Git merge did not produce a tree");
  }
  const commit = await git(bare, "commit-tree", [
    "-c",
    "user.name=Devver",
    "-c",
    "user.email=devver@localhost",
    "commit-tree",
    tree,
    "-p",
    first,
    "-p",
    second,
    "-m",
    "Merge Devver deployments",
  ]);
  if (!COMMIT.test(commit)) {
    throw new Error("Git merge did not produce a commit");
  }
  return commit;
}

export async function addWorktree(options: {
  readonly bare: string;
  readonly worktrees: string;
  readonly deploymentId: string;
  readonly commit: string;
}) {
  await privateDirectory(options.worktrees);
  const worktree = join(options.worktrees, options.deploymentId);
  await git(options.bare, "worktree add", [
    "worktree",
    "add",
    "--detach",
    "--quiet",
    worktree,
    options.commit,
  ]);
  return worktree;
}

export async function removeDeploymentRef(bare: string, deploymentId: string) {
  await git(bare, "update-ref", [
    "update-ref",
    "-d",
    `refs/devver/deployments/${deploymentId}`,
  ]).catch(() => undefined);
}

export async function removeWorktree(bare: string, worktree: string) {
  await git(bare, "worktree remove", [
    "worktree",
    "remove",
    "--force",
    worktree,
  ]).catch(async () => {
    await rm(worktree, { recursive: true, force: true });
  });
}
