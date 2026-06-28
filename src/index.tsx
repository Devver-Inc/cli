#!/usr/bin/env -S bun run
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import pkg from "../package.json" with { type: "json" };
import { AuthCommand } from "./cmd/auth";
import { ConfigCommand } from "./cmd/config";
import { DeployCommand } from "./cmd/deploy";
import { OrganizationCommand } from "./cmd/organization";
import { ProjectCommand } from "./cmd/project";
import { RepositoryCommand } from "./cmd/repos";
import { SecretCommand } from "./cmd/secret";
import { TuiCommand } from "./cmd/tui/tui";
import { FormatError } from "./error";
import { UI } from "./ui";
import { setExplicitApiUrl } from "./util/runtime";

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
  typeof DEVVER_VERSION !== "undefined" ? DEVVER_VERSION : pkg.version;

const cli = yargs(hideBin(process.argv))
  .parserConfiguration({ "populate--": true })
  .scriptName("devver")
  .wrap(100)
  .help("help", "show help")
  .alias("help", "h")
  .version("version", "show version number", VERSION)
  .alias("version", "v")
  .option("api-url", {
    describe:
      "Override the API base URL (useful for self-hosted or local development)",
    type: "string",
  })
  .middleware((opts) => {
    if (typeof opts["api-url"] === "string") {
      setExplicitApiUrl(opts["api-url"]);
    }
  })
  .command(TuiCommand)
  .command(AuthCommand)
  .command(ConfigCommand)
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
  const data: Record<string, unknown> = {};

  if (e instanceof Error) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      cause: e.cause?.toString(),
      stack: e.stack,
    });
  }

  if (e instanceof ResolveMessage) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      code: e.code,
      specifier: e.referrer,
      position: e.position,
      importKind: e.importKind,
    });
  }
  console.error("fatal", data);
  const formatted = FormatError(e);
  if (formatted) {
    UI.error(formatted);
  }
  process.exitCode = 1;
} finally {
  // Explicitly exit to avoid any hanging subprocesses.
  process.exit();
}
