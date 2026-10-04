import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("nightly skips unchanged develop and publishes the exact tested commit", () => {
  const workflow = readFileSync(
    join(import.meta.dir, "..", ".github/workflows/nightly.yml"),
    "utf8"
  );
  expect(workflow).toContain("git rev-parse 'FETCH_HEAD^{commit}'");
  expect(workflow).toContain("echo 'changed=false' >> \"$GITHUB_OUTPUT\"");
  expect(workflow).toContain("if: needs.prepare.outputs.changed == 'true'");
  expect(workflow).toContain("-nightly.build.");
  expect(workflow).toContain("GITHUB_RUN_NUMBER");
  expect(workflow).toContain('--target "$SHA" --title "$VERSION"');
});
