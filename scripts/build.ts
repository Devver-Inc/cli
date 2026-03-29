#!/usr/bin/env bun

/**
 * Build script for devver-cli
 * Compiles the CLI with bundled worker support
 */

const workerPath = "./src/auth/worker.ts";

const result = await Bun.build({
  entrypoints: ["./src/index.tsx", workerPath],
  compile: {
    outfile: "devver-cli",
  },
  define: {
    DEVVER_WORKER_PATH: `"${workerPath}"`,
  },
});

if (!result.success) {
  console.error("Build failed:");
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

console.log("Build successful!");
