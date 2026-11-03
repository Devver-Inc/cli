import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { checkBoundaries } from "../scripts/check-boundaries";

function fixture(files: Record<string, string>, check: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "devver-boundaries-"));
  try {
    for (const [file, content] of Object.entries(files)) {
      const path = join(root, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
    check(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("checks imports, test fixtures and cycles rather than silently scanning zero files", () => {
  fixture({}, (root) => {
    expect(checkBoundaries(root)).toEqual([
      "No package source files were scanned",
    ]);
  });
  fixture(
    {
      "packages/foo/index.ts": 'export { value } from "./src/value";',
      "packages/foo/src/value.ts": 'export const value = "foo";',
      "packages/foo/tests/fixture.ts": 'import "../index";',
      "tests/caller.ts": 'import "../packages/foo/index";',
    },
    (root) => {
      expect(checkBoundaries(root)).toEqual([]);
    }
  );
  fixture(
    {
      "packages/foo/index.ts": 'export { value } from "./src/value";',
      "packages/foo/src/value.ts": 'export const value = "foo";',
      "packages/foo/tests/fixture.ts": 'export { value } from "../src/value";',
      "packages/bar/index.ts": 'await import("../foo/src/value");',
      "tests/caller.ts":
        'import "../packages/foo/src/value"; import "../packages/foo/tests/fixture";',
      "scripts/a.ts": 'import "./b";',
      "scripts/b.ts": 'export { x } from "./a";',
    },
    (root) => {
      const errors = checkBoundaries(root).join("\n");
      expect(errors).toContain(
        "packages/foo/tests/fixture.ts imports private module"
      );
      expect(errors).toContain("packages/bar/index.ts imports private module");
      expect(errors).toContain("tests/caller.ts imports private module");
      expect(errors).toContain("tests/caller.ts imports test fixture");
      expect(errors).toContain(
        "Import cycle: scripts/b.ts -> scripts/a.ts -> scripts/b.ts"
      );
    }
  );
});
