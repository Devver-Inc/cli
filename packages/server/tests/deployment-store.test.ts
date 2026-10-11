import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
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
