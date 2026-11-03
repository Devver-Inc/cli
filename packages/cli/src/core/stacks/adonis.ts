import type { StackRule } from "./rule";

export const rule = {
  category: "backend",
  name: "adonis",
  deps: ["@adonisjs/core"],
} as const satisfies StackRule;
