import os from "node:os";
import path from "node:path";
import fs from "fs/promises";
import { xdgCache, xdgConfig, xdgData, xdgState } from "xdg-basedir";

const app = "devver";

const data = path.join(xdgData!, app);
const cache = path.join(xdgCache!, app);
const config = path.join(xdgConfig!, app);
const state = path.join(xdgState!, app);

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
