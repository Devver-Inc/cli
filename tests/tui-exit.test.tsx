import { expect, test } from "bun:test";

import { testRender } from "@opentui/react/test-utils";
import { act, useEffect } from "react";
import type { ReactNode } from "react";

import { ExitProvider, useExit } from "../packages/cli/src/cmd/tui/exit";

function ExitAction({
  onReady,
}: {
  onReady: (exit: () => Promise<void>) => void;
}): ReactNode {
  const exit = useExit();
  useEffect(() => {
    onReady(exit);
  }, [exit, onReady]);
  return <text>Ready</text>;
}

test("repeated exit requests start TUI shutdown only once", async () => {
  const pending = Promise.withResolvers<boolean>();
  let requestExit: (() => Promise<void>) | undefined;
  let calls = 0;
  const setup = await testRender(
    <ExitProvider
      onExit={async () => {
        calls += 1;
        await pending.promise;
      }}
    >
      <ExitAction
        onReady={(exit) => {
          requestExit = exit;
        }}
      />
    </ExitProvider>,
    { width: 20, height: 4 }
  );
  try {
    if (requestExit === undefined) {
      throw new Error("Exit action was not mounted");
    }
    const exit = requestExit;
    await act(async () => {
      const first = exit();
      const second = exit();
      expect(calls).toBe(1);
      pending.resolve(true);
      await Promise.all([first, second]);
    });
  } finally {
    pending.resolve(true);
    await act(async () => {
      setup.renderer.destroy();
    });
  }
});
