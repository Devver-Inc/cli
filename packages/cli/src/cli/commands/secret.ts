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
).pipe(Command.withDescription("Set a secret (not supported yet)"));
const list = Command.make("list", {}, () => unsupported("list")).pipe(
  Command.withDescription("List secrets (not supported yet)")
);
const remove = Command.make("delete", { key: Argument.String("key") }, () =>
  unsupported("delete")
).pipe(Command.withDescription("Delete a secret (not supported yet)"));

export const secret = Command.make("secret").pipe(
  Command.withDescription("Manage secrets (not supported yet)"),
  Command.withSubcommands([set, list, remove])
);
