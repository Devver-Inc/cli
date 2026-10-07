import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("organization switches commit only after refresh and roll back failures", () => {
  const root = mkdtempSync(join(tmpdir(), "devver-org-"));
  const script = `
    import { Effect } from "effect";
    import { switchOrganization } from "./packages/cli/organization.ts";
    import { clearCurrentOrganization, getCurrentOrganization } from "./packages/cli/auth.ts";
    await Effect.runPromise(switchOrganization(null, "org-1", async () => "token"));
    console.log(await getCurrentOrganization());
    try { await Effect.runPromise(switchOrganization("org-1", "org-2", async () => { throw new Error("refresh failed"); })); } catch {}
    console.log(await getCurrentOrganization());
    try { await Effect.runPromise(switchOrganization("org-1", "org-2", async () => null)); } catch {}
    console.log(await getCurrentOrganization());
    await clearCurrentOrganization();
    try { await Effect.runPromise(switchOrganization(null, "org-2", async () => null)); } catch {}
    console.log(await getCurrentOrganization());
  `;
  try {
    const child = Bun.spawnSync(["bun", "-e", script], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        XDG_DATA_HOME: join(root, "data"),
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_CACHE_HOME: join(root, "cache"),
        XDG_STATE_HOME: join(root, "state"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    expect(child.stdout.toString().trim().split("\n")).toEqual([
      "org-1",
      "org-1",
      "org-1",
      "null",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
