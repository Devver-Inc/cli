import type { StackRule } from "./rule";

export const rule = {
  category: "meta",
  name: "remix",
  deps: ["@remix-run/react"],
} as const satisfies StackRule;
