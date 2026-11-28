import { expect, test } from "bun:test";

import { Data, Effect, Fiber } from "effect";

import { execute, runAbortable } from "./exec";

class ProbeError extends Data.TaggedError("ProbeError")<{
  readonly message: string;
}> {}

const probeFail = () =>
  new ProbeError({ message: "the probe subprocess failed" });

const sleep = async (ms: number) => {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

test("an abortable task reports its value and mapped failure", async () => {
  const value = await Effect.runPromise(
    runAbortable(async () => await Promise.resolve("prepared"), probeFail)
  );
  expect(value).toBe("prepared");

  const exit = await Effect.runPromiseExit(
    runAbortable(
      async () =>
        await Promise.reject(
          new Error("Merging deployments requires Git 2.38 or newer")
        ),
      probeFail
    )
  );
  expect(exit._tag).toBe("Failure");
});

test("an interrupted abortable task is awaited to settlement before the fiber unwinds", async () => {
  let settled = false;
  const resumed = { later: false };
  const task = async (signal: AbortSignal) => {
    await new Promise<string>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        setTimeout(() => {
          settled = true;
          reject(new Error("killed"));
        }, 120);
      });
    });
  };
  const effect = Effect.andThen(
    runAbortable(task, probeFail),
    Effect.sync(() => {
      resumed.later = true;
    })
  );
  const fiber = Effect.runFork(effect);
  await sleep(60);
  await Effect.runPromise(Fiber.interrupt(fiber));
  expect(settled).toBe(true);
  expect(resumed.later).toBe(false);
});

test("interrupting an abortable real subprocess kills it before its natural exit", async () => {
  const started = Date.now();
  const effect = runAbortable(
    async (signal) => await execute("sleep", ["3"], { signal }),
    probeFail
  );
  const fiber = Effect.runFork(effect);
  await sleep(120);
  await Effect.runPromise(Fiber.interrupt(fiber));
  const elapsed = Date.now() - started;
  expect(elapsed).toBeLessThan(2500);
});

test("a task that throws synchronously is reported as its mapped failure", async () => {
  const exit = await Effect.runPromiseExit(
    runAbortable(async () => {
      throw new Error("synchronously aborted");
    }, probeFail)
  );
  expect(exit._tag).toBe("Failure");
});
