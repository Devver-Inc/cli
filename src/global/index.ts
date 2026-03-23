/**
 * XDG base directory paths for all persisted CLI data.
 * Top-level await ensures dirs exist before any Storage call.
 */
import os from "node:os";
import path from "node:path";
import { xdgCache, xdgConfig, xdgData, xdgState } from "xdg-basedir";

const app = "devver";

const data = path.join(xdgData ?? os.homedir(), app);
const cache = path.join(xdgCache ?? os.homedir(), app);
const config = path.join(xdgConfig ?? os.homedir(), app);
const state = path.join(xdgState ?? os.homedir(), app);

const Path = {
  get home() {
    return process.env.DEVVER_TEST_HOME || os.homedir();
  },
  data,
  bin: path.join(data, "bin"),
  log: path.join(data, "log"),
  cache,
  config,
  state,
};

export const Global = { Path };

await Promise.all([
  fs.mkdir(Global.Path.data, { recursive: true }),
  fs.mkdir(Global.Path.config, { recursive: true }),
  fs.mkdir(Global.Path.state, { recursive: true }),
  fs.mkdir(Global.Path.log, { recursive: true }),
  fs.mkdir(Global.Path.bin, { recursive: true }),
]);
