import type { LaunchRule } from "./rule";

export const launch = {
  script: /^vite(?: dev)?(?: [\w./=-]+)*$/u,
  hostFlag: "--host",
  extraArgs: [],
} as const satisfies LaunchRule;
