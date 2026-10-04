# Devver CLI decisions

## Architecture
- Target: `src/cli/` owns the Effect v4 command tree and process entrypoint. Command handlers compose Effects and provide the API/auth layers at the edge; `src/api/` owns request schemas and HTTP transport, `src/auth/` owns Logto sessions, `src/config/` and `src/storage.ts` own persisted state.
- Target: `src/tui/` owns a separately testable, lazy-loaded OpenTUI React view. Its `run` is a scoped Effect; the CLI decides when to start it. Follow the CLI/TUI boundary in `../oss/opencode/packages/{cli,tui}`, not its broad monorepo framework.
- `src/cli/index.ts` is the sole CLI entrypoint; all command groups use `effect/cli`. `src/cmd/tui/` temporarily holds the lazy-imported React view until its scoped move to `src/tui/`. `src/cli/api.ts` supplies one scoped authenticated API layer per command (not per request).
- Auth runs on the main event loop with no worker and no RPC transport: `src/auth/session.ts` owns the Logto operations and a `serveCallback` OAuth loopback server (`node:http`) whose scope finalizer closes it, `src/auth/page.ts` the callback HTML, `src/auth/browser.ts` cross-platform browser opening. `serveCallback` takes the callback handler as an argument so the transport is testable without a provider. Subprocesses use `node:child_process` only, through `src/util/git/index.ts`.
- npm CLI: Node >=26.4 with no Bun installation, ESM, and automatic OpenTUI FFI startup. Standalone downloaded executables contain Bun and require neither Node nor Bun installed.
- `bin` points at the built `dist/cli.mjs`, never at `src/`: Node cannot resolve this repo's extensionless relative imports. `bun run build:npm` bundles only our sources (`packages: "external"`) with `splitting: true`, which is required so the lazily imported TUI stays in its own chunk; without splitting its `@opentui` imports hoist into the main chunk and every command fails at startup. `bun run build` produces the standalone Bun executable. `effect/cli` and `@effect/platform-node` supply command parsing, services, and the main runner; do not write a generic command framework.

## Types and trust
- Infer internal types; use `effect/cli` typed flags/arguments and Effect Schema to decode unknown values from HTTP, YAML/JSON, files, and other external inputs.
- Logto persists `logto/accessToken` as JSON but `logto/idToken` as a JWT whose payload carries top-level `organizations: string[]`. Decode the JWT payload; do not `JSON.parse` the ID token file, and do not expect a `claims` wrapper or organization objects. Test fixtures must use real JWTs.
- Do not use `as Type`, `any`, or TypeScript suppressions to make unverified data type-check. `as const` is fine. Narrow with a guard or validate at the boundary; don't silently substitute empty data when persisted secrets/configuration are corrupt. The only remaining cast is in `src/cmd/tui/helper.tsx`, which the TUI move replaces.
- Decoded schema types stay readonly; writers build a new object instead of mutating persisted state (`Schema.mutable` applies to arrays only in Effect v4).
- Keep existing Effect response schemas and use the shared `src/api/client.ts` transport. Provide layers to command Effects instead of repeatedly running them from within handlers.

## Reliability and security
- Never log tokens, passwords, or secret values. Credential decode failures report that the store is unusable without attaching the JSON syntax error or schema issue as a cause, because both render a fragment of the offending input. Store project secrets outside tracked files with owner-only permissions; never overwrite unreadable/corrupt secrets. Validate before writing or sending data.
- Errors must produce a nonzero exit status, cancellations must not masquerade as successful mutations, and resources (auth server, renderer, Effect scopes) must be cleaned up. Avoid `process.exit()` inside handlers/finalizers. Git/deploy checks fail closed if a subprocess result is unknown or unsuccessful.
- Unimplemented commands must say they are unsupported and fail; do not print a simulated success or wait forever.

## Release channels
- `main` is the stable/hotfix line; `develop` is the long-lived integration/nightly line. The scheduled/manual nightly workflow lives on default `main` and explicitly checks out `develop`. It publishes public opt-in `@devver/cli@nightly` and a GitHub `nightly-*` prerelease with standalone binaries for pinned mise CI installs; it must never tag `v*`, change npm `latest`, or update Homebrew. Forward-merge stable fixes to `develop`.

## Checks and updates
- Run non-mutating `bun run check`, `bun run typecheck`, and `bun test`; add the smallest runnable regression check for each nontrivial change. `tests/node-runtime.test.ts` bundles with `--target=node`, asserts the bundle contains no Bun API calls, and runs it under `node` with Bun absent from `PATH`; keep it passing as the guard against reintroducing Bun-only APIs in shared code. Test Node npm artifacts in a clean install without Bun and executable artifacts without either runtime before release.
- Update this document when an architectural or quality decision changes. Do not discard unrelated working-tree changes (including the Effect v4 migration). Never push commits or branches to the repository.
