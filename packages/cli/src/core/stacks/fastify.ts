import type { StackRule } from "./rule";

export const rule = {
  category: "backend",
  name: "fastify",
  deps: ["fastify"],
} as const satisfies StackRule;
