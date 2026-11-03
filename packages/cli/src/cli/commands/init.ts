import { Cause, Console, Effect } from "effect";
import { Command } from "effect/cli";

import {
  InitAbortError,
  readConfigFile,
  suggestedLocalConfig,
  writeConfigFile,
} from "../../infra/config";
import { readConfig } from "../../infra/config/api";
import { detectProject } from "../../infra/config/detect";
import { Prompt } from "../prompts";

export const init = Command.make("init", {}, () =>
  Effect.gen(function* () {
    if ((yield* Effect.try(() => readConfigFile())) !== null) {
      yield* Console.log("✓ Config file already exists (.devver.yaml)");
      return;
    }
    const target = yield* Effect.tryPromise(readConfig);
    const detection = yield* Effect.tryPromise(async () => detectProject());
    yield* Console.log("\nProject detection:");
    for (const project of detection.projects) {
      yield* Console.log(
        `  ${project.root}: ${project.stack.framework ?? "unknown"} (${project.stack.category})`
      );
    }
    if (target["local-target"] === undefined) {
      // oxlint-disable-next-line typescript/consistent-return -- A failed Effect exits init before writing a config.
      return yield* new InitAbortError({
        message:
          target["cloud-target"] === true
            ? "Cloud config generation requires a reviewed deployment recipe. Add a verified .devver.yaml manually; no config was written."
            : "No target selected. Run 'devver attach <url>' for a local server or 'devver cloud', then run 'devver init' again. No config was written.",
      });
    }
    const suggested = yield* Effect.try({
      try: () => suggestedLocalConfig(detection),
      catch: (error) =>
        error instanceof InitAbortError ? error : new Cause.UnknownError(error),
    });
    if ("process" in suggested) {
      const run = yield* Prompt.input("Run command", suggested.process.run);
      if (run === "Canceled") {
        // oxlint-disable-next-line typescript/consistent-return -- A failed Effect exits init before any write.
        return yield* new InitAbortError({
          message: "Config creation cancelled. No config was written.",
        });
      }
      if (run.trim() === "") {
        // oxlint-disable-next-line typescript/consistent-return -- A failed Effect exits init before any write.
        return yield* new InitAbortError({
          message: "A run command is required. No config was written.",
        });
      }
      const confirmed = yield* Prompt.select({
        message: "Write this reviewed process recipe?",
        options: Prompt.Questions.YNOpts,
      });
      if (confirmed !== "Yes") {
        // oxlint-disable-next-line typescript/consistent-return -- A failed Effect exits init before any write.
        return yield* new InitAbortError({
          message: "Config creation cancelled. No config was written.",
        });
      }
      yield* Effect.try({
        try: () => {
          writeConfigFile({ process: { run } });
        },
        catch: (error) =>
          error instanceof InitAbortError
            ? error
            : new Cause.UnknownError(error),
      });
    } else {
      yield* Effect.try({
        try: () => {
          writeConfigFile(suggested);
        },
        catch: (error) =>
          error instanceof InitAbortError
            ? error
            : new Cause.UnknownError(error),
      });
    }
  })
);
