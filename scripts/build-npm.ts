#!/usr/bin/env bun

/**
 * Build script for the npm package.
 *
 * Bundles the CLI (and its auth worker) into `dist/` as Bun-runnable
 * JavaScript. The published package requires the Bun runtime at execution
 * time (the `bin` shebang is `#!/usr/bin/env bun`).
 */

import pkg from "../package.json";

const result = await Bun.build({
  entrypoints: ["./src/index.tsx", "./src/auth/worker.ts"],
  outdir: "./dist",
  target: "bun",
  define: {
    // The worker is emitted at `dist/auth/worker.js` (Bun preserves the
    // src-relative path), resolved relative to `dist/index.js` via
    // import.meta.url.
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

console.log(`npm build successful! Version: ${pkg.version}`);
for (const output of result.outputs) {
  console.log(`  ${output.path}`);
}
