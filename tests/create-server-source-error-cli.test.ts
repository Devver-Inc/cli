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

// Windows keeps instance state in the real %LOCALAPPDATA% and cannot be
// isolated through XDG overrides.
const runs = process.platform === "darwin" || process.platform === "linux";

test.if(runs)(
  "creating a server from source explains that it needs a packaged build",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "devver-create-from-source-"));
    try {
      for (const name of ["data", "config", "state", "cache"]) {
        mkdirSync(join(root, name), { recursive: true });
      }
      const child = Bun.spawn(["bun", "run", cli, "new", "server", "probe"], {
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
      });
      const [status, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);

      expect(status).not.toBe(0);
      expect(out).toBe("");
      expect(err).toContain("Packaged server tool 'devver-server' is missing");
      expect(err).toContain("run 'bun run build'");
      expect(err).not.toContain("ENOENT");
      expect(err).not.toContain("UnknownError");
      expect(err).not.toContain("at async");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
);
