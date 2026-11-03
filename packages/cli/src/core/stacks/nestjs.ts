import type { StackRule } from "./rule";

export const rule = {
  category: "backend",
  name: "nestjs",
  deps: ["@nestjs/core"],
} as const satisfies StackRule;
