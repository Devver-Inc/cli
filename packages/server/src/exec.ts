import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { Cause, Data, Effect, Stream } from "effect";
import type { PlatformError } from "effect/PlatformError";
import * as ChildProcess from "effect/process/ChildProcess";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";

// The promisified execFile remains for the promise-based host internals and
// the paused Windows ACL tooling; every new subprocess composes runProcess
// over the platform child process service instead.
// oxlint-disable-next-line typescript/strict-void-return -- Node's execFile overload preserves rejected subprocess failures through promisify.
export const execute = promisify(execFile);

// Runs an interruptible promise task to its full settlement: an interrupted
// fiber signals the task, then waits for it to settle before unwinding, so
// scoped permits and finalizers never release around a still-running task.
export const runAbortable = <A, E>(
  task: (signal: AbortSignal) => PromiseLike<A>,
  error: (cause: unknown) => E
): Effect.Effect<A, E> =>
  Effect.callback<A, E>((resume, signal) => {
    let settled = false;
    const taskPromise = (async () => {
      try {
        const value = await task(signal);
        if (!settled) {
          settled = true;
          resume(Effect.succeed(value));
        }
      } catch (taskError) {
        if (!settled) {
          settled = true;
          resume(Effect.fail(error(taskError)));
        }
      }
    })();
    return Effect.promise(async () => {
      await taskPromise;
    });
  });

export interface ProcessOptions {
  readonly cwd?: string | undefined;
  // Replaces the inherited environment unless extendEnv is true.
  readonly env?: Record<string, string | undefined> | undefined;
  readonly extendEnv?: boolean | undefined;
  readonly timeoutMs: number;
  readonly maxBufferBytes: number;
  // Escalates to SIGKILL when the process group ignores SIGTERM this long.
  readonly forceKillAfterMs?: number | undefined;
}

export class ProcessFailure extends Data.TaggedError("ProcessFailure")<{
  readonly outcome: "spawn" | "exit" | "timeout" | "output-limit";
  readonly message: string;
  readonly exitCode?: number;
}> {}

const spawnFailure = (error: PlatformError) =>
  new ProcessFailure({ outcome: "spawn", message: error.message });

const timeoutFailure = () =>
  new ProcessFailure({ outcome: "timeout", message: "the process timed out" });

const outputFailure = () =>
  new ProcessFailure({
    outcome: "output-limit",
    message: "the process produced more output than allowed",
  });

// Runs one subprocess as a scoped platform child process. Interruption and
// the timeout unwind through the handle's scope, which signals the whole
// process group and awaits its exit, so the fiber never releases around a
// still-running or orphaned descendant.
export const runProcess = (
  file: string,
  args: readonly string[],
  options: ProcessOptions
): Effect.Effect<
  { readonly stdout: string },
  ProcessFailure,
  ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make(file, args, {
        cwd: options.cwd,
        env: options.env,
        extendEnv: options.extendEnv,
        windowsHide: true,
        forceKillAfter: options.forceKillAfterMs,
      })
    );
    const collected = yield* Stream.decodeText(handle.stdout).pipe(
      Stream.mapAccum(
        () => ({ text: "", size: 0, over: false }),
        (state, chunk) => {
          const size = state.size + chunk.length;
          const next = {
            text: state.text + chunk,
            size,
            over: size > options.maxBufferBytes,
          };
          return [next, [next]] as const;
        }
      ),
      Stream.takeUntil((state) => state.over),
      Stream.runFold(
        () => ({ text: "", size: 0, over: false }),
        (_, state) => state
      )
    );
    if (collected.over) {
      return yield* outputFailure();
    }
    const exit = yield* handle.exitCode;
    return exit === 0
      ? { stdout: collected.text }
      : yield* new ProcessFailure({
          outcome: "exit",
          exitCode: exit,
          message: `the process exited with status ${exit}`,
        });
  }).pipe(
    Effect.mapError((error) =>
      error instanceof ProcessFailure ? error : spawnFailure(error)
    ),
    Effect.timeout(options.timeoutMs),
    Effect.mapError((error) =>
      Cause.isTimeoutError(error) ? timeoutFailure() : error
    ),
    Effect.scoped
  );
