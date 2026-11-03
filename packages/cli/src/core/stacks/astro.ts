import type { StackRule } from "./rule";

export const rule = {
  category: "meta",
  name: "astro",
  deps: ["astro"],
} as const satisfies StackRule;
