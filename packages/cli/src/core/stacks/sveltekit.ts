import type { StackRule } from "./rule";

export const rule = {
  category: "meta",
  name: "sveltekit",
  deps: ["@sveltejs/kit"],
} as const satisfies StackRule;
