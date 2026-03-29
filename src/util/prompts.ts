import {
  intro as clackIntro,
  outro as clackOutro,
  select as clackSelect,
  spinner as clackSpinner,
  isCancel,
} from "@clack/prompts";
import { Effect } from "effect";

const intro = (msg: string) => Effect.sync(() => clackIntro(msg));
const outro = (msg: string) => Effect.sync(() => clackOutro(msg));

const select = <Value>(opts: Parameters<typeof clackSelect<Value>>[0]) =>
  Effect.tryPromise(() => clackSelect(opts)).pipe(
    Effect.map((result) => {
      console.log(result);
      if (isCancel(result)) {
        return "Canceled";
      }
      return result;
    })
  );

const spinner = () => {
  const s = clackSpinner();
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
