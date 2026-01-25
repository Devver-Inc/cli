import { cmd } from "./cmd"

const AuthLoginCommand = cmd({
  command: "login",
  describe: "authenticate to your devver server",
  async handler() {
    console.log("logging in ...")
  },
})

const AuthLogoutCommand = cmd({
  command: "logout",
  describe: "logout from your devver server",
  async handler() {
    console.log("logging out ...")
  },
})

const AuthStatusCommand = cmd({
  command: "status",
  describe: "Show login status",
  async handler() {
    console.log("auth status :  ...")
  },
})

export const AuthCommand = cmd({
  command: "auth",
  describe: "manage authentication",
  builder: (yargs) =>
    yargs
      .command(AuthLoginCommand)
      .command(AuthLogoutCommand)
      .command(AuthStatusCommand)
      .demandCommand(),
  async handler() {},
})
