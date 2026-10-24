import {
  CliRenderEvents,
  createCliRenderer,
  createClipboard,
  createHostClipboard,
  createRendererClipboardAdapter,
} from "@opentui/core";
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

export const run = (options: TuiOptions) =>
  Effect.gen(function* () {
    const instance = yield* renderer;
    const { target } = options;
    const localTarget =
      target.kind === "local"
        ? {
            ...target,
            copyUrl: yield* Effect.acquireRelease(
              Effect.sync(() =>
                createClipboard({
                  host: createHostClipboard(),
                  terminal: createRendererClipboardAdapter(instance),
                })
              ),
              (clipboard) =>
                Effect.promise(async () => {
                  await clipboard.dispose();
                })
            ).pipe(
              Effect.map((clipboard) => async (url: string) => {
                const result = await clipboard.writeText(url, {
                  destination: "best-available",
                });
                return (
                  result.host.status === "written" ||
                  result.terminal.status === "attempted"
                );
              })
            ),
          }
        : target;
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
      root.render(<App {...options} target={localTarget} onExit={finish} />);
      return Effect.sync(() => {
        instance.removeListener(CliRenderEvents.DESTROY, finish);
      });
    });
  }).pipe(Effect.scoped);
