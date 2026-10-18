import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Schema } from "effect";

import { openDeploymentStore } from "../deployments";

const probe = join(import.meta.dir, "deployment-store-probe.ts");
const NO_RUNTIME_PATH =
  process.platform === "win32"
    ? "C:\\Windows\\System32;C:\\Windows\\System32\\WindowsPowerShell\\v1.0"
    : "/usr/bin:/bin";

const decodeProbe = Schema.decodeUnknownSync(
  Schema.Struct({
    runtime: Schema.Literals(["node", "bun"]),
    deploymentId: Schema.String,
    repositoryId: Schema.String,
    commit: Schema.String,
    parentDeploymentId: Schema.NullOr(Schema.String),
    worktree: Schema.String,
    status: Schema.String,
    stage: Schema.NullOr(Schema.String),
    appPort: Schema.Finite,
    createdAt: Schema.String,
  })
);

async function probeCommand(distribution: "npm" | "standalone", temp: string) {
  const outfile = join(
    temp,
    distribution === "npm"
      ? "probe.mjs"
      : `probe${process.platform === "win32" ? ".exe" : ""}`
  );
  const result = await Bun.build({
    entrypoints: [probe],
    ...(distribution === "npm"
      ? {
          target: "node",
          packages: "bundle",
          outdir: temp,
          naming: { entry: "probe.mjs" },
        }
      : { compile: { outfile } }),
  });
  expect(result.success, result.logs.map((log) => log.message).join("\n")).toBe(
    true
  );
  if (distribution === "npm") {
    const node = Bun.which("node");
    if (node === null) {
      throw new Error("Node is required for the npm artifact check");
    }
    return [node, outfile];
  }
  return [outfile];
}

test("the durable deployment record is readable by both distributions", async () => {
  const temp = await mkdtemp(join(tmpdir(), "devver-store-"));
  try {
    const npm = await probeCommand("npm", temp);
    const standalone = await probeCommand("standalone", temp);
    const run = (command: string[], mode: string, file: string) => {
      const child = Bun.spawnSync([...command, mode, file], {
        cwd: temp,
        // Neither artifact may depend on the other runtime being installed.
        env: { ...process.env, PATH: NO_RUNTIME_PATH },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(child.exitCode, child.stderr.toString()).toBe(0);
      return decodeProbe(JSON.parse(child.stdout.toString().trim()));
    };
    const written = run(npm, "write", join(temp, "npm.sqlite"));
    expect(written.runtime).toBe("node");
    expect(written.status).toBe("ready");
    expect(written.parentDeploymentId).toBeNull();
    expect(written.appPort).toBe(47_320);
    // The same file reopened by the other runtime yields the same record.
    const read = run(standalone, "read", join(temp, "npm.sqlite"));
    expect(read.runtime).toBe("bun");
    expect({ ...read, runtime: "node" }).toEqual(written);
    const reverse = run(standalone, "write", join(temp, "standalone.sqlite"));
    expect(run(npm, "read", join(temp, "standalone.sqlite"))).toEqual({
      ...reverse,
      runtime: "node",
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}, 120_000);

test("a deployment store is owner-only and rejects records it cannot validate", async () => {
  const temp = await mkdtemp(join(tmpdir(), "devver-store-"));
  const file = join(temp, "deployments.sqlite");
  const store = await openDeploymentStore(file);
  try {
    if (process.platform !== "win32") {
      expect((await stat(file)).mode % 0o1000).toBe(0o600);
    }
    const id = "031fdbdf-3c42-4d19-8909-9a2cf4690cb0";
    expect(store.read(id)).toBeUndefined();
    expect(() => {
      store.record({
        deploymentId: "not-a-uuid",
        repositoryId: "repo-1",
        commit: "7034b34db3efb2e159289794b817da197f84c66e",
        parentDeploymentId: null,
        worktree: join(temp, "worktree"),
      });
    }).toThrow();
    expect(() => {
      store.record({
        deploymentId: id,
        repositoryId: "repo-1",
        commit: "main",
        parentDeploymentId: null,
        worktree: join(temp, "worktree"),
      });
    }).toThrow();
    store.record({
      deploymentId: id,
      repositoryId: "repo-1",
      commit: "7034b34db3efb2e159289794b817da197f84c66e",
      parentDeploymentId: null,
      worktree: join(temp, "worktree"),
    });
    expect(store.read(id)?.status).toBe("preparing");
    store.markFailed(id, "readiness");
    expect(store.read(id)).toMatchObject({
      status: "failed",
      stage: "readiness",
    });
  } finally {
    store.close();
    await rm(temp, { recursive: true, force: true });
  }
});

const APP_PORT = 46_123;

const recorded = (deploymentId: string, commit: string) => ({
  deploymentId,
  repositoryId: "a".repeat(64),
  commit,
  parentDeploymentId: null,
  worktree: join(tmpdir(), "devver-worktrees", deploymentId),
});

const first = recorded("11111111-1111-4111-8111-111111111111", "1".repeat(40));
const second = recorded("22222222-2222-4222-8222-222222222222", "2".repeat(40));

test("ready deployments and the published app port survive reopening the records", async () => {
  const temp = await mkdtemp(join(tmpdir(), "devver-store-"));
  const file = join(temp, "deployments.sqlite");
  try {
    const store = await openDeploymentStore(file);
    expect(store.appPort()).toBeUndefined();
    store.setAppPort(APP_PORT);
    store.record(first);
    store.markReady(first.deploymentId);
    store.record(second);
    store.markFailed(second.deploymentId, "readiness");
    store.close();

    const reopened = await openDeploymentStore(file);
    try {
      expect(reopened.appPort()).toBe(APP_PORT);
      const { deployments, unreadable } = reopened.list();
      expect(unreadable).toBe(0);
      expect(deployments).toHaveLength(2);
      const listed = (deploymentId: string) =>
        deployments.find((entry) => entry.deploymentId === deploymentId);
      expect(listed(first.deploymentId)).toMatchObject({
        commit: first.commit,
        worktree: first.worktree,
        status: "ready",
        stage: null,
      });
      expect(listed(second.deploymentId)).toMatchObject({
        status: "failed",
        stage: "readiness",
      });

      reopened.markDegraded(first.deploymentId, "process");
      expect(reopened.read(first.deploymentId)).toMatchObject({
        status: "degraded",
        stage: "process",
      });
    } finally {
      reopened.close();
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("a preparing record stays readable while the deployment runs", async () => {
  const temp = await mkdtemp(join(tmpdir(), "devver-store-"));
  const store = await openDeploymentStore(join(temp, "deployments.sqlite"));
  try {
    store.record(first);
    expect(store.read(first.deploymentId)).toMatchObject({
      status: "preparing",
      stage: null,
    });
    store.markDegraded(first.deploymentId, "server");
    expect(store.read(first.deploymentId)).toMatchObject({
      status: "degraded",
    });
  } finally {
    store.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("records written before teardown was name-addressed stay readable", async () => {
  const temp = await mkdtemp(join(tmpdir(), "devver-store-"));
  const file = join(temp, "deployments.sqlite");
  try {
    // State written when records carried a per-deployment site port.
    const legacy = new Database(file);
    legacy.run(`CREATE TABLE deployments (
      deploymentId TEXT PRIMARY KEY NOT NULL,
      repositoryId TEXT NOT NULL,
      commitSha TEXT NOT NULL,
      parentDeploymentId TEXT REFERENCES deployments(deploymentId),
      worktree TEXT NOT NULL,
      status TEXT NOT NULL,
      stage TEXT,
      sitePort TEXT,
      createdAt TEXT NOT NULL
    ) STRICT`);
    legacy.run(
      `INSERT INTO deployments VALUES (?, ?, ?, NULL, ?, 'ready', NULL, '47321', ?)`,
      [
        first.deploymentId,
        first.repositoryId,
        first.commit,
        first.worktree,
        new Date().toISOString(),
      ]
    );
    legacy.close();
    await chmod(file, 0o600);

    const store = await openDeploymentStore(file);
    try {
      expect(store.read(first.deploymentId)).toMatchObject({
        commit: first.commit,
        status: "ready",
      });
      expect(store.list().unreadable).toBe(0);
    } finally {
      store.close();
    }
    // Reopening the migrated file reads it the same way.
    const reopened = await openDeploymentStore(file);
    try {
      expect(reopened.read(first.deploymentId)).toMatchObject({
        status: "ready",
      });
    } finally {
      reopened.close();
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("a corrupt deployment row is reported unreadable without replacing earlier records", async () => {
  const temp = await mkdtemp(join(tmpdir(), "devver-store-"));
  const file = join(temp, "deployments.sqlite");
  try {
    const store = await openDeploymentStore(file);
    store.record(first);
    store.markReady(first.deploymentId);
    store.record(second);
    store.markReady(second.deploymentId);
    store.close();

    // Only a writer outside this module can produce a row the schema rejects.
    const raw = new Database(file);
    raw.run("UPDATE deployments SET status = 'bogus' WHERE deploymentId = ?", [
      second.deploymentId,
    ]);
    raw.close();

    const reopened = await openDeploymentStore(file);
    try {
      const { deployments, unreadable } = reopened.list();
      expect(unreadable).toBe(1);
      expect(deployments).toHaveLength(1);
      expect(deployments[0]).toMatchObject({
        deploymentId: first.deploymentId,
        status: "ready",
      });
      expect(() => reopened.read(second.deploymentId)).toThrow();
    } finally {
      reopened.close();
    }

    // The unreadable record is still there: nothing overwrote or dropped it.
    const after = new Database(file, { readonly: true });
    const rows = after
      .query("SELECT status FROM deployments WHERE deploymentId = ?")
      .all(second.deploymentId);
    after.close();
    expect(rows).toEqual([{ status: "bogus" }]);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
