import { useRenderer } from "@opentui/react";
import { useCallback } from "react";
import { FormatError } from "../../error";
import { createSimpleContext } from "./helper";

export const { use: useExit, Provider: ExitProvider } = createSimpleContext({
  name: "Exit",
  useInit: (props: { onExit?: () => Promise<void> }) => {
    const renderer = useRenderer();

    return useCallback(
      async (reason?: unknown) => {
        renderer.setTerminalTitle("");
        renderer.destroy();
        await props.onExit?.();
        if (reason) {
          const formatted = FormatError(reason);
          if (formatted) {
            process.stderr.write(`${formatted}\n`);
          }
        }
        process.exit(0);
      },
      [renderer, props.onExit]
    );
  },
});
