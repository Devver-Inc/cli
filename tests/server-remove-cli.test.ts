import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

const runs = process.platform === "darwin" || process.platform === "linux";

test.if(runs)(
  "server remove refuses a nonexistent instance without prompting",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "devver-server-remove-"));
    try {
      for (const name of ["data", "config", "state", "cache"]) {
        mkdirSync(join(root, name), { recursive: true });
      }
      const child = Bun.spawn(
        ["bun", "run", cli, "server", "remove", "no-such-instance"],
        {
          cwd: root,
          env: {
            ...process.env,
            XDG_DATA_HOME: join(root, "data"),
            XDG_CONFIG_HOME: join(root, "config"),
            XDG_STATE_HOME: join(root, "state"),
            XDG_CACHE_HOME: join(root, "cache"),
          },
          stdout: "pipe",
          stderr: "pipe",
        }
      );
      const [status, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(status).not.toBe(0);
      const output = `${out}${err}`;
      expect(output).toContain("no-such-instance");
      expect(output).not.toContain("cannot be undone");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
);
