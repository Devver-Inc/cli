import { EOL } from "node:os"
import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { AuthCommand } from "./cmd/auth"
import { DeployCommand } from "./cmd/deploy"
import { ProjectCommand } from "./cmd/project"
import { SecretCommand } from "./cmd/secret"
import { TuiCommand } from "./cmd/tui/tui"
import { FormatError } from "./error"
import { UI } from "./ui"

process.on("unhandledRejection", (e) => {
  console.error("exception", {
    e: e instanceof Error ? e.message : e,
  })
})

process.on("uncaughtException", (e) => {
  console.error("exception", {
    e: e instanceof Error ? e.message : e,
  })
})

export const VERSION = "0.1"
export const LOG_FILE_PATH = ""

const cli = yargs(hideBin(process.argv))
  .parserConfiguration({ "populate--": true })
  .scriptName("devver")
  .wrap(100)
  .help("help", "show help")
  .alias("help", "h")
  .version("version", "show version number", VERSION)
  .alias("version", "v")
  // .option("print-logs", {
  // 	describe: "print logs to stderr",
  // 	type: "boolean",
  // })
  // .option("log-level", {
  // 	describe: "log level",
  // 	type: "string",
  // 	choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  // })
  // .middleware(async (opts) => {
  // 	console.info("devver", {
  // 		version: VERSION,
  // 		args: process.argv.slice(2),
  // 	});
  // })
  .command(TuiCommand)
  .command(AuthCommand)
  .command(DeployCommand)
  .command(ProjectCommand)
  .command(SecretCommand)
  .usage(`\n${UI.logo()}`)
  .completion("completion", "generate shell completion script")
  .fail((msg, err) => {
    if (
      msg?.startsWith("Unknown argument") ||
      msg?.startsWith("Not enough non-option arguments") ||
      msg?.startsWith("Invalid values:")
    ) {
      if (err) throw err
      cli.showHelp("log")
    }
    if (err) throw err
    process.exit(1)
  })
  .strict()

try {
  await cli.parse()
} catch (e) {
  const data: Record<string, unknown> = {}

  if (e instanceof Error) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      cause: e.cause?.toString(),
      stack: e.stack,
    })
  }

  if (e instanceof ResolveMessage) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      code: e.code,
      specifier: e.specifier,
      referrer: e.referrer,
      position: e.position,
      importKind: e.importKind,
    })
  }
  console.error("fatal", data)
  const formatted = FormatError(e)
  if (formatted) UI.error(formatted)
  if (formatted === undefined) {
    UI.error(`Unexpected error, check log file at ${LOG_FILE_PATH} for more details${EOL}`)
    console.error(e instanceof Error ? e.message : String(e))
  }
  process.exitCode = 1
} finally {
  // Explicitly exit to avoid any hanging subprocesses.
  if (process.exitCode) {
    process.exit()
  }
}
