import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
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

const runs = process.platform === "darwin" || process.platform === "linux";

test.if(runs)(
  "server remove requires --yes without a TTY before changing state",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "devver-remove-confirm-"));
    try {
      const directory = join(root, "data", "devver", "servers", "probe");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const service = join(directory, "service.json");
      const id = randomUUID();
      writeFileSync(
        service,
        JSON.stringify({
          ...(process.platform === "darwin"
            ? { label: `com.devver.server.${id}` }
            : { unit: `devver-${id}.service` }),
          port: 12_345,
          serverVersion: "1.0.0",
        }),
        { mode: 0o600 }
      );
      const bin = join(root, "bin");
      mkdirSync(bin);
      for (const name of ["systemctl", "launchctl"]) {
        writeFileSync(join(bin, name), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
      }
      const run = async (args: string[], ci = "") => {
        const child = Bun.spawn(
          ["bun", "run", cli, "server", "remove", "probe", ...args],
          {
            env: {
              ...process.env,
              XDG_DATA_HOME: join(root, "data"),
              CI: ci,
              PATH: `${bin}:${process.env.PATH ?? ""}`,
            },
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
          }
        );
        const [status, err] = await Promise.all([
          child.exited,
          new Response(child.stderr).text(),
        ]);
        return { status, err };
      };
      const withoutYes = await run([]);
      expect(withoutYes.status).not.toBe(0);
      expect(withoutYes.err).toContain("--yes");
      expect(existsSync(service)).toBe(true);
      const inCi = await run([], "true");
      expect(inCi.status).not.toBe(0);
      expect(inCi.err).toContain("--yes");
      expect(existsSync(service)).toBe(true);
      const withYes = await run(["-y"]);
      expect(withYes.err).not.toContain("--yes is required");
      expect(withYes.status).not.toBe(0);
      expect(existsSync(service)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
);

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
