#!/usr/bin/env bun

/**
 * Build script for devver-cli
 * Compiles the CLI with bundled worker support
 */

import pkg from "../package.json";

const workerPath = "./src/auth/worker.ts";

const result = await Bun.build({
  entrypoints: ["./src/index.tsx", workerPath],
  compile: {
    outfile: "devver-cli",
  },
  define: {
    // In the compiled binary, the worker entrypoint is at auth/worker.js
    // relative to the main entrypoint (index.js) inside $bunfs/root/
    DEVVER_WORKER_PATH: JSON.stringify("./auth/worker.js"),
    DEVVER_VERSION: JSON.stringify(pkg.version),
  },
});

if (!result.success) {
  console.error("Build failed:");
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

console.log(`Build successful! Version: ${pkg.version}`);
