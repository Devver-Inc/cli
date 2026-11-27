import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  NodeChildProcessSpawner,
  NodeFileSystem,
  NodePath,
} from "@effect/platform-node";
import { Effect, Layer } from "effect";
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";

import { openGit } from "./git-source";
import type { GitFailure } from "./git-source";

const childProcesses = NodeChildProcessSpawner.layer.pipe(
  Layer.provide(NodeFileSystem.layer),
  Layer.provide(NodePath.layer)
);

const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();

const configure = (root: string) => {
  run(root, "init", "--quiet");
  run(root, "config", "user.name", "Devver");
  run(root, "config", "user.email", "devver@localhost");
};

// Prepares one deployment through the production git path and reads the
// committed configuration back from the server's own bare repository.
// Returns the configuration the production paths read back, or the failure
// the trust boundary raised for it.
const committedConfig = async (
  setup: (root: string) => void
): Promise<string | null> => {
  const instance = mkdtempSync(join(tmpdir(), "devver-gitkit-"));
  const checkout = mkdtempSync(join(tmpdir(), "devver-gitkit-source-"));
  const repositoryId = "1".repeat(64);
  configure(checkout);
  setup(checkout);
  run(checkout, "add", ".");
  run(checkout, "commit", "--quiet", "-m", "config");
  const commit = run(checkout, "rev-parse", "HEAD");
  const cleanup = () => {
    rmSync(checkout, { recursive: true, force: true });
    rmSync(instance, { recursive: true, force: true });
  };
  const program = Effect.gen(function* () {
    const git = yield* openGit({
      repositories: instance,
      worktrees: join(instance, "worktrees"),
    });
    yield* git.prepareWorktree({
      repositoryId,
      deploymentId: randomUUID(),
      commit,
      source: checkout,
    });
    return yield* git.committedFile(repositoryId, commit, ".devver.yaml");
  });
  return await Effect.runPromise(
    Effect.scoped(program).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off
      Effect.provide(childProcesses)
    )
  ).finally(cleanup);
};

const failureOf = async (
  attempt: () => Promise<string | null>
): Promise<Error | undefined> => {
  try {
    await attempt();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : undefined;
  }
};

test("a committed regular configuration blob is returned", async () => {
  expect(
    await committedConfig((root) => {
      writeFileSync(join(root, ".devver.yaml"), "static: {}\n");
    })
  ).toBe("static: {}");
});

test("a committed executable configuration blob is returned", async () => {
  expect(
    await committedConfig((root) => {
      writeFileSync(join(root, ".devver.yaml"), "static: {}\n");
      run(root, "add", ".");
      run(root, "update-index", "--chmod=+x", ".devver.yaml");
    })
  ).toBe("static: {}");
});

test("a committed configuration symlink is rejected as not a regular file", async () => {
  const failure = await failureOf(async () =>
    committedConfig((root) => {
      writeFileSync(join(root, "actual.yaml"), "static: {}\n");
      symlinkSync("actual.yaml", join(root, ".devver.yaml"));
    })
  );
  expect(failure?.message).toContain(
    "The deployment configuration is not a regular file"
  );
});

test("a committed configuration directory is rejected as not a regular file", async () => {
  const failure = await failureOf(async () =>
    committedConfig((root) => {
      mkdirSync(join(root, ".devver.yaml"));
      writeFileSync(join(root, ".devver.yaml", "nested"), "static: {}\n");
    })
  );
  expect(failure?.message).toContain(
    "The deployment configuration is not a regular file"
  );
});

test("an oversized committed configuration is rejected before reading", async () => {
  const failure = await failureOf(async () =>
    committedConfig((root) => {
      writeFileSync(
        join(root, ".devver.yaml"),
        `static: { padding: "${"x".repeat(70_000)}" }\n`
      );
    })
  );
  expect(failure?.message).toContain(
    "The deployment configuration is too large"
  );
});

const instanceKit = async () => {
  const instance = mkdtempSync(join(tmpdir(), "devver-gitkit-"));
  const checkout = mkdtempSync(join(tmpdir(), "devver-gitkit-source-"));
  const repositoryId = "1".repeat(64);
  configure(checkout);
  run(checkout, "commit", "--quiet", "--allow-empty", "-m", "one");
  const commit = run(checkout, "rev-parse", "HEAD");
  const cleanup = () => {
    rmSync(checkout, { recursive: true, force: true });
    rmSync(instance, { recursive: true, force: true });
  };
  return { instance, checkout, repositoryId, commit, cleanup };
};

const withKit = async <A>(
  kit: Awaited<ReturnType<typeof instanceKit>>,
  exercise: (
    git: Awaited<Effect.Success<ReturnType<typeof openGit>>>
  ) => Effect.Effect<A, GitFailure, ChildProcessSpawner>
) => {
  const program = Effect.scoped(
    Effect.flatMap(
      openGit({
        repositories: kit.instance,
        worktrees: join(kit.instance, "worktrees"),
      }),
      exercise
    )
  ).pipe(
    // @effect-diagnostics-next-line strictEffectProvide:off
    Effect.provide(childProcesses)
  );
  return await Effect.runPromise(program).finally(kit.cleanup);
};

test("a matching worktree with untracked build output stays reusable", async () => {
  const kit = await instanceKit();
  const status = await withKit(kit, (git) =>
    Effect.gen(function* () {
      const worktree = yield* git.prepareWorktree({
        repositoryId: kit.repositoryId,
        deploymentId: randomUUID(),
        commit: kit.commit,
        source: kit.checkout,
      });
      mkdirSync(join(worktree, "node_modules", "vite"), { recursive: true });
      return yield* git.inspectWorktree({
        repositoryId: kit.repositoryId,
        worktree,
        commit: kit.commit,
      });
    })
  );
  expect(status).toEqual({
    present: true,
    registered: true,
    checkedOutAtCommit: true,
    trackedClean: true,
  });
});

test("a diverged worktree is reported as not the pinned checkout", async () => {
  const kit = await instanceKit();
  const secondCommit = (() => {
    run(kit.checkout, "commit", "--quiet", "--allow-empty", "-m", "two");
    return run(kit.checkout, "rev-parse", "HEAD");
  })();
  const status = await withKit(kit, (git) =>
    Effect.gen(function* () {
      const worktree = yield* git.prepareWorktree({
        repositoryId: kit.repositoryId,
        deploymentId: randomUUID(),
        commit: kit.commit,
        source: kit.checkout,
      });
      return yield* git.inspectWorktree({
        repositoryId: kit.repositoryId,
        worktree,
        commit: secondCommit,
      });
    })
  );
  expect(status).toEqual({
    present: true,
    registered: true,
    checkedOutAtCommit: false,
    trackedClean: false,
  });
});

test("an absent worktree is reported as not present", async () => {
  const kit = await instanceKit();
  const status = await withKit(kit, (git) =>
    git.inspectWorktree({
      repositoryId: kit.repositoryId,
      worktree: join(kit.instance, "worktrees", randomUUID()),
      commit: kit.commit,
    })
  );
  expect(status).toEqual({ present: false });
});
