import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(
  import.meta.dir,
  "..",
  "packages",
  "cli",
  "src",
  "cli",
  "index.ts"
);

test("deploy explains missing Git repository and missing commit without changing either folder", async () => {
  const root = mkdtempSync(join(tmpdir(), "devver-deploy-git-errors-"));
  const env = {
    ...process.env,
    XDG_DATA_HOME: root,
    XDG_CONFIG_HOME: root,
    XDG_CACHE_HOME: root,
    XDG_STATE_HOME: root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(root, "empty-gitconfig"),
  };
  const run = async (cwd: string, ...args: string[]) => {
    const child = Bun.spawn(["bun", "run", cli, "deploy", ...args], {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [status, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { status, stdout: out, stderr: err };
  };
  try {
    const config = join(root, "devver", "config");
    mkdirSync(config, { recursive: true });
    writeFileSync(
      join(config, "cli"),
      JSON.stringify({
        "local-target": {
          url: "http://127.0.0.1:49152/api/v1",
          instanceId: "75758c56-340d-44a2-a709-a52066752456",
          name: "test",
          serverVersion: "0.0.0",
          controlProtocolVersion: 1,
        },
      })
    );
    const plain = join(root, "plain");
    const empty = join(root, "empty-repo");
    mkdirSync(plain);
    mkdirSync(empty);
    const noRepo = await run(plain);
    expect(noRepo.status).not.toBe(0);
    expect(noRepo.stdout).toBe("");
    expect(noRepo.stderr).toBe(
      "This folder is not a Git repository. Run git init to create one.\n"
    );
    expect(existsSync(join(plain, ".git"))).toBe(false);

    const init = Bun.spawnSync(["git", "init", "-q", empty], { env });
    expect(init.exitCode).toBe(0);
    const noCommit = await run(empty);
    expect(noCommit.status).not.toBe(0);
    expect(noCommit.stdout).toBe("");
    expect(noCommit.stderr).toBe(
      "Devver needs a commit to deploy. Commit your changes first.\n"
    );
    expect(
      Bun.spawnSync(["git", "rev-parse", "--verify", "HEAD"], {
        cwd: empty,
        env,
      }).exitCode
    ).not.toBe(0);

    writeFileSync(join(config, "cli"), "{}");
    const otherFailure = await run(plain, "--open");
    expect(otherFailure.status).not.toBe(0);
    expect(otherFailure.stdout).toContain("DeploymentError:");
    expect(otherFailure.stdout).toContain(
      "--open is only supported for local deployments."
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
