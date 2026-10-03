#!/usr/bin/env bun

/**
 * Builds the Node-targeted ESM entrypoint published to npm.
 *
 * Only this repository's sources are bundled: Node cannot resolve the
 * extensionless relative specifiers used across `src/`. Dependencies stay
 * external so npm installs them and packages with native assets (OpenTUI)
 * keep resolving their own files.
 */

import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import pkg from "../package.json";
import { buildDefines } from "./stamp";

const outfile = "dist/cli.mjs";

const result = await Bun.build({
  entrypoints: ["./src/cli/index.ts"],
  outdir: "dist",
  naming: { entry: "cli.mjs" },
  target: "node",
  format: "esm",
  packages: "external",
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

const shebang = "#!/usr/bin/env node\n";
const code = readFileSync(outfile, "utf-8");
if (!code.startsWith(shebang)) {
  writeFileSync(outfile, `${shebang}${code}`);
}
chmodSync(outfile, 0o755);

console.log(`Built ${outfile} for Node (version ${pkg.version})`);
