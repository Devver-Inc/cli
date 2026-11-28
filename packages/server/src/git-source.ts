import { createHash } from "node:crypto";
import { lstat, realpath, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { Context, Data, Effect, RcMap, Semaphore } from "effect";
import type { Scope } from "effect";
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";

import { DeployFailure } from "./api";
import type { DeployStage } from "./deployment/record";
import { runProcess } from "./exec";
import { requirePrivateDirectory } from "./private-state";

const COMMIT = /^[0-9a-f]{40}$/u;
// Mirrors the decode cap in workloads/config.ts, in bytes rather than
// characters, so the trust boundary rejects before reading oversized blobs.
const MAX_CONFIG_BYTES = 65_536;
const GIT_TIMEOUT_MS = 60_000;
const GIT_MAX_BUFFER = 1024 * 1024;

export class GitFailure extends Data.TaggedError("GitFailure")<{
  readonly message: string;
}> {}

const failed = (operation: string) =>
  new GitFailure({ message: `Git ${operation} failed` });

const generic = () =>
  new GitFailure({ message: "Git could not prepare the deployment" });

// One git subprocess over the platform child process service. Any failure is
// the sanitized operation failure; subprocess stderr never reaches it.
const git = (cwd: string, operation: string, args: readonly string[]) =>
  runProcess("git", args, {
    cwd,
    env: { GIT_TERMINAL_PROMPT: "0" },
    extendEnv: true,
    timeoutMs: GIT_TIMEOUT_MS,
    maxBufferBytes: GIT_MAX_BUFFER,
  }).pipe(
    Effect.map((finished) => finished.stdout.trim()),
    Effect.mapError(() => failed(operation))
  );

const recover = <A>(
  step: Effect.Effect<A, GitFailure, ChildProcessSpawner>
): Effect.Effect<A, GitFailure, ChildProcessSpawner> =>
  step.pipe(Effect.catchDefect(() => generic()));

const fsStep = <A>(operation: () => Promise<A>): Effect.Effect<A, GitFailure> =>
  Effect.tryPromise({ try: operation, catch: () => generic() });

const contains = (repository: string, commit: string) =>
  git(repository, "cat-file", ["cat-file", "-e", `${commit}^{commit}`]).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false)
  );

const verifiedSource = (source: string, commit: string) =>
  Effect.gen(function* () {
    if (!(isAbsolute(source) && COMMIT.test(commit))) {
      return yield* new GitFailure({
        message:
          "A deployment needs an absolute checkout path and a full commit object name",
      });
    }
    const path = yield* fsStep(async () => await realpath(source));
    const stat = yield* fsStep(async () => await lstat(path));
    if (
      !stat.isDirectory() ||
      (process.platform !== "win32" && stat.uid !== process.getuid?.())
    ) {
      return yield* new GitFailure({
        message: "The deployment source must be a directory you own",
      });
    }
    const top = yield* git(path, "rev-parse", ["rev-parse", "--show-toplevel"]);
    const realTop =
      top === "" ? "" : yield* fsStep(async () => await realpath(top));
    if (realTop !== path) {
      return yield* new GitFailure({
        message: "The deployment source must be a Git work tree root",
      });
    }
    if (!(yield* contains(path, commit))) {
      return yield* new GitFailure({
        message: "The checkout does not contain the selected commit",
      });
    }
    return {
      path,
      repositoryId: createHash("sha256").update(path).digest("hex"),
    };
  });

const pinCommit = (bare: string, deploymentId: string, commit: string) =>
  git(bare, "update-ref", [
    "update-ref",
    `refs/devver/deployments/${deploymentId}`,
    commit,
  ]);

const firstParentDeployment = (
  source: string,
  commit: string,
  candidates: readonly {
    readonly commit: string;
    readonly deploymentId: string;
  }[]
) =>
  Effect.gen(function* () {
    if (candidates.length === 0) {
      return null;
    }
    const byCommit = new Map(
      candidates.map((entry) => [entry.commit, entry.deploymentId])
    );
    const history = yield* git(source, "rev-list", [
      "rev-list",
      "--first-parent",
      commit,
    ]);
    const [head, ...ancestors] = history.split("\n");
    if (head !== commit) {
      return yield* new GitFailure({
        message: "Git could not inspect the commit ancestry",
      });
    }
    for (const ancestor of ancestors) {
      const deploymentId = byCommit.get(ancestor);
      if (deploymentId !== undefined) {
        return deploymentId;
      }
    }
    return null;
  });

const mergeCommits = (bare: string, first: string, second: string) =>
  Effect.gen(function* () {
    const version = /^git version (?<major>\d+)\.(?<minor>\d+)/u.exec(
      yield* git(bare, "version", ["--version"])
    )?.groups;
    if (
      version === undefined ||
      Number(version.major) < 2 ||
      (Number(version.major) === 2 && Number(version.minor) < 38)
    ) {
      return yield* new GitFailure({
        message: "Merging deployments requires Git 2.38 or newer",
      });
    }
    const base = yield* git(bare, "merge-base", [
      "merge-base",
      first,
      second,
    ]).pipe(
      Effect.mapError(
        () =>
          new GitFailure({
            message: "Git histories are unrelated or unavailable",
          })
      )
    );
    if (!COMMIT.test(base)) {
      return yield* new GitFailure({
        message: "Git histories are unrelated",
      });
    }
    const tree = yield* git(bare, "merge-tree", [
      "merge-tree",
      "--write-tree",
      first,
      second,
    ]).pipe(
      Effect.mapError(
        () =>
          new GitFailure({
            message: "Merge conflicts prevent combining these revisions",
          })
      )
    );
    if (!COMMIT.test(tree)) {
      return yield* new GitFailure({
        message: "Git merge did not produce a tree",
      });
    }
    const commit = yield* git(bare, "commit-tree", [
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
      return yield* new GitFailure({
        message: "Git merge did not produce a commit",
      });
    }
    return commit;
  });

const commitSubjects = (bare: string, commits: readonly string[]) =>
  Effect.gen(function* () {
    const subjects = new Map<string, string>();
    const revisions = [...new Set(commits)].filter((commit) =>
      COMMIT.test(commit)
    );
    if (revisions.length === 0) {
      return subjects;
    }
    const output = yield* git(bare, "log", [
      "log",
      "--no-walk",
      "--ignore-missing",
      "--format=%H %s",
      ...revisions,
      "--",
    ]).pipe(Effect.orElseSucceed(() => ""));
    for (const line of output.split("\n")) {
      const subject = line.slice(41).trim();
      if (line[40] === " " && subject !== "") {
        subjects.set(line.slice(0, 40), subject);
      }
    }
    return subjects;
  });

const removeWorktree = (bare: string, worktree: string) =>
  git(bare, "worktree remove", [
    "worktree",
    "remove",
    "--force",
    worktree,
  ]).pipe(
    // Git refuses half-registered leftovers; the recursive remove below is
    // both its fallback and a no-op after a successful removal.
    Effect.ignore,
    Effect.andThen(
      Effect.tryPromise({
        try: async () => {
          await rm(worktree, { recursive: true, force: true });
        },
        catch: () => failed("worktree remove"),
      })
    )
  );

const addWorktree = (options: {
  readonly bare: string;
  readonly worktrees: string;
  readonly deploymentId: string;
  readonly commit: string;
}) =>
  Effect.gen(function* () {
    yield* fsStep(async () => {
      await requirePrivateDirectory(options.worktrees);
    });
    const worktree = join(options.worktrees, options.deploymentId);
    // A killed create can leave a half-registered worktree behind; the exact
    // path is unique to this deployment, so remove any leftover and re-add.
    const present = yield* fsStep(
      async () =>
        await lstat(worktree).then(
          () => true,
          () => false
        )
    );
    if (present) {
      yield* removeWorktree(options.bare, worktree);
    }
    yield* git(options.bare, "worktree add", [
      "worktree",
      "add",
      "--detach",
      "--quiet",
      worktree,
      options.commit,
    ]);
    return worktree;
  });

export interface RepositorySource {
  readonly path: string;
  readonly repositoryId: string;
}

export interface CommittedSubjects {
  readonly repositoryId: string;
  readonly commit: string;
}

// What the server can observe about one deployment's worktree on disk. The
// provider layer owns the repair decision: git only reports the facts.
//   - absent: the deployment-unique path does not exist yet
//   - registered + checkedOutAtCommit + trackedClean: a complete checkout
//     of exactly the pinned revision, safe to reuse with untracked build
//     output intact
export type WorktreeStatus =
  | { readonly present: false }
  | {
      readonly present: true;
      readonly registered: boolean;
      readonly checkedOutAtCommit: boolean;
      readonly trackedClean: boolean;
    };

// The child process service stays part of this capability's public surface:
// callers compose Git over their own process spawner, one provision at the
// server edge.
export interface GitService {
  readonly verifiedSource: (
    source: string,
    commit: string
  ) => Effect.Effect<RepositorySource, GitFailure, ChildProcessSpawner>;
  readonly firstParentDeployment: (
    source: string,
    commit: string,
    candidates: readonly {
      readonly commit: string;
      readonly deploymentId: string;
    }[]
  ) => Effect.Effect<string | null, GitFailure, ChildProcessSpawner>;
  readonly mergeCommits: (input: {
    readonly repositoryId: string;
    readonly first: string;
    readonly second: string;
  }) => Effect.Effect<string, GitFailure, ChildProcessSpawner>;
  readonly prepareWorktree: (input: {
    readonly repositoryId: string;
    readonly deploymentId: string;
    readonly commit: string;
    readonly source: string | null;
  }) => Effect.Effect<string, GitFailure, ChildProcessSpawner>;
  readonly inspectWorktree: (input: {
    readonly repositoryId: string;
    readonly worktree: string;
    readonly commit: string;
  }) => Effect.Effect<WorktreeStatus, GitFailure, ChildProcessSpawner>;
  readonly subjectsOf: (
    entries: readonly CommittedSubjects[]
  ) => Effect.Effect<ReadonlyMap<string, string>, never, ChildProcessSpawner>;
  readonly committedFile: (
    repositoryId: string,
    commit: string,
    path: string
  ) => Effect.Effect<string | null, GitFailure, ChildProcessSpawner>;
  readonly removeWorktree: (
    repositoryId: string,
    worktree: string
  ) => Effect.Effect<void, GitFailure, ChildProcessSpawner>;
  readonly removeDeploymentRef: (
    repositoryId: string,
    deploymentId: string
  ) => Effect.Effect<void, GitFailure, ChildProcessSpawner>;
}

/**
 * @effect-expect-leaking ChildProcessSpawner
 */
export const Git = Context.Service<GitService>("devver/server/Git");

export const gitFailureFor =
  (stage: DeployStage) =>
  (error: GitFailure): DeployFailure =>
    new DeployFailure({ stage, message: `${stage}: ${error.message}` });

const bareRepository = (repositories: string, repositoryId: string) =>
  join(repositories, `${repositoryId}.git`);

const removeDeploymentRefOf = (bare: string, deploymentId: string) => {
  const ref = `refs/devver/deployments/${deploymentId}`;
  return Effect.gen(function* () {
    const outcome = yield* git(bare, "update-ref", [
      "update-ref",
      "-d",
      ref,
    ]).pipe(
      Effect.as("deleted" as const),
      Effect.catch(() =>
        git(bare, "rev-parse", ["rev-parse", "--verify", "--quiet", ref]).pipe(
          Effect.map(() => "present" as const),
          // A ref that never existed is already the desired teardown state.
          Effect.orElseSucceed(() => "absent" as const)
        )
      )
    );
    if (outcome === "present") {
      return yield* failed("update-ref");
    }
    return undefined;
  });
};

const sizeOf = (bare: string, object: string) =>
  git(bare, "cat-file -s", ["cat-file", "-s", object]).pipe(
    Effect.map((size) => {
      const parsed = Number(size);
      return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
    }),
    Effect.orElseSucceed(() => undefined)
  );

// Reads one committed file, decoded at this trust boundary: only a regular
// blob from the pinned revision is a usable configuration, and the size
// stays bounded before any content is read.
const committedFileOf = (
  repositories: string,
  repositoryId: string,
  commit: string,
  path: string
) =>
  Effect.gen(function* () {
    const bare = bareRepository(repositories, repositoryId);
    const entry = yield* git(bare, "ls-tree", ["ls-tree", commit, "--", path]);
    if (entry === "") {
      return null;
    }
    const [mode, kind, object] = entry.split(/[\t ]/u);
    if (
      (mode !== "100644" && mode !== "100755") ||
      kind !== "blob" ||
      object === undefined ||
      !COMMIT.test(object)
    ) {
      return yield* new GitFailure({
        message: "The deployment configuration is not a regular file",
      });
    }
    const size = yield* sizeOf(bare, object);
    if (size === undefined || size > MAX_CONFIG_BYTES) {
      return yield* new GitFailure({
        message: "The deployment configuration is too large",
      });
    }
    return yield* git(bare, "cat-file", ["cat-file", "-p", object]);
  });

export const openGit = (options: {
  readonly repositories: string;
  readonly worktrees: string;
}): Effect.Effect<GitService, never, Scope.Scope> =>
  Effect.gen(function* () {
    // One lease per repository: concurrent operations on the same bare
    // repository share the live handle and serialize mutations through its
    // permit. Releasing a lease never deletes the repository or worktrees;
    // those are durable instance state.
    const leases = yield* RcMap.make<string, Semaphore.Semaphore, never, never>(
      {
        lookup: () => Semaphore.make(1),
      }
    );
    const withinRepository = <E, A, R>(
      repositoryId: string,
      step: Effect.Effect<A, E, R>
    ) =>
      Effect.scoped(
        Effect.flatMap(RcMap.get(leases, repositoryId), (gate) =>
          gate.withPermits(1)(step)
        )
      );

    return {
      verifiedSource: (source, commit) =>
        recover(verifiedSource(source, commit)),
      firstParentDeployment: (source, commit, candidates) =>
        recover(firstParentDeployment(source, commit, candidates)),
      mergeCommits: ({ repositoryId, first, second }) =>
        withinRepository(
          repositoryId,
          recover(
            mergeCommits(
              bareRepository(options.repositories, repositoryId),
              first,
              second
            )
          )
        ),
      prepareWorktree: ({ repositoryId, deploymentId, commit, source }) =>
        withinRepository(
          repositoryId,
          recover(
            Effect.gen(function* () {
              const bare = bareRepository(options.repositories, repositoryId);
              if (source !== null) {
                yield* fsStep(async () => {
                  await requirePrivateDirectory(options.repositories);
                });
                yield* fsStep(async () => {
                  await requirePrivateDirectory(bare);
                });
                yield* git(bare, "init", ["init", "--bare", "--quiet"]);
                if (!(yield* contains(bare, commit))) {
                  yield* git(bare, "fetch", [
                    "fetch",
                    "--no-tags",
                    "--quiet",
                    source,
                    commit,
                  ]);
                  if (!(yield* contains(bare, commit))) {
                    return yield* new GitFailure({
                      message:
                        "The requested commit is not available in this repository",
                    });
                  }
                }
              }
              yield* pinCommit(bare, deploymentId, commit);
              return yield* addWorktree({
                bare,
                worktrees: options.worktrees,
                deploymentId,
                commit,
              });
            })
          )
        ),
      inspectWorktree: ({ repositoryId, worktree, commit }) =>
        withinRepository(
          repositoryId,
          recover(
            Effect.gen(function* () {
              const bare = bareRepository(options.repositories, repositoryId);
              const present = yield* fsStep(
                async () =>
                  await lstat(worktree).then(
                    () => true,
                    () => false
                  )
              );
              if (!present) {
                return { present: false } as const;
              }
              // Git reports canonically resolved paths, while the instance
              // directory itself may live behind a symlinked tmp root.
              const absolute = yield* fsStep(
                async () =>
                  await realpath(worktree).then(
                    (real) => real,
                    () => worktree
                  )
              );
              const registered = yield* git(bare, "worktree list", [
                "worktree",
                "list",
                "--porcelain",
              ]).pipe(
                Effect.orElseSucceed(() => ""),
                Effect.map((listing) =>
                  listing
                    .split("\n")
                    .some((line) => line === `worktree ${absolute}`)
                )
              );
              if (!registered) {
                return {
                  present: true,
                  registered: false,
                  checkedOutAtCommit: false,
                  trackedClean: false,
                } as const;
              }
              const head = yield* git(worktree, "rev-parse", [
                "rev-parse",
                "HEAD",
              ]).pipe(Effect.orElseSucceed(() => ""));
              if (head !== commit) {
                return {
                  present: true,
                  registered: true,
                  checkedOutAtCommit: false,
                  trackedClean: false,
                } as const;
              }
              // Untracked build output such as node_modules stays invisible:
              // only divergence among tracked files marks the checkout as
              // not a complete acquisition of this revision.
              const changes = yield* git(worktree, "status", [
                "status",
                "--porcelain",
                "--untracked-files=no",
              ]).pipe(Effect.orElseSucceed(() => "unusable"));
              return {
                present: true,
                registered: true,
                checkedOutAtCommit: true,
                trackedClean: changes === "",
              } as const;
            })
          )
        ),
      subjectsOf: (entries) =>
        Effect.gen(function* () {
          const subjects = new Map<string, string>();
          const byRepository = new Map<string, string[]>();
          for (const { repositoryId, commit } of entries) {
            byRepository.set(repositoryId, [
              ...(byRepository.get(repositoryId) ?? []),
              commit,
            ]);
          }
          for (const [repositoryId, commits] of byRepository) {
            const resolved = yield* commitSubjects(
              bareRepository(options.repositories, repositoryId),
              commits
            );
            for (const [commit, subject] of resolved) {
              subjects.set(commit, subject);
            }
          }
          return subjects;
        }).pipe(Effect.orDie),
      committedFile: (repositoryId, commit, path) =>
        withinRepository(
          repositoryId,
          recover(
            committedFileOf(options.repositories, repositoryId, commit, path)
          )
        ),
      removeWorktree: (repositoryId, worktree) =>
        withinRepository(
          repositoryId,
          recover(
            removeWorktree(
              bareRepository(options.repositories, repositoryId),
              worktree
            )
          )
        ),
      removeDeploymentRef: (repositoryId, deploymentId) =>
        withinRepository(
          repositoryId,
          recover(
            removeDeploymentRefOf(
              bareRepository(options.repositories, repositoryId),
              deploymentId
            )
          )
        ),
    } satisfies GitService;
  });
