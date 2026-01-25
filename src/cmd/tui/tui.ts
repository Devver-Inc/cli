import { cmd } from "../cmd"
import { tui } from "./app"

export const TuiCommand = cmd({
  command: "$0 [project]",
  describe: "start devver tui",
  builder: (yargs) =>
    yargs.positional("project", {
      type: "string",
      describe: "path to start devver in",
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
        console.log("goodbye")
      },
    })

    // setTimeout(() => {
    // client.call("checkUpgrade", { directory: cwd }).catch(() => {});
    // Update
    // }, 1000);

    await tuiPromise
  },
})
