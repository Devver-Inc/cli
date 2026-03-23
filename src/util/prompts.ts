import * as prompts from "@clack/prompts";
import { Effect } from "effect";

const YNOpts = [
  { value: "Yes", label: "Yes" },
  { value: "No", label: "No" },
];
const Questions = { YNOpts };

const intro = (msg: string) => Effect.sync(() => prompts.intro(msg));
const outro = (msg: string) => Effect.sync(() => prompts.outro(msg));

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

const input = (message: string) =>
  Effect.tryPromise(() => prompts.text({ message })).pipe(
    Effect.map((result) => {
      console.log(result);
      if (prompts.isCancel(result)) {
        return "Canceled";
      }
      return result;
    })
  );

const promptYesNo = (message: string): Promise<boolean> =>
  Effect.runPromise(
    select({
      message,
      options: YNOpts,
    }).pipe(Effect.map((result) => result === "Yes"))
  );

export const Prompt = {
  intro,
  outro,
  select,
  spinner,
  input,
  Questions,
  promptYesNo,
};
