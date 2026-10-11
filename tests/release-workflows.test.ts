import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const workflow = (name: string) =>
  readFileSync(
    join(import.meta.dir, "..", `.github/workflows/${name}.yml`),
    "utf-8"
  );

test("stable release applies changesets, tags its version commit, and builds that tag", () => {
  const stable = workflow("release");
  expect(stable).toContain("workflow_dispatch:");
  expect(stable).toContain("bunx changeset version");
  expect(stable).toMatch(/if: \$\{\{ !inputs\.tag \}\}/u);
  expect(stable).toContain("git merge-base --is-ancestor HEAD origin/main");
  expect(stable).toContain("bun run scripts/adopt-cli-version.ts");
  expect(stable).toContain(
    "awk '/^## /{if(p) exit; p=1; next} p' packages/cli/CHANGELOG.md"
  );
  expect(stable).toContain('git push --atomic origin HEAD:main "$TAG"');
  expect(
    stable.match(/ref: \$\{\{ needs\.plan\.outputs\.tag \}\}/gu)
  ).toHaveLength(3);
  expect(stable).toContain(
    "npm publish --workspace @devver/cli --access public"
  );
});

test("dev artifacts use a verified commit and cannot update npm latest", () => {
  const dev = workflow("dev");
  expect(dev).toContain('test "$GITHUB_REF" = refs/heads/main');
  expect(dev).toContain('test "$(git rev-parse HEAD)" = "$REQUESTED_SHA"');
  expect(dev).toContain("-dev.build.");
  expect(dev).toContain(
    "npm publish --workspace @devver/cli --access public --tag dev"
  );
  expect(dev).toContain("--prerelease");
});
