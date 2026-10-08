import { spawnSync } from "node:child_process";

declare const DEVVER_VERSION: string;
declare const DEVVER_CHANNEL: string;
declare const DEVVER_COMMIT: string;

// The build replaces these identifiers with string literals; running from
// source leaves them unbound, so only a `typeof` guard is safe here.
// oxlint-disable anti-slop/no-runtime-typeof
const stampedVersion =
  typeof DEVVER_VERSION === "string" ? DEVVER_VERSION : undefined;
const stampedChannel =
  typeof DEVVER_CHANNEL === "string" ? DEVVER_CHANNEL : undefined;
const stampedCommit =
  typeof DEVVER_COMMIT === "string" ? DEVVER_COMMIT : undefined;
// oxlint-enable anti-slop/no-runtime-typeof

function git(...args: string[]): string | undefined {
  const result = spawnSync("git", args, {
    cwd: import.meta.dirname,
    encoding: "utf-8",
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function sourceCommit(): string | undefined {
  const commit = git("rev-parse", "--short=7", "HEAD");
  if (commit === undefined || commit === "") {
    return undefined;
  }
  const pending = git("status", "--porcelain");
  if (pending === undefined) {
    return commit;
  }
  return pending.length > 0 ? `${commit}-dirty` : commit;
}

export function versionLine(packageVersion: string): string {
  const version = stampedVersion ?? packageVersion;
  const channel = stampedChannel ?? "dev";
  const commit = stampedCommit ?? sourceCommit();
  return commit === undefined || commit === ""
    ? `${version} (${channel})`
    : `${version} (${channel}, ${commit})`;
}
