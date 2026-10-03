#!/usr/bin/env bun

/**
 * Build script for devver
 */

import pkg from "../package.json";
import { buildDefines } from "./stamp";

const config: Bun.BuildConfig = {
  entrypoints: ["./src/cli/index.ts"],
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

console.log(`Build successful! Version: ${pkg.version}`);
