/**
 * Creates one supervised Windows instance and exits, so a test in another
 * process can prove the server stays reachable after its creator is gone.
 *
 * Bundled into `dist/` so that the packaged-server lookup resolves exactly as
 * the installed npm CLI chunk does.
 */

import { create } from "../../src/cli/windows-supervised-server";

const [name, ...extra] = process.argv.slice(2);
if (!name || extra.length > 0) {
  throw new Error("Usage: windows-create-driver <name>");
}
process.stdout.write(`${await create(name)}\n`);
