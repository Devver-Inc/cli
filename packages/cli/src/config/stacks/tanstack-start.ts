import type { StackRule } from "./rule";

export const rule = {
  category: "meta",
  name: "tanstack-start",
  deps: ["@tanstack/react-start", "@tanstack/start"],
} as const satisfies StackRule;
