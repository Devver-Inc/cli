#!/usr/bin/env bun

/**
 * Builds the Node-targeted ESM entrypoint published to npm.
 *
 * Only this repository's sources are bundled: Node cannot resolve the
 * extensionless relative specifiers used across `src/`. Dependencies stay
 * external so npm installs them and packages with native assets (OpenTUI)
 * keep resolving their own files.
 */

import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import pkg from "../package.json";
import cli from "../packages/cli/package.json";
import { buildDefines } from "./stamp";

const outfile = "packages/cli/dist/cli.mjs";
const serverOutfile = `packages/cli/dist/servers/${pkg.version}/server.mjs`;

// Do not pack a server from a previous build/version alongside this one.
rmSync("packages/cli/dist", { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: ["./packages/cli/src/cli/index.ts"],
  outdir: "packages/cli/dist",
  naming: { entry: "cli.mjs" },
  target: "node",
  format: "esm",
  external: Object.keys(cli.dependencies),
  splitting: true,
  define: buildDefines("npm"),
});

if (!result.success) {
  console.error("npm build failed:");
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

const server = await Bun.build({
  entrypoints: ["./packages/server/src/index.ts"],
  outdir: `packages/cli/dist/servers/${pkg.version}`,
  naming: { entry: "server.mjs" },
  target: "node",
  format: "esm",
  // The pinned copy runs outside node_modules and must retain its dependencies offline.
  packages: "bundle",
});
if (!server.success) {
  console.error("npm server build failed:");
  for (const log of server.logs) {
    console.error(log);
  }
  process.exit(1);
}

const shebang = "#!/usr/bin/env node\n";
for (const file of [outfile, serverOutfile]) {
  const code = readFileSync(file, "utf-8");
  if (!code.startsWith(shebang)) {
    writeFileSync(file, `${shebang}${code}`);
  }
  chmodSync(file, 0o755);
}

console.log(
  `Built ${outfile} and ${serverOutfile} for Node (version ${pkg.version})`
);
