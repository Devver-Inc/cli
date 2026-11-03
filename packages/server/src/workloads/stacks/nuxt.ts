import type { LaunchRule } from "./rule";

export const launch = {
  script: /^nuxt dev(?: [\w./=-]+)*$/u,
  hostFlag: "--host",
  extraArgs: [],
} as const satisfies LaunchRule;
