#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { Command } from "effect/cli";

import pkg from "../../../../package.json" with { type: "json" };
import { auth } from "./auth";
import { cloud } from "./cloud";
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
    cloud,
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
  NodeRuntime.runMain(
    Command.run(cli, { version: versionLine(pkg.version) }).pipe(
      // This is the process entry point, the one place layers are provided.
      // @effect-diagnostics-next-line strictEffectProvide:off
      Effect.provide(NodeServices.layer)
    )
  );
}
