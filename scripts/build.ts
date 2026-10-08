#!/usr/bin/env bun

import { rmSync } from "node:fs";

import pkg from "../package.json";
import { buildDefines } from "./stamp";

const config: Bun.BuildConfig = {
  entrypoints: ["./packages/cli/src/cli/index.ts"],
  compile: { outfile: "devver" },
  define: buildDefines("standalone"),
};
const result = await Bun.build(config);

if (!result.success) {
  console.error("Build failed:");
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

// Archives contain only the server matching this CLI, not previous builds.
rmSync("servers", { recursive: true, force: true });
const server = await Bun.build({
  entrypoints: ["./packages/server/src/index.ts"],
  compile: {
    outfile: `servers/${pkg.version}/devver-server${process.platform === "win32" ? ".exe" : ""}`,
  },
});
if (!server.success) {
  console.error("Standalone server build failed:");
  for (const log of server.logs) {
    console.error(log);
  }
  process.exit(1);
}

console.log(
  `Built devver and servers/${pkg.version}/devver-server (version ${pkg.version})`
);
