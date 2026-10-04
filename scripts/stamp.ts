import { spawnSync } from "node:child_process";
import pkg from "../package.json";

function git(...args: string[]): string | undefined {
  const result = spawnSync("git", args, { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

export function commitStamp(): string {
  const commit = git("rev-parse", "--short=7", "HEAD");
  if (!commit) {
    return "unknown";
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
