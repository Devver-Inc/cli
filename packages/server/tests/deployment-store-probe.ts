import { Effect } from "effect";

import { openDeploymentStore } from "../deployments";

const [mode, file] = process.argv.slice(2);
if (file === undefined || file === "") {
  throw new Error("Missing deployment store path");
}
const id = "031fdbdf-3c42-4d19-8909-9a2cf4690cb0";
const commit = "7034b34db3efb2e159289794b817da197f84c66e";
const result = await Effect.runPromise(
  Effect.gen(function* () {
    const store = yield* openDeploymentStore(file);
    if (mode === "write") {
      yield* store.record({
        deploymentId: id,
        repositoryId: "repo-1",
        commit,
        parentDeploymentId: null,
        worktree: "/tmp/devver-probe-worktree",
      });
      yield* store.markReady(id);
      yield* store.setAppPort(47_320);
    } else if (mode !== "read") {
      throw new Error("Usage: probe <write|read> <file>");
    }
    const record = yield* store.read(id);
    if (record === undefined) {
      throw new Error("Deployment record did not survive");
    }
    return {
      runtime: process.versions.bun === undefined ? "node" : "bun",
      appPort: yield* store.appPort,
      ...record,
    };
  }).pipe(Effect.scoped)
);
console.log(JSON.stringify(result));
