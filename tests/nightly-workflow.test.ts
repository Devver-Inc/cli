import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Schema } from "effect";
import { load } from "js-yaml";

const TEST_TIMEOUT = /--timeout (?<timeout>\d+)/u;

test("nightly skips unchanged develop and publishes the exact tested commit", () => {
  const workflow = readFileSync(
    join(import.meta.dir, "..", ".github/workflows/nightly.yml"),
    "utf-8"
  );
  expect(workflow).toContain("git rev-parse 'FETCH_HEAD^{commit}'");
  expect(workflow).toContain("echo 'changed=false' >> \"$GITHUB_OUTPUT\"");
  expect(workflow).toContain("if: needs.prepare.outputs.changed == 'true'");
  expect(workflow).toContain("-nightly.build.");
  expect(workflow).toContain("GITHUB_RUN_NUMBER");
  expect(workflow).toContain('--target "$SHA" --title "$VERSION"');
});

test("CI runs on the develop integration line while Windows jobs are paused", () => {
  // Parsed rather than string-matched: a PR to develop must still run the
  // macOS/Linux jobs, while Windows remains explicitly paused.
  const workflow = Schema.decodeUnknownSync(
    Schema.Struct({
      on: Schema.Struct({
        push: Schema.Struct({ branches: Schema.Array(Schema.String) }),
        pull_request: Schema.Struct({ branches: Schema.Array(Schema.String) }),
      }),
      jobs: Schema.Record(Schema.String, Schema.Unknown),
    })
  )(
    load(
      readFileSync(
        join(import.meta.dir, "..", ".github/workflows/ci.yml"),
        "utf-8"
      )
    )
  );
  expect(workflow.on.pull_request.branches).toContain("develop");
  expect(workflow.on.push.branches).toContain("develop");
  expect(Object.keys(workflow.jobs)).toContain("test");
  expect(Object.keys(workflow.jobs)).not.toContain("windows-server");
});

test("the test script carries a timeout the cross-process suite can actually meet", () => {
  // Bun defaults to 5s per test. Several checks here spawn a CLI process, a
  // packaged server and a service manager, which exceeds that on CI runners,
  // so the default silently killed them with SIGTERM and reported a null exit.
  const manifest = Schema.decodeUnknownSync(
    Schema.Struct({ scripts: Schema.Struct({ test: Schema.String }) })
  )(
    JSON.parse(
      readFileSync(join(import.meta.dir, "..", "package.json"), "utf-8")
    )
  );
  const timeout = TEST_TIMEOUT.exec(manifest.scripts.test)?.groups?.timeout;
  expect(timeout).toBeDefined();
  expect(Number(timeout)).toBeGreaterThanOrEqual(20_000);
});
