import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Schema } from "effect";
import { load } from "js-yaml";

const decodeJobs = Schema.decodeUnknownSync(
  Schema.Struct({ jobs: Schema.Record(Schema.String, Schema.Unknown) })
);
const decodeTargets = Schema.decodeUnknownSync(
  Schema.Struct({
    strategy: Schema.Struct({
      matrix: Schema.Struct({
        include: Schema.Array(
          Schema.Struct({ target: Schema.String, os: Schema.String })
        ),
      }),
    }),
  })
);
const decodeOs = Schema.decodeUnknownSync(
  Schema.Struct({
    strategy: Schema.Struct({
      matrix: Schema.Struct({ os: Schema.Array(Schema.String) }),
    }),
  })
);

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

test("Windows jobs and standalone targets stay paused while macOS and Linux remain", () => {
  const { jobs: ci } = decodeJobs(load(workflow("ci")));
  expect(Object.keys(ci)).not.toContain("windows-server");
  expect(Object.keys(ci)).not.toContain("static-deploy-windows");
  expect(decodeOs(ci.test).strategy.matrix.os).toEqual([
    "ubuntu-latest",
    "macos-latest",
  ]);
  for (const [name, job] of [
    ["release", "build"],
    ["dev", "binary"],
    ["nightly", "binary"],
  ] as const) {
    const source = workflow(name);
    const { jobs } = decodeJobs(load(source));
    expect(decodeTargets(jobs[job]).strategy.matrix.include).toEqual([
      { target: "aarch64-apple-darwin", os: "macos-latest" },
      { target: "x86_64-unknown-linux-gnu", os: "ubuntu-latest" },
    ]);
    if (name !== "release") {
      expect(source).toContain("!= 4 )); then");
    }
  }
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
