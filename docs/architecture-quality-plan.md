# Architecture and quality migration

## Goal and invariants

Keep the existing Effect v4 command tree, one authenticated `ApiClient` Layer per command, scoped OAuth callback, separately built local server, and lazy TUI. Improve _deep modules_, not the number of interfaces: each module should own validation, decisions, and its error modes behind a small interface. Follow `packages/README.md` and `repos/effect/LLMS.md`; do not import vendored source or expose secret values in errors. A new port needs a real substitute (usually a test adapter), not just a single implementation wrapped in `Context.Service`.

## Seams

| Seam | Owns | Outside the seam |
| --- | --- | --- |
| `packages/cli/src/domain/project.ts` | Pure project-setting constraints and sanitized input validation | CLI flags, HTTP transport, persisted credentials |
| `packages/cli/src/api/` | Decode HTTP responses, validate outgoing DTOs through the domain, typed transport errors | CLI prompts, persisted credentials |
| `packages/cli/src/auth/` and `config/` | Decode JWT/file/YAML/JSON unknowns, protect secrets and store state | Command presentation |
| `packages/cli/src/cli/` | Select target, acquire auth Layer once, interpret typed outcomes | Request schema and HTTP implementation |
| `packages/server/src/` | Owner-only identity state, supervised runtime and loopback listener | CLI/cloud transport; no merged process |
| `packages/cli/src/tui/` (planned move) | Scoped renderer/view | CLI command parsing or persistent state |

The **core domain** begins with project settings; repository selection and deployment preflight are candidates for later pure Schemas/decisions that need neither Node, HTTP nor CLI types. Keep it private to the owning package until more than one package needs it; then move the shared contract behind a package entry point. CLI commands and server/HTTP code are adapters at that seam, not a reason to build a generic ports framework.

## Vertical slices

1. **Project creation (in progress):** `domain/project.ts` owns the shared project settings, `CreateProjectSchema` (including finite database resources), and sanitized `InvalidProjectInput`. The API adapter validates before `ApiClient.post`; CLI flags use domain constants without importing HTTP schemas. A CLI integration test proves invalid names send zero requests; a domain regression rejects infinite database resources without exposing `rootPassword` and preserves omission of an absent description. Finish with cancellation-before-mutation checks.
2. **Version/manifest trust (started):** `scripts/sync-version.ts` decodes required manifest/lock fields with Effect Schema before comparing or writing, preserves unrelated manifest keys, and constructs new objects rather than mutating decoded readonly data. A malformed-manifest check proves `--check` never writes. `tests/workspaces.test.ts` also decodes the manifest fields used in its assertions.
3. **Local identity contract:** compare `packages/server/src/index.ts` response with `packages/cli/src/cli/local-server.ts` decoder. If they drift, expose one schema through a package root entry point, without crossing private `src/` boundaries or merging runtimes.
4. **Deploy decisions:** extract only the first independently testable preflight/decision from `cli/deploy.ts`; preserve check-before-push ordering and cancellation. Avoid blanket ports for filesystem, Logto, git, or TUI until production and test adapters actually use a seam.

## Quality gates

- `bun run typecheck` must remain strict: Effect errors fail; warnings remain visible. Do not suppress type/unsafe findings to make lint pass.
- `bun run check` passes without linting vendored `repos/`, with zero errors and zero warnings; keep it green. Effect diagnostics are enforced: tagged errors are raised as `return yield* new SomeError(...)`, `Schema.Finite` replaces `Schema.Number` for finite domains, service keys are deterministic (`@devver/cli/api/client/*`), and the auth callback forks with the surrounding services through `Effect.runForkWith`. Decode unknown JSON/HTTP/fixture inputs at their owner boundaries. Disable a rule only for a demonstrated incompatibility with Effect/Node semantics, document why, and keep runtime validations.
- `bun test` and `bun run lint:boundaries` remain green; add one focused regression check per nontrivial slice. Windows state/supervision requires the isolated Windows CI gate.
- Never run a repo-wide mutating fixer without inspecting its proposed effect; past autofixes changed `Effect.succeed(undefined)` and `FormatError(reason)` incorrectly. Preserve unrelated working-tree changes and do not edit `repos/effect/`.
