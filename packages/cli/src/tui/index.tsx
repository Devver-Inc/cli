import { CliRenderEvents, createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { Effect } from "effect";

import { App } from "./app";
import type { AppProps } from "./app";

export type TuiOptions = Omit<AppProps, "onExit">;

const renderer = Effect.acquireRelease(
  Effect.tryPromise(async () => createCliRenderer({ exitOnCtrlC: false })),
  (instance) =>
    Effect.sync(() => {
      instance.destroy();
    })
);

export const run = (options: TuiOptions = {}) =>
  Effect.gen(function* () {
    const instance = yield* renderer;
    const root = yield* Effect.acquireRelease(
      Effect.sync(() => createRoot(instance)),
      (value) =>
        Effect.sync(() => {
          value.unmount();
        })
    );

    yield* Effect.callback((resume) => {
      const finish = () => {
        resume(Effect.void);
      };
      instance.once(CliRenderEvents.DESTROY, finish);
      root.render(<App {...options} onExit={finish} />);
      return Effect.sync(() => {
        instance.removeListener(CliRenderEvents.DESTROY, finish);
      });
    });
  }).pipe(Effect.scoped);
