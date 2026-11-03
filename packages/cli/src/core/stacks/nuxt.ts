import type { StackRule } from "./rule";

export const rule = {
  category: "meta",
  name: "nuxt",
  deps: ["nuxt"],
} as const satisfies StackRule;
