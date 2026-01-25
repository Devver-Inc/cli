import { cmd } from "./cmd";

const SecretSetCommand = cmd({
	command: "set [key] [val]",
	describe: "Set a secret or import from file",
	builder: (yargs) =>
		yargs
			.positional("key", {
				type: "string",
				demandOption: true,
				describe: "Secret key",
			})
			.positional("val", {
				type: "string",
				demandOption: true,
				describe: "Secret value",
			})
			.option("file", {
				type: "string",
				alias: "f",
				describe: "Import secrets from .env file",
			})
			.check((args) => {
				if (args.file && (args.key || args.val)) {
					throw new Error("Cannot use --file with key/val arguments");
				}
				if (!args.file && (!args.key || !args.val)) {
					throw new Error("Provide <key> <val> or --file <path>");
				}
				return true;
			}),
	handler: async (args) => {
		if (args.file) {
			console.log("Importing from file:", args.file);
		} else {
			console.log("Setting secret:", args.key, "=", args.val);
		}
	},
});

const SecretListCommand = cmd({
	command: "list",
	describe: "List secret keys",
	async handler() {
		console.log("List secrets keys ...");
	},
});

const DeleteSecretCommand = cmd({
	command: "delete <key>",
	describe: "Remove a secret",
	builder: (yargs) =>
		yargs.positional("key", {
			type: "string",
			demandOption: true,
			describe: "Secret key",
		}),
	async handler(args) {
		console.log("Deleting secret ", args.key);
	},
});

export const SecretCommand = cmd({
	command: "secret",
	describe: "manage secrets",
	builder: (yargs) =>
		yargs
			.command(SecretSetCommand)
			.command(SecretListCommand)
			.command(DeleteSecretCommand)
			.demandCommand(),
	async handler() {},
});
