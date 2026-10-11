import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Schema } from "effect";
import { load } from "js-yaml";

const ci = Schema.decodeUnknownSync(
  Schema.Struct({
    jobs: Schema.Struct({
      build: Schema.Struct({
        steps: Schema.Array(
          Schema.Struct({
            name: Schema.optional(Schema.String),
            run: Schema.optional(Schema.String),
          })
        ),
      }),
    }),
  })
)(
  load(
    readFileSync(
      join(import.meta.dir, "..", ".github/workflows/ci.yml"),
      "utf-8"
    )
  )
);

const guard = ci.jobs.build.steps.find(
  (step) => step.name === "Require release intent on pull requests"
)?.run;

test("PR check accepts an empty changeset, but rejects a PR without release intent", () => {
  expect(guard).toBeDefined();
  expect(
    ci.jobs.build.steps.find((step) => step.name === "Validate PR changesets")
      ?.run
  ).toContain("changeset status --since");
  const directory = mkdtempSync(join(tmpdir(), "devver-changeset-ci-"));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], {
      cwd: directory,
      stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  };
  const check = () =>
    Bun.spawnSync(["bash", "-e", "-c", guard ?? "exit 1"], {
      cwd: directory,
      env: { ...process.env, BASE: "develop" },
      stderr: "pipe",
    });
  try {
    git("init", "-b", "develop");
    writeFileSync(join(directory, "README.md"), "baseline");
    git("add", ".");
    git(
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "baseline"
    );
    git("remote", "add", "origin", directory);
    git("checkout", "-b", "feature");
    writeFileSync(join(directory, "README.md"), "updated");
    git("add", ".");
    git(
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "docs"
    );
    expect(check().exitCode).not.toBe(0);

    mkdirSync(join(directory, ".changeset"));
    writeFileSync(join(directory, ".changeset", "no-release.md"), "---\n---\n");
    git("add", ".");
    git(
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "no release"
    );
    expect(check().exitCode).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
