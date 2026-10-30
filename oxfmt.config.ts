import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  // `repos/**` is vendored reference material; `.claude/` holds untracked local
  // agent settings that no contributor shares.
  ignorePatterns: [
    ...(ultracite.ignorePatterns ?? []),
    "repos/**",
    ".claude/**",
  ],
});
