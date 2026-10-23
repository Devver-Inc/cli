import { Cause, Effect, Exit } from "effect";

import { run } from "../../src/tui/index";

const exit = await Effect.runPromiseExit(
  run({ project: "demo" }).pipe(Effect.timeout(500))
);

let outcome = "success";
if (Exit.isFailure(exit)) {
  outcome = Cause.isTimeoutError(Cause.squash(exit.cause))
    ? "timeout"
    : Cause.pretty(exit.cause);
}

process.stderr.write(`\nPROBE ${JSON.stringify({ outcome })}\n`);
