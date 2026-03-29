import {
  intro as clackIntro,
  outro as clackOutro,
  select as clackSelect,
  spinner as clackSpinner,
  isCancel,
  text,
} from "@clack/prompts";
import { Effect } from "effect";

const YNOpts = [
  { value: "Yes", label: "Yes" },
  { value: "No", label: "No" },
];
const Questions = { YNOpts };

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

const input = (message: string) =>
  Effect.tryPromise(() => text({ message })).pipe(
    Effect.map((result) => {
      console.log(result);
      if (isCancel(result)) {
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
