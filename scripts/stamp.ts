import { spawnSync } from "node:child_process";

import pkg from "../package.json";

function git(...args: string[]): string | undefined {
  const result = spawnSync("git", args, { encoding: "utf-8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

export function commitStamp(): string {
  const commit = git("rev-parse", "--short=7", "HEAD");
  if (commit === undefined || commit === "") {
    return "unknown";
  }
  const expected = process.env.DEVVER_RELEASE_COMMIT;
  if (
    process.env.DEVVER_RELEASE_CHANNEL === "nightly" &&
    expected !== undefined &&
    expected !== ""
  ) {
    if (git("rev-parse", "HEAD") !== expected) {
      throw new Error("Nightly checkout does not match the tested commit");
    }
    return commit;
  }
  const pending = git("status", "--porcelain");
  if (pending === undefined) {
    return commit;
  }
  return pending.length > 0 ? `${commit}-dirty` : commit;
}

export function buildDefines(channel: "npm" | "standalone") {
  return {
    DEVVER_VERSION: JSON.stringify(pkg.version),
    DEVVER_CHANNEL: JSON.stringify(
      process.env.DEVVER_RELEASE_CHANNEL === "nightly" ? "nightly" : channel
    ),
    DEVVER_COMMIT: JSON.stringify(commitStamp()),
  };
}
