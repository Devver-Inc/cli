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

  return new Promise<void>((resolve) => {
    const onExit = async () => {
      await input.onExit?.();
      resolve();
    };

    createRoot(renderer).render(
      <ExitProvider onExit={onExit}>
        <App />
      </ExitProvider>
    );
  });
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
