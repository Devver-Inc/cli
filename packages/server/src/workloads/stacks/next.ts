import type { LaunchRule } from "./rule";

export const launch = {
  script: /^next dev(?: [\w./=-]+)*$/u,
  hostFlag: "--hostname",
  extraArgs: [],
} as const satisfies LaunchRule;
