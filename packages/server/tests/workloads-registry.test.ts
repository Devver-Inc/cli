import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  defaultKind,
  kindByName,
  prepareDaemon,
  workloadNames,
} from "../src/workloads";

const kindsDirectory = join(import.meta.dirname, "..", "src", "workloads");

test("every registered kind names a module in src/workloads", async () => {
  const files = new Set(
    (await readdir(kindsDirectory)).map((file) => file.replace(/\.ts$/u, ""))
  );
  for (const name of workloadNames) {
    expect(
      files.has(name),
      `the registry knows "${name}" but src/workloads/${name}.ts does not exist`
    ).toBe(true);
  }
});

test("every kind module beside config and types is in the registry", async () => {
  const modules = (await readdir(kindsDirectory))
    .filter((file) => file.endsWith(".ts"))
    .map((file) => file.replace(/\.ts$/u, ""))
    .filter((name) => name !== "config" && name !== "types");
  expect(modules.length).toBe(workloadNames.length);
  for (const name of modules) {
    expect(
      kindByName(name),
      `src/workloads/${name}.ts exists but the registry does not know "${name}"`
    ).toBeDefined();
  }
});

test("the registry default is a registered kind", () => {
  expect(kindByName(defaultKind.name)).toBe(defaultKind);
  expect(workloadNames).toContain(defaultKind.name);
});

test("an unknown workload fails before a process is prepared", async () => {
  const worktree = await mkdtemp(join(tmpdir(), "devver-workload-"));
  try {
    await writeFile(join(worktree, ".devver.yaml"), "workload: node\n");
    expect(prepareDaemon(worktree)).rejects.toThrow(
      "The workload must be one of: static"
    );
  } finally {
    await rm(worktree, { recursive: true, force: true });
  }
});
