import {
  intro as clackIntro,
  outro as clackOutro,
  select as clackSelect,
  spinner as clackSpinner,
  isCancel,
  password,
  text,
} from "@clack/prompts";
import { Effect } from "effect";

const YNOpts = [
  { value: "Yes", label: "Yes" },
  { value: "No", label: "No" },
];
const Questions = { YNOpts };

const intro = (msg: string) =>
  Effect.sync(() => {
    clackIntro(msg);
  });
const outro = (msg: string) =>
  Effect.sync(() => {
    clackOutro(msg);
  });

const select = <Value>(opts: Parameters<typeof clackSelect<Value>>[0]) =>
  Effect.tryPromise(async () => clackSelect(opts)).pipe(
    Effect.map((result) => (isCancel(result) ? "Canceled" : result))
  );

const spinner = () => {
  const s = clackSpinner();
  return {
    start: (msg: string) =>
      Effect.sync(() => {
        s.start(msg);
      }),
    stop: (msg: string) =>
      Effect.sync(() => {
        s.stop(msg);
      }),
  };
};

const input = (message: string) =>
  Effect.tryPromise(async () => text({ message })).pipe(
    Effect.map((result) => (isCancel(result) ? "Canceled" : result))
  );

const secretInput = (message: string) =>
  Effect.tryPromise(async () => password({ message })).pipe(
    Effect.map((result) => (isCancel(result) ? "Canceled" : result))
  );

const promptYesNo = async (message: string): Promise<boolean> =>
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
  secretInput,
  Questions,
  promptYesNo,
};
