import { openDeploymentStore } from "../deployments";

const [mode, file] = process.argv.slice(2);
if (file === undefined || file === "") {
  throw new Error("Missing deployment store path");
}
const store = await openDeploymentStore(file);
const id = "031fdbdf-3c42-4d19-8909-9a2cf4690cb0";
const commit = "7034b34db3efb2e159289794b817da197f84c66e";
try {
  if (mode === "write") {
    store.record({
      deploymentId: id,
      repositoryId: "repo-1",
      commit,
      parentDeploymentId: null,
      worktree: "/tmp/devver-probe-worktree",
    });
    store.markReady(id);
    store.setAppPort(47_320);
  } else if (mode !== "read") {
    throw new Error("Usage: probe <write|read> <file>");
  }
  const record = store.read(id);
  if (record === undefined) {
    throw new Error("Deployment record did not survive");
  }
  console.log(
    JSON.stringify({
      runtime: process.versions.bun === undefined ? "node" : "bun",
      appPort: store.appPort(),
      ...record,
    })
  );
} finally {
  store.close();
}
