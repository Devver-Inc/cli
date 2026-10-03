import { createCliRenderer, TextAttributes } from "@opentui/core";
import { createRoot, useKeyboard } from "@opentui/react";
import { ExitProvider, useExit } from "./exit";

export type Args = Record<string, unknown>;

export async function tui(input: {
  url: string;
  args: Args;
  directory?: string;
  onExit?: () => Promise<void>;
}) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
  });

  const root = createRoot(renderer);
  try {
    await new Promise<void>((resolve, reject) => {
      const onExit = async () => {
        try {
          await input.onExit?.();
          resolve();
        } catch (error) {
          reject(error);
        }
      };
      root.render(
        <ExitProvider onExit={onExit}>
          <App />
        </ExitProvider>
      );
    });
  } finally {
    root.unmount();
    renderer.destroy();
  }
}

function App() {
  const exit = useExit();

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      exit();
    }
  });

  return (
    <box alignItems="center" flexGrow={1} justifyContent="center">
      <box alignItems="center" flexDirection="column" justifyContent="center">
        <ascii-font font="slick" text="Devver" />
        <text attributes={TextAttributes.DIM}>What will you build?</text>
        <text attributes={TextAttributes.DIM}>Press Ctrl+C to exit</text>
      </box>
    </box>
  );
}
