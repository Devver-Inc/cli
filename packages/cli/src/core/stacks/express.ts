import type { StackRule } from "./rule";

export const rule = {
  category: "backend",
  name: "express",
  deps: ["express"],
} as const satisfies StackRule;
