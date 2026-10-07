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
import { buildDefines } from "./stamp";

const outfile = "dist/cli.mjs";
const serverOutfile = `dist/servers/${pkg.version}/server.mjs`;

// Do not pack a server from a previous build/version alongside this one.
rmSync("dist", { recursive: true, force: true });

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

const server = await Bun.build({
  entrypoints: ["./src/server/index.ts"],
  outdir: `dist/servers/${pkg.version}`,
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

// Nightly stamps package.json after checkout; keep the npm bin pointing at
// the matching version's server before npm packs the manifest.
const manifest = JSON.parse(readFileSync("package.json", "utf8"));
if (manifest.bin?.["devver-server"] !== serverOutfile) {
  manifest.bin["devver-server"] = serverOutfile;
  writeFileSync("package.json", `${JSON.stringify(manifest, null, 2)}\n`);
}
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
if (lock.packages?.[""]?.bin?.["devver-server"] !== serverOutfile) {
  lock.packages[""].bin["devver-server"] = serverOutfile;
  writeFileSync("package-lock.json", `${JSON.stringify(lock, null, 2)}\n`);
}

console.log(
  `Built ${outfile} and ${serverOutfile} for Node (version ${pkg.version})`
);
