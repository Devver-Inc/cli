# Deep modules

Copy `example/` when adding a package:

```text
packages/<name>/
  index.ts          # small public entry point (other root files may also be entry points)
  lib/              # private implementation
  tests/            # tests and private fixtures
```

A package's **interface** lives at its root entry points; keep behaviour behind that seam. Import only through a package's entry points (its root files). Prefer several small entry points over a barrel re-exporting an entire subtree. Existing CLI and server implementations live in `src/` until they are reorganized; `src/` is private by the same rule.

Run `bun run lint:boundaries` (also part of `bun run check`). The four enforced rules are:

1. Outside code imports only a package's root entry points, never its subfolders.
2. Files within their own package import freely; crossing to another package uses its root entry points.
3. Package tests use their own and other packages' entry points, or their own `tests/` fixtures; they do not import internals.
4. Imports must not form dependency cycles.
