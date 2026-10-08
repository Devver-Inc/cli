import { Data, Effect } from "effect";
import { Argument, Command, Flag } from "effect/cli";

class UnsupportedSecretError extends Data.TaggedError(
  "UnsupportedSecretError"
)<{
  message: string;
}> {}

const unsupported = (name: string) =>
  Effect.fail(
    new UnsupportedSecretError({
      message: `devver secret ${name} is not supported yet`,
    })
  );

const set = Command.make(
  "set",
  {
    key: Argument.String("key").pipe(Argument.optional),
    value: Argument.String("val").pipe(Argument.optional),
    file: Flag.String("file").pipe(Flag.optional),
  },
  () => unsupported("set")
);
const list = Command.make("list", {}, () => unsupported("list"));
const remove = Command.make("delete", { key: Argument.String("key") }, () =>
  unsupported("delete")
);

export const secret = Command.make("secret").pipe(
  Command.withDescription("Manage secrets (not supported yet)"),
  Command.withSubcommands([set, list, remove])
);
