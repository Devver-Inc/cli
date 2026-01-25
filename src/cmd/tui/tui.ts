import { cmd } from "../cmd";
import { tui } from "./app";

export const TuiCommand = cmd({
	command: "$0 [project]",
	describe: "start opencode tui",
	builder: (yargs) =>
		yargs
			.positional("project", {
				type: "string",
				describe: "path to start opencode in",
			})
			.option("model", {
				type: "string",
				alias: ["m"],
				describe: "model to use in the format of provider/model",
			})
			.option("continue", {
				alias: ["c"],
				describe: "continue the last session",
				type: "boolean",
			})
			.option("session", {
				alias: ["s"],
				type: "string",
				describe: "session id to continue",
			})
			.option("prompt", {
				type: "string",
				describe: "prompt to use",
			})
			.option("agent", {
				type: "string",
				describe: "agent to use",
			}),
	handler: async (args) => {
		const tuiPromise = tui({
			url: "",
			args: {
				continue: args.continue,
				sessionID: args.session,
				agent: args.agent,
				model: args.model,
				prompt: args.prompts,
			},
			onExit: async () => {
				console.log("goodbye");
			},
		});

		setTimeout(() => {
			// client.call("checkUpgrade", { directory: cwd }).catch(() => {});
			// Update
		}, 1000);

		await tuiPromise;
	},
});
