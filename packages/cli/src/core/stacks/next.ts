import type { StackRule } from "./rule";

export const rule = {
  category: "meta",
  name: "next",
  deps: ["next"],
} as const satisfies StackRule;
