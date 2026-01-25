import { cmd } from "./cmd"

export const DeployCommand = cmd({
  command: "deploy",
  describe: "deploy current directory",
  async handler() {
    console.log("deploying current project")
  },
})
