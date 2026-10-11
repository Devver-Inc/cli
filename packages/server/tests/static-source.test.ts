import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { staticSourceDirectory } from "../static-source";

const roots: string[] = [];

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "devver-static-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { force: true, recursive: true });
  }
});

describe("static source", () => {
  test("defaults to the committed worktree root without config", async () => {
    const root = await temporaryRoot();
    expect(await staticSourceDirectory(root)).toBe(await realpath(root));
  });

  test("uses the configured static directory", async () => {
    const root = await temporaryRoot();
    const site = join(root, "site");
    await mkdir(site);
    await writeFile(join(root, ".devver.yaml"), "static:\n  directory: site\n");
    expect(await staticSourceDirectory(root)).toBe(await realpath(site));
  });

  test("rejects absolute paths, parent traversal and outside symlinks", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    const config = join(root, ".devver.yaml");
    await symlink(outside, join(root, "linked"), "dir");
    for (const directory of ["../outside", outside, "linked"]) {
      await writeFile(config, `static:\n  directory: ${directory}\n`);
      let failure: unknown;
      try {
        await staticSourceDirectory(root);
      } catch (error) {
        failure = error;
      }
      expect(failure).toHaveProperty(
        "message",
        expect.stringContaining("inside the worktree")
      );
    }
  });

  test("allows an asset symlink inside the served directory", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "index.html"), "hello");
    await symlink(join(root, "index.html"), join(root, "page.html"));
    expect(await staticSourceDirectory(root)).toBe(await realpath(root));
  });

  test("rejects an asset symlink that escapes the served directory", async () => {
    const root = await temporaryRoot();
    const site = join(root, "site");
    await mkdir(site);
    await writeFile(join(root, "private.txt"), "private");
    await symlink(join(root, "private.txt"), join(site, "secret.txt"));
    await writeFile(join(root, ".devver.yaml"), "static:\n  directory: site\n");
    let failure: unknown;
    try {
      await staticSourceDirectory(root);
    } catch (error) {
      failure = error;
    }
    expect(failure).toHaveProperty(
      "message",
      "Static directory must be a safe directory inside the worktree"
    );
  });

  test("rejects corrupt configuration without leaking its content", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, ".devver.yaml"), "static: SECRET\n");
    let failure: unknown;
    try {
      await staticSourceDirectory(root);
    } catch (error) {
      failure = error;
    }
    expect(failure).toHaveProperty(
      "message",
      "Invalid static configuration in .devver.yaml"
    );
  });
});
