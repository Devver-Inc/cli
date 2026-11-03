import { launch as astro } from "./astro";
import { launch as next } from "./next";
import { launch as nuxt } from "./nuxt";
import type { LaunchRule } from "./rule";
import { launch as vite } from "./vite";

const launchRules: readonly LaunchRule[] = [vite, next, astro, nuxt];

export function launchRuleFor(devScript: string): LaunchRule | undefined {
  return launchRules.find((rule) => rule.script.test(devScript));
}
