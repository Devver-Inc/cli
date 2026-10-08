import { recommended } from "@effect/tsgo/oxlint-presets";
import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";

export default defineConfig({
  extends: [core, antiSlop, recommended],
  ignorePatterns: [...(core.ignorePatterns ?? []), "repos/**", ".claude/**"],
  rules: {
    // Schema and request field order mirrors the API contract it describes.
    "sort-keys": "off",
    // `Effect.gen(function* () {})` takes an anonymous function expression.
    "func-style": "off",
    "func-names": "off",
    // Scoped teardown and sequential probes await deliberately inside loops.
    "no-await-in-loop": "off",
    "unicorn/no-await-expression-member": "off",
    // Node built-ins are imported by name (`import { join } from "node:path"`).
    "unicorn/import-style": "off",
    // The OAuth callback and loopback allocation wrap Node events in a Promise.
    "promise/avoid-new": "off",
    // `Effect.tryPromise(async () => existingPromise)` is the house style: the
    // async wrapper satisfies `promise-function-async` without a bare `await`.
    "require-await": "off",
    "typescript/return-await": "off",
    // `effect/cli` and `effect/http` are unstable by design and are the mandated
    // command/transport layer, so every call site would warn.
    "effecttsgo/unstable-api-usage": "off",
    // Optional results return an explicit `undefined`, which `consistent-return`
    // requires and which Effect APIs such as `Deferred<undefined>` take as a value.
    "unicorn/no-useless-undefined": "off",
    // An Effect module declares its service alongside the tagged errors it raises.
    "max-classes-per-file": "off",
  },
});
