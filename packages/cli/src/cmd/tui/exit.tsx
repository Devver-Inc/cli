import { createContext, useCallback, useContext, useRef } from "react";
import type { ReactNode } from "react";

import { formatError } from "../../error";

type Exit = (reason?: Error) => Promise<void>;
const ExitContext = createContext<Exit | undefined>(undefined);

export function ExitProvider({
  children,
  onExit,
}: {
  children: ReactNode;
  onExit?: () => Promise<void>;
}): ReactNode {
  const exiting = useRef(false);
  const exit = useCallback(
    async (reason?: Error) => {
      if (exiting.current) {
        return;
      }
      exiting.current = true;
      await onExit?.();
      if (reason !== undefined) {
        const formatted = formatError(reason);
        if (formatted !== undefined && formatted !== "") {
          process.stderr.write(`${formatted}\n`);
        }
        process.exitCode = 1;
      }
    },
    [onExit]
  );
  return <ExitContext.Provider value={exit}>{children}</ExitContext.Provider>;
}

export function useExit() {
  const exit = useContext(ExitContext);
  if (exit === undefined) {
    throw new Error("Exit context must be used within an ExitProvider");
  }
  return exit;
}
