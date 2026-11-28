import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Cause, Effect, Exit } from "effect";

import { openResourceEngine } from "../engine";
import type { ResourceProvider } from "../engine";

test("provider output defects render only a static operation failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "devver-engine-output-"));
  chmodSync(dir, 0o700);
  const provider: ResourceProvider = {
    id: "test",
    reconcile: ({ id }) =>
      Effect.succeed(
        id === "broken"
          ? {
              get token() {
                throw new Error("SECRET_FROM_OUTPUT_GETTER");
              },
            }
          : { token: "validated-output" }
      ),
    remove: () => Effect.void,
  };
  try {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* openResourceEngine({
            path: join(dir, "journal.sqlite"),
            providers: [provider],
            concurrency: 1,
          });
          const failure = yield* Effect.exit(
            engine.apply({
              resources: [
                {
                  id: "broken",
                  provider: "test",
                  inputs: {},
                  protection: "delete",
                },
              ],
            })
          );
          const valid = yield* engine.apply({
            resources: [
              {
                id: "valid",
                provider: "test",
                inputs: {},
                protection: "delete",
              },
            ],
          });
          return { failure, valid };
        })
      )
    );
    if (!Exit.isFailure(result.failure)) {
      throw new Error("expected provider output failure");
    }
    const rendered = Cause.pretty(result.failure.cause);
    expect(rendered).toContain("EngineOperationError");
    expect(rendered).toContain("resource reconcile failed");
    expect(rendered).not.toContain("SECRET_FROM_OUTPUT_GETTER");
    expect(result.valid).toEqual({
      resources: [{ id: "valid", output: { token: "validated-output" } }],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
