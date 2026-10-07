import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const driver = join(import.meta.dir, "list-driver.ts");

function run(data: string, command: "create" | "list", name?: string) {
  const result = Bun.spawnSync(
    ["bun", "run", driver, command, ...(name ? [name] : [])],
    {
      env: { ...process.env, XDG_DATA_HOME: data },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  return {
    code: result.exitCode,
    output: result.stdout.toString(),
    error: result.stderr.toString(),
  };
}

test("listing absent and existing instance state is read-only and sorted", () => {
  if (process.platform === "win32") {
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "devver-list-"));
  const data = join(root, "absent");
  try {
    const empty = run(data, "list");
    expect(empty.code, empty.error).toBe(0);
    expect(JSON.parse(empty.output)).toEqual([]);
    expect(existsSync(data)).toBe(false);
    mkdirSync(join(data, "devver"), { recursive: true, mode: 0o700 });
    const noServers = run(data, "list");
    expect(noServers.code, noServers.error).toBe(0);
    expect(JSON.parse(noServers.output)).toEqual([]);
    expect(existsSync(join(data, "devver", "servers"))).toBe(false);

    const second = run(data, "create", "zeta");
    const first = run(data, "create", "alpha");
    expect(second.code, second.error).toBe(0);
    expect(first.code, first.error).toBe(0);
    const file = join(data, "devver", "servers", "alpha", "identity.json");
    const before = statSync(file).mtimeMs;
    const listed = run(data, "list");
    expect(listed.code, listed.error).toBe(0);
    expect(JSON.parse(listed.output)).toEqual([
      JSON.parse(first.output),
      JSON.parse(second.output),
    ]);
    expect(statSync(file).mtimeMs).toBe(before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listing fails closed for corrupt, symlinked or exposed instance state", () => {
  if (process.platform === "win32") {
    return;
  }
  for (const damage of [
    "corrupt",
    "mismatched-name",
    "symlink",
    "exposed",
    "exposed-dir",
    "exposed-root",
    "exposed-data-root",
    "invalid-name",
  ]) {
    const root = mkdtempSync(join(tmpdir(), "devver-list-unsafe-"));
    try {
      const created = run(root, "create", "safe");
      expect(created.code, created.error).toBe(0);
      const servers = join(root, "devver", "servers");
      const file = join(servers, "safe", "identity.json");
      if (damage === "corrupt") {
        writeFileSync(file, "private broken JSON");
      } else if (damage === "mismatched-name") {
        writeFileSync(
          file,
          JSON.stringify({ ...JSON.parse(created.output), name: "other" })
        );
      } else if (damage === "symlink") {
        rmSync(file);
        symlinkSync(join(root, "outside"), file);
      } else if (damage === "exposed") {
        chmodSync(file, 0o644);
      } else if (damage === "exposed-dir") {
        chmodSync(join(servers, "safe"), 0o755);
      } else if (damage === "exposed-root") {
        chmodSync(servers, 0o755);
      } else if (damage === "exposed-data-root") {
        chmodSync(join(root, "devver"), 0o777);
      } else if (damage === "invalid-name") {
        symlinkSync(join(servers, "safe"), join(servers, "bad.name"));
      }
      const listed = run(root, "list");
      expect(listed.code, damage).not.toBe(0);
      const expected =
        damage === "invalid-name" ? "invalid entry name" : "safe";
      if (damage === "exposed-data-root") {
        expect(listed.error).toContain("Server data root");
      } else {
        expect(listed.error).toContain(
          damage === "exposed-root" ? "owner-only" : expected
        );
      }
      expect(listed.error).not.toContain("private broken JSON");
      if (damage === "corrupt") {
        expect(readFileSync(file, "utf8")).toBe("private broken JSON");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
