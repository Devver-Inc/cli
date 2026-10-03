import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = join(import.meta.dir, "..", "src", "util", "git", "index.ts");
const commitHash = /^[a-f0-9]{40,64}$/;

const git = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr.toString()}`
    );
  }
};

function inspect(cwd: string, source: string, env?: Record<string, string>) {
  const script = `
    import { checkForConflicts, checkRemoteBranch, getCurrentBranch, getCurrentCommit } from ${JSON.stringify(entry)};
    const remote = ${JSON.stringify(source)};
    const missing = remote + "-missing";
    const failure = async (work) => { try { await work(); return null; } catch (error) { return error.message; } };
    console.log(JSON.stringify({
      branch: await getCurrentBranch(),
      commit: await getCurrentCommit(),
      present: await checkRemoteBranch(remote, "main", async () => { throw new Error("prompted for existing branch"); }),
      absent: await checkRemoteBranch(remote, "new-branch", async () => true),
      refused: await failure(() => checkRemoteBranch(remote, "new-branch", async () => false)),
      missing: await failure(() => checkRemoteBranch(missing, "main", async () => true)),
      safe: await failure(() => checkForConflicts(remote, "main", true)),
      failedFetch: await failure(() => checkForConflicts(missing, "main", true)),
      skipped: await failure(() => checkForConflicts(missing, "main", false)),
    }));
  `;
  const result = Bun.spawnSync(["bun", "-e", script], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`preflight probe failed: ${result.stderr.toString()}`);
  }
  const lines = result.stdout.toString().trim().split("\n");
  return JSON.parse(lines.at(-1) ?? "null");
}

test("Git preflight distinguishes absent branches from transport failures and conflicts", () => {
  const root = mkdtempSync(join(tmpdir(), "devver-git-"));
  const local = join(root, "local");
  const other = join(root, "other");
  const remote = join(root, "remote.git");
  const unrelated = join(root, "unrelated.git");
  try {
    mkdirSync(local);
    git(local, "init", "-q", "-b", "main");
    git(local, "config", "user.email", "test@example.org");
    git(local, "config", "user.name", "Test");
    writeFileSync(join(local, "file"), "one");
    git(local, "add", "file");
    git(local, "commit", "-qm", "first");
    writeFileSync(join(local, "file"), "two");
    git(local, "add", "file");
    git(local, "commit", "-qm", "second");
    git(root, "clone", "--bare", "-q", local, remote);
    const safe = inspect(local, remote);
    expect(safe.branch).toBe("main");
    expect(safe.commit).toMatch(commitHash);
    expect(safe.present).toBe(true);
    expect(safe.absent).toBe(false);
    expect(safe.refused).toContain("branch to exist");
    expect(safe.missing).toContain("ls-remote failed");
    expect(safe.safe).toBeNull();
    expect(safe.failedFetch).toContain("fetch failed");
    expect(safe.skipped).toBeNull();

    git(local, "reset", "--hard", "HEAD~1");
    expect(inspect(local, remote).safe).toContain("Please pull");

    mkdirSync(other);
    git(other, "init", "-q", "-b", "main");
    git(other, "config", "user.email", "test@example.org");
    git(other, "config", "user.name", "Test");
    writeFileSync(join(other, "unrelated"), "unrelated");
    git(other, "add", "unrelated");
    git(other, "commit", "-qm", "unrelated");
    git(root, "clone", "--bare", "-q", other, unrelated);
    expect(inspect(local, unrelated).safe).toContain("merge-base failed");

    if (process.platform !== "win32") {
      const bin = join(root, "bin");
      mkdirSync(bin);
      const wrapper = join(bin, "git");
      writeFileSync(
        wrapper,
        `#!/bin/sh\nif [ "$1" = rev-list ]; then if [ "$GIT_STUB_MODE" = invalid ]; then echo invalid; exit 0; fi; exit 4; fi\nexec "${Bun.which("git")}" "$@"\n`
      );
      chmodSync(wrapper, 0o755);
      expect(
        inspect(local, remote, {
          PATH: `${bin}:${process.env.PATH}`,
          GIT_STUB_MODE: "invalid",
        }).safe
      ).toContain("invalid ahead/behind");
      expect(
        inspect(local, remote, {
          PATH: `${bin}:${process.env.PATH}`,
          GIT_STUB_MODE: "failed",
        }).safe
      ).toContain("rev-list failed");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
