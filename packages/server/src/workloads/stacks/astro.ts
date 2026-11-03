import type { LaunchRule } from "./rule";

export const launch = {
  script: /^astro dev(?: [\w./=-]+)*$/u,
  hostFlag: "--host",
  extraArgs: ["--ignore-lock"],
} as const satisfies LaunchRule;
