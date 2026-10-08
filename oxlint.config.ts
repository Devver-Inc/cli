import { recommended } from "@effect/tsgo/oxlint-presets";
import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";

export default defineConfig({
  extends: [core, antiSlop, recommended],
  ignorePatterns: [...(core.ignorePatterns ?? []), "repos/**"],
  rules: {
    // Object field order and function declarations carry meaning in Schema and Effect code.
    "sort-keys": "off",
    "func-style": "off",
    "func-names": "off",
    // Effect callbacks and server teardown deliberately serialize asynchronous work.
    "no-await-in-loop": "off",
    "unicorn/no-await-expression-member": "off",
    "unicorn/import-style": "off",
    "promise/avoid-new": "off",
    // `promise-function-async` requires async callbacks even when they return an existing Promise.
    "require-await": "off",
    "typescript/return-await": "off",
  },
});
