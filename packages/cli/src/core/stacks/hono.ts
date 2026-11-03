import type { StackRule } from "./rule";

export const rule = {
  category: "backend",
  name: "hono",
  deps: ["hono"],
} as const satisfies StackRule;
