#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { Command } from "effect/cli";
import pkg from "../../package.json" with { type: "json" };
import { auth } from "./auth";
import { config, init } from "./config";
import { deploy } from "./deploy";
import { attach, detach, server } from "./local-server";
import { newCommand } from "./new";
import { organization } from "./organization";
import { project } from "./project";
import { repos } from "./repos";
import { root } from "./root";
import { secret } from "./secret";
import { tui } from "./tui";
import { versionLine } from "./version";

export const cli = root.pipe(
  Command.withSubcommands([
    attach,
    auth,
    config,
    deploy,
    detach,
    init,
    newCommand,
    organization,
    project,
    repos,
    secret,
    server,
    tui,
  ])
);

if (import.meta.main) {
  Command.run(cli, { version: versionLine(pkg.version) }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain
  );
}
