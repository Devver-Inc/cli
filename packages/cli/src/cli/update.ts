import { Console, Effect } from "effect";

import { installUpdate } from "../infra/update";

export const runUpdate = installUpdate.pipe(
  Effect.map((result) => {
    if (result.kind === "current") {
      return `Already up to date (${result.version}).`;
    }
    return result.installer === "brew"
      ? "Homebrew upgrade completed. Check devver --version."
      : `Installed ${result.channel} ${result.version}.`;
  }),
  Effect.flatMap(Console.log)
);
