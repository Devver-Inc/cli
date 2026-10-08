import { createCliRenderer, TextAttributes } from "@opentui/core";
import { createRoot, useKeyboard } from "@opentui/react";
import type { ReactNode } from "react";

import { ExitProvider, useExit } from "./exit";

export type Args = Record<string, string>;

function App({ version }: { version: string }): ReactNode {
  const exit = useExit();

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      void (async () => {
        try {
          await exit();
        } catch {
          // onExit has already rejected tui()'s promise; avoid a second rejection.
          process.exitCode = 1;
        }
      })();
    }
  });

  return (
    <box alignItems="center" flexGrow={1} justifyContent="center">
      <box alignItems="center" flexDirection="column" justifyContent="center">
        <ascii-font font="slick" text="Devver" />
        <text attributes={TextAttributes.DIM}>{version}</text>
        <text attributes={TextAttributes.DIM}>What will you build?</text>
        <text attributes={TextAttributes.DIM}>Press Ctrl+C to exit</text>
      </box>
    </box>
  );
}

export async function tui(input: {
  url: string;
  args: Args;
  directory?: string;
  version: string;
  onExit?: () => Promise<void>;
}) {
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  const root = createRoot(renderer);
  try {
    await new Promise<void>((resolve, reject) => {
      const onExit = async () => {
        try {
          await input.onExit?.();
          resolve();
        } catch (error) {
          reject(error instanceof Error ? error : new Error("TUI exit failed"));
        }
      };
      root.render(
        <ExitProvider onExit={onExit}>
          <App version={input.version} />
        </ExitProvider>
      );
    });
  } finally {
    try {
      renderer.setTerminalTitle("");
      root.unmount();
    } finally {
      renderer.destroy();
    }
  }
}
