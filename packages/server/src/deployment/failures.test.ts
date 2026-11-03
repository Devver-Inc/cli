import { expect, test } from "bun:test";

import { Effect, Exit } from "effect";

import { DeployFailure } from "../api";
import { attempt, failureStage } from "./failures";

const failureOf = async <A>(effect: Effect.Effect<A, DeployFailure>) => {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) {
    throw new Error("The step was expected to fail");
  }
  return exit;
};

test("a plain subprocess sentence is reported with its stage", async () => {
  const exit = await failureOf(
    attempt("git", () => {
      throw new Error("Merging deployments requires Git 2.38 or newer");
    })
  );
  expect(failureStage(exit)).toBe("git");
  expect(exit.cause.toString()).toContain(
    "git: Merging deployments requires Git 2.38 or newer"
  );
});

test.each([
  ["/Users/someone/secret/path failed", "the commit could not be synchronized"],
  ["token=abc123:xyz", "the commit could not be synchronized"],
  ["multi\nline", "the commit could not be synchronized"],
  ["single", "the commit could not be synchronized"],
])(
  "an unsafe message %p is replaced by a stage message",
  async (detail, safe) => {
    const exit = await failureOf(
      attempt("git", () => {
        throw new Error(detail);
      })
    );
    const rendered = exit.cause.toString();
    expect(rendered).toContain(safe);
    expect(rendered).not.toContain(detail);
  }
);

test("an existing staged failure keeps its own stage and message", async () => {
  const exit = await failureOf(
    attempt(
      "config",
      async () =>
        await Promise.reject(
          new DeployFailure({
            stage: "readiness",
            message: "readiness: the app URL answered with status 502",
          })
        )
    )
  );
  expect(failureStage(exit)).toBe("readiness");
});

test("an unknown failure is attributed to the server", () => {
  expect(failureStage(Exit.fail("boom"))).toBe("server");
  expect(failureStage(Exit.succeed(undefined))).toBe("server");
});
