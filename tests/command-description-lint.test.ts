import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

test("the Oxlint rule rejects missing and blank command descriptions", () => {
  const output = execFileSync(
    "node",
    [
      "--input-type=module",
      "-e",
      `import { RuleTester } from "oxlint/plugins-dev";
       import plugin from "./scripts/oxlint-command-descriptions.mjs";
       new RuleTester().run("command-description", plugin.rules["command-description"], {
         valid: [
           'Command.make("deploy").pipe(Command.withDescription("Deploy a project"));',
           'Command.make("deploy").pipe(Command.withDescription("Deploy a project"), Command.withSubcommands([]));'
         ],
         invalid: [
           { code: 'Command.make("deploy");', errors: [{ message: /Add .pipe/u }] },
           { code: 'Command.make("deploy").pipe(Command.withDescription("   "));', errors: [{ message: /Add .pipe/u }] },
           { code: 'Command.make("deploy").pipe(Command.withSubcommands([]));', errors: [{ message: /Add .pipe/u }] }
         ]
       });`,
    ],
    { cwd: root, encoding: "utf-8" }
  );
  expect(output).toBe("");
});
