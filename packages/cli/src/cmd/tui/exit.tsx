import { createContext, useCallback, useContext, useRef } from "react";
import type { ReactNode } from "react";

/**
 * Shutting the view down is the only thing the TUI decides for itself. Failures
 * stay in the Effect that started it, where `NodeRuntime.runMain` renders the
 * cause and sets the exit status.
 */
type Exit = () => Promise<void>;
const ExitContext = createContext<Exit | undefined>(undefined);

export function ExitProvider({
  children,
  onExit,
}: {
  children: ReactNode;
  onExit?: () => Promise<void>;
}): ReactNode {
  const exiting = useRef(false);
  const exit = useCallback(async () => {
    if (exiting.current) {
      return;
    }
    exiting.current = true;
    await onExit?.();
  }, [onExit]);
  return <ExitContext.Provider value={exit}>{children}</ExitContext.Provider>;
}

export function useExit() {
  const exit = useContext(ExitContext);
  if (exit === undefined) {
    throw new Error("Exit context must be used within an ExitProvider");
  }
  return exit;
}
