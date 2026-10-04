import { CliRenderEvents, createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { Effect } from "effect";
import { App } from "./app";

export interface TuiOptions {
  readonly directory?: string;
  readonly project?: string;
  readonly version?: string;
}

const renderer = Effect.acquireRelease(
  Effect.tryPromise(() => createCliRenderer({ exitOnCtrlC: false })),
  (instance) => Effect.sync(() => instance.destroy())
);

export const run = (options: TuiOptions = {}) =>
  Effect.gen(function* () {
    const instance = yield* renderer;
    const root = yield* Effect.acquireRelease(
      Effect.sync(() => createRoot(instance)),
      (value) => Effect.sync(() => value.unmount())
    );

    yield* Effect.callback<void>((resume) => {
      const finish = () => resume(Effect.void);
      instance.once(CliRenderEvents.DESTROY, finish);
      root.render(<App {...options} onExit={finish} />);
      return Effect.sync(() => {
        instance.removeListener(CliRenderEvents.DESTROY, finish);
      });
    });
  }).pipe(Effect.scoped);
