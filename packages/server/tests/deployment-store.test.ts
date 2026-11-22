import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

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
