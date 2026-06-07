#!/usr/bin/env -S bun run
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { AuthCommand } from "./cmd/auth";
import { InitConfigCommand } from "./cmd/config";
import { DeployCommand } from "./cmd/deploy";
import { OrganizationCommand } from "./cmd/organization";
import { ProjectCommand } from "./cmd/project";
import { RepositoryCommand } from "./cmd/repos";
import { SecretCommand } from "./cmd/secret";
import { TuiCommand } from "./cmd/tui/tui";
import { FormatError } from "./error";
import { UI } from "./ui";

declare global {
  const DEVVER_VERSION: string;
}

process.on("unhandledRejection", (e) => {
  const formatted = FormatError(e);
  if (formatted) {
    UI.error(formatted);
  }
});

process.on("uncaughtException", (e) => {
  const formatted = FormatError(e);
  if (formatted) {
    UI.error(formatted);
  }
});

// Use DEVVER_VERSION if defined (compiled binary), otherwise fall back to package.json
export const VERSION =
  typeof DEVVER_VERSION !== "undefined" ? DEVVER_VERSION : "0.0.2";

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
  .command(InitConfigCommand)
  .command(DeployCommand)
  .command(ProjectCommand)
  .command(SecretCommand)
  .command(OrganizationCommand)
  .command(RepositoryCommand)
  .usage(`\n${UI.logo()}`)
  .completion("completion", "generate shell completion script")
  .fail((msg, err) => {
    if (
      msg?.startsWith("Unknown argument") ||
      msg?.startsWith("Not enough non-option arguments") ||
      msg?.startsWith("Invalid values:")
    ) {
      if (err) {
        throw err;
      }
      cli.showHelp("log");
    }
    if (err) {
      throw err;
    }
    process.exit(1);
  })
  .strict();

try {
  await cli.parse();
} catch (e) {
  const formatted = FormatError(e);
  if (formatted) {
    UI.error(formatted);
  }
  process.exitCode = 1;
} finally {
  // Explicitly exit to avoid any hanging subprocesses.
  process.exit();
}
