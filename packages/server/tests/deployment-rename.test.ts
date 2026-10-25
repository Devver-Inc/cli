import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Schema } from "effect";

import { DisplayName } from "../src/api";
import { openDeploymentStore } from "../src/deployment-store";

const id = "11111111-1111-4111-8111-111111111111";

test("deployment names reject whitespace, controls and oversized input", () => {
  const decode = Schema.decodeUnknownSync(DisplayName);
  expect(decode("Homepage")).toBe("Homepage");
  for (const invalid of [
    "",
    "  ",
    " Padded ",
    "Escape\u001B[31m",
    "x".repeat(81),
  ]) {
    expect(() => decode(invalid)).toThrow();
  }
});

test("migrates existing deployment records and renames only the requested id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "devver-rename-"));
  const path = join(dir, "deployments.sqlite");
  try {
    const legacy = new Database(path, { create: true });
    legacy.run(`CREATE TABLE deployments (
      deploymentId TEXT PRIMARY KEY NOT NULL, repositoryId TEXT NOT NULL,
      commitSha TEXT NOT NULL, parentDeploymentId TEXT, worktree TEXT NOT NULL,
      status TEXT NOT NULL, stage TEXT, createdAt TEXT NOT NULL
    ) STRICT`);
    legacy.run(
      "INSERT INTO deployments VALUES (?, ?, ?, NULL, ?, 'ready', NULL, ?)",
      [
        id,
        "repository",
        "a".repeat(40),
        "/tmp/worktree",
        "2025-01-01T00:00:00Z",
      ]
    );
    legacy.close();
    chmodSync(path, 0o600);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* openDeploymentStore(path);
          expect((yield* store.read(id))?.displayName).toBe(null);
          expect(
            yield* store.rename(
              "22222222-2222-4222-8222-222222222222",
              "No row"
            )
          ).toBe(false);
          expect(yield* store.rename(id, "Homepage")).toBe(true);
          expect((yield* store.read(id))?.displayName).toBe("Homepage");
        })
      )
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* openDeploymentStore(path);
          expect((yield* store.list).deployments[0]?.displayName).toBe(
            "Homepage"
          );
        })
      )
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
