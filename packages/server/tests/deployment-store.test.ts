import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Exit } from "effect";

import { openDeploymentStore } from "../deployments";

test("legacy deployment tables migrate and never read as workflow-created", async () => {
  if (process.platform === "win32") {
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "devver-store-"));
  const path = join(root, "deployments.sqlite");
  try {
    const legacy = new Database(path);
    legacy.run(`CREATE TABLE deployments (
      deploymentId TEXT PRIMARY KEY NOT NULL,
      repositoryId TEXT NOT NULL,
      commitSha TEXT NOT NULL,
      parentDeploymentId TEXT REFERENCES deployments(deploymentId),
      worktree TEXT NOT NULL,
      status TEXT NOT NULL,
      stage TEXT,
      createdAt TEXT NOT NULL
    ) STRICT`);
    legacy
      .query(
        "INSERT INTO deployments (deploymentId, repositoryId, commitSha, parentDeploymentId, worktree, status, stage, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        "63227492-7164-489e-b8d2-1e5c342f4f38",
        "a".repeat(64),
        "1".repeat(40),
        null,
        join(root, "worktrees", "63227492-7164-489e-b8d2-1e5c342f4f38"),
        "preparing",
        null,
        new Date().toISOString()
      );
    legacy.close();
    chmodSync(path, 0o600);
    chmodSync(root, 0o700);

    const persisted = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* openDeploymentStore(path);
          const { deployments, unreadable } = yield* store.list;
          return { deployments, unreadable };
        })
      )
    );
    const { deployments, unreadable } = persisted;
    expect(unreadable).toBe(0);
    expect(deployments).toHaveLength(1);
    const [row] = deployments;
    expect(
      row?.status === "preparing" &&
        row.lifecycle === "inline" &&
        row.source === null &&
        row.displayName === null &&
        row.secondParentDeploymentId === null
    ).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("specifications survive reopen and conflicting writes cannot replace the first record", async () => {
  const root = mkdtempSync(join(tmpdir(), "devver-specification-"));
  const path = join(root, "deployments.sqlite");
  const deploymentId = "63227492-7164-489e-b8d2-1e5c342f4f38";
  const specification = {
    kind: "process",
    run: "node server.mjs",
  } as const;
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* openDeploymentStore(path);
          yield* store.record({
            deploymentId,
            repositoryId: "a".repeat(64),
            commit: "1".repeat(40),
            parentDeploymentId: null,
            secondParentDeploymentId: null,
            worktree: join(root, "worktrees", deploymentId),
            source: null,
            lifecycle: "workflow",
          });
          expect(yield* store.readSpecification(deploymentId)).toBeUndefined();
          expect(
            yield* store.recordSpecification(deploymentId, specification)
          ).toEqual(specification);
        })
      )
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* openDeploymentStore(path);
          expect(
            yield* store.recordSpecification(deploymentId, { kind: "static" })
          ).toEqual(specification);
          expect(yield* store.readSpecification(deploymentId)).toEqual(
            specification
          );
        })
      )
    );
    for (const [version, content] of [
      [2, JSON.stringify(specification)],
      [1, "not JSON"],
      [1, JSON.stringify({ kind: "unknown" })],
    ] as const) {
      const db = new Database(path);
      db.query(
        "UPDATE deployment_specifications SET version = ?, specification = ? WHERE deploymentId = ?"
      ).run(version, content, deploymentId);
      db.close();
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const store = yield* openDeploymentStore(path);
            expect(
              Exit.isFailure(
                yield* Effect.exit(store.readSpecification(deploymentId))
              )
            ).toBe(true);
            expect(
              Exit.isFailure(
                yield* Effect.exit(
                  store.recordSpecification(deploymentId, { kind: "static" })
                )
              )
            ).toBe(true);
          })
        )
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
