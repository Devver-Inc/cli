import type { StackRule } from "./rule";

export const rule = {
  category: "vite",
  name: "vite",
  deps: ["vite"],
} as const satisfies StackRule;
