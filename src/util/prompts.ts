import * as prompts from "@clack/prompts";
import { Effect } from "effect";

const intro = (msg: string) => Effect.sync(() => prompts.intro(msg));
const outro = (msg: string) => Effect.sync(() => prompts.outro(msg));

const log = {
  info: (msg: string) => Effect.sync(() => prompts.log.info(msg)),
};

type PromptOption<Value> = { label: string; value: Value };

const select = <Value>(opts: Parameters<typeof prompts.select<Value>>[0]) =>
  Effect.tryPromise(() => prompts.select(opts)).pipe(
    Effect.map((result) => {
      console.log(result);
      if (prompts.isCancel(result)) {
        return "Canceled";
      }
      return result;
    })
  );

const spinner = () => {
  const s = prompts.spinner();
  return {
    start: (msg: string) => Effect.sync(() => s.start(msg)),
    stop: (msg: string) => Effect.sync(() => s.stop(msg)),
  };
};

export const Prompt = {
  intro,
  outro,
  select,
  spinner,
};
