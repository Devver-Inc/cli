import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

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

function sourceDirectory(): string {
  const executableDirectory = dirname(process.execPath);
  if (existsSync(join(executableDirectory, "scripts/target-version.ts"))) {
    return executableDirectory;
  }
  return join(import.meta.dirname, "../../../..");
}

function git(...args: string[]): string | undefined {
  const result = spawnSync("git", args, {
    cwd: sourceDirectory(),
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

function sourcePlannedVersion(packageVersion: string): string {
  if (
    process.argv.includes("--version") ||
    process.argv.includes("-V") ||
    process.argv.includes("tui")
  ) {
    const result = spawnSync(
      "bun",
      ["run", "scripts/target-version.ts", "--local"],
      { cwd: sourceDirectory(), encoding: "utf-8" }
    );
    if (result.status === 0 && result.stdout.trim() !== "") {
      return result.stdout.trim();
    }
  }
  return packageVersion;
}

export function versionLine(packageVersion: string): string {
  const version = stampedVersion ?? sourcePlannedVersion(packageVersion);
  const channel = stampedChannel ?? "dev";
  const commit = stampedCommit ?? sourceCommit();
  return commit === undefined || commit === ""
    ? `${version} (${channel})`
    : `${version} (${channel}, ${commit})`;
}
