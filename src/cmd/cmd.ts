import type { CommandModule } from "yargs";

/** Captures `--` passthrough args that yargs strips by default. */
type WithDoubleDash<T> = T & { "--"?: string[] };

/** Thin wrapper to get full type inference on yargs CommandModule. */
export function cmd<T, U>(input: CommandModule<T, WithDoubleDash<U>>) {
  return input;
}
