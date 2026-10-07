import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import yaml from "js-yaml";

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

test("CI runs on the develop integration line, including the Windows server job", () => {
  // Parsed rather than string-matched: the point is which branches sit under
  // each trigger. Without develop, a PR to the integration line runs no job at
  // all and the Windows-only server coverage never executes anywhere.
  const workflow = Schema.decodeUnknownSync(
    Schema.Struct({
      on: Schema.Struct({
        push: Schema.Struct({ branches: Schema.Array(Schema.String) }),
        pull_request: Schema.Struct({ branches: Schema.Array(Schema.String) }),
      }),
      jobs: Schema.Record(Schema.String, Schema.Unknown),
    })
  )(
    yaml.load(
      readFileSync(
        join(import.meta.dir, "..", ".github/workflows/ci.yml"),
        "utf8"
      )
    )
  );
  expect(workflow.on.pull_request.branches).toContain("develop");
  expect(workflow.on.push.branches).toContain("develop");
  expect(Object.keys(workflow.jobs)).toContain("windows-server");
});
