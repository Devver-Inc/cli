# Devver CLI decisions

## Architecture

- Deep module entry points and import seams: read [packages/README.md](./packages/README.md) before adding or importing a package.
- Target: `packages/cli/src/cli/` owns the Effect v4 command tree and process entrypoint. Command handlers compose Effects and provide the API/auth layers at the edge; `packages/cli/src/domain/project.ts` owns pure project-setting validation, `packages/cli/src/api/` owns response schemas and HTTP transport, `packages/cli/src/auth/` owns Logto sessions, `packages/cli/src/config/` and `packages/cli/src/storage.ts` own persisted state.
- Target: `packages/cli/src/tui/` owns a separately testable, lazy-loaded OpenTUI React view. Its `run` is a scoped Effect; the CLI decides when to start it. Follow the CLI/TUI boundary in `../oss/opencode/packages/{cli,tui}`, not its broad monorepo framework.
- `packages/cli/src/cli/index.ts` is the sole CLI entrypoint; all command groups use `effect/cli`. `packages/cli/src/cmd/tui/` temporarily holds the lazy-imported React view until its scoped move to `packages/cli/src/tui/`. `packages/cli/src/cli/api.ts` supplies one scoped authenticated API layer per command (not per request).
- Auth runs on the main event loop with no worker and no RPC transport: `packages/cli/src/auth/session.ts` owns the Logto operations and a `serveCallback` OAuth loopback server (`node:http`) whose scope finalizer closes it, `packages/cli/src/auth/page.ts` the callback HTML, `packages/cli/src/auth/browser.ts` cross-platform browser opening. `serveCallback` takes the callback handler as an argument so the transport is testable without a provider. Subprocesses use `node:child_process` only, through `packages/cli/src/util/git/index.ts`.
- `packages/server/src/index.ts` is the separate foreground Effect server entrypoint (`<name> [port]`). Its scoped `node:http` listener owns transport only: the 127.0.0.1 bind, the duplicate-`Host`/`Origin`/`Sec-Fetch-Site` same-origin checks (which read `rawHeaders`, so no header abstraction may replace them) and the `/api/v1` prefix. Endpoints are declared in `packages/server/src/routes.ts`: adding one is a route entry plus a member of its `RouteResponse` union, and the path below the prefix must match exactly, so a query string, a trailing slash or an unprefixed path is a 404. `packages/server/src/identity.ts` keeps durable per-name identity under XDG data in POSIX owner-only `servers/` directories/files. Its shared `devver` data root is created 0700; existing CLI-created 0755 roots are accepted only if owned, non-symlinked and not group/other writable. Windows cannot use mode bits, so `packages/server/src/windows-acl.ts` keeps instance state under an owner-only `%LOCALAPPDATA%\devver` DACL applied at creation and rejects `XDG_DATA_HOME` overrides as untrusted.
- `devver new server` creates one supervised named instance and never attaches: `packages/cli/src/cli/new.ts` lazily imports `supervised-server-macos` (launchd `KeepAlive` on unsuccessful exit plus `ThrottleInterval=30`, which rate-bounds relaunch because launchd has no finite attempt cap), `supervised-server-linux` (`systemd-run --user` with a bounded `StartLimitBurst`), or `windows-supervised-server` (Task Scheduler with no trigger, so manual start only, plus a bounded `RestartCount`); any other platform gets one honest failure. `supervised-server-posix.ts` owns the owner-only server pinning and loopback port allocation both POSIX supervisors share. Windows runtime behavior is proven by the Windows CI job, not by local runs.
- npm CLI: Node >=26.4 with no Bun installation, ESM, and automatic OpenTUI FFI startup. Standalone downloaded executables contain Bun and require neither Node nor Bun installed.
- Workspace root `package.json` is the canonical release version. Run `bun run sync:version` after changing it to synchronize the CLI/server manifests, CLI server bin and both locks; `bun run check:version` fails on drift. Publish only `@devver/cli` via `npm publish --workspace @devver/cli`: the private root and source-only server workspace are not published. CI synchronizes release-please PR versions before checking and release jobs synchronize after stamping.
- `bin` points at the built `dist/cli.mjs`, never at `packages/cli/src/`: Node cannot resolve this repo's extensionless relative imports. `bun run build:npm` bundles workspace sources while externalizing CLI npm dependencies with `splitting: true`, which is required so the lazily imported TUI stays in its own chunk; without splitting its `@opentui` imports hoist into the main chunk and every command fails at startup. `bun run build` produces the standalone Bun executable. Both distributions ship a separate version-matched server offline: npm exposes `devver-server` at `dist/servers/<version>/server.mjs` (self-contained Node ESM, with server dependencies bundled so the pinned copy works outside `node_modules`), while standalone archives contain `devver` and `servers/<version>/devver-server` (or `.exe` on Windows). Homebrew installs the server at `bin/servers/<version>/devver-server`, sibling to its installed `bin/devver` executable, preserving the standalone relative lookup. #83 pins a packaged server copy in owner-only per-version installation before supervision; CLI upgrades must not silently replace the running instance binary. `effect/cli` and `@effect/platform-node` supply command parsing, services, and the main runner; do not write a generic command framework.
- When writing Effect code, inspect @repos/effect/ for examples of idiomatic usage, tests, module structure, and API design. Treat it as the source of truth for Effect patterns.

## Types and trust

- Infer internal types; use `effect/cli` typed flags/arguments and Effect Schema to decode unknown values from HTTP, YAML/JSON, files, and other external inputs.
- Logto persists `logto/accessToken` as JSON but `logto/idToken` as a JWT whose payload carries top-level `organizations: string[]`. Decode the JWT payload; do not `JSON.parse` the ID token file, and do not expect a `claims` wrapper or organization objects. Test fixtures must use real JWTs.
- Do not use `as Type`, `any`, or TypeScript suppressions to make unverified data type-check. `as const` is fine. Narrow with a guard or validate at the boundary; don't silently substitute empty data when persisted secrets/configuration are corrupt.
- Decoded schema types stay readonly; writers build a new object instead of mutating persisted state (`Schema.mutable` applies to arrays only in Effect v4).
- Keep existing Effect response schemas and use the shared `packages/cli/src/api/client.ts` transport. Provide layers to command Effects instead of repeatedly running them from within handlers.

## Reliability and security

- Never log tokens, passwords, or secret values. Credential decode failures report that the store is unusable without attaching the JSON syntax error or schema issue as a cause, because both render a fragment of the offending input. Store project secrets outside tracked files with owner-only permissions; never overwrite unreadable/corrupt secrets. Validate before writing or sending data.
- `NodeRuntime.runMain` renders the failure cause and sets the exit status; do not hand-roll an error formatter beside it. A message belongs on the error that raises it (`formatBackendError` builds `ApiError.message` from the backend code), and anything that needs a whole cause as text uses `Cause.pretty`/`Cause.prettyErrors`. Never stringify an arbitrary caught value into output: its properties can carry credentials.
- Errors must produce a nonzero exit status, cancellations must not masquerade as successful mutations, and resources (auth server, renderer, Effect scopes) must be cleaned up. Avoid `process.exit()` inside handlers/finalizers. Git/deploy checks fail closed if a subprocess result is unknown or unsuccessful.
- Unimplemented commands must say they are unsupported and fail; do not print a simulated success or wait forever.

## Release channels

- `main` is the stable/hotfix line; `develop` is the long-lived integration/nightly line. The scheduled/manual nightly workflow lives on default `main` and explicitly checks out `develop`. It publishes public opt-in `@devver/cli@nightly` and a GitHub `nightly-*` prerelease with standalone binaries for pinned mise CI installs; it must never tag `v*`, change npm `latest`, or update Homebrew. Forward-merge stable fixes to `develop`.

## Checks and updates

- `bun run check` and `bun run typecheck` are green with **zero errors and zero warnings**; keep them that way rather than letting warnings accumulate. The root `tsconfig.json` exists only for `tsc --noEmit`: `composite`/`declaration`/`declarationMap` were removed because nothing consumes declarations (both distributions are bundled by `scripts/build.ts` and `scripts/build-npm.ts`, there are no project references), and declaration emit rejected the idiomatic `return yield* new SomeTaggedError(...)` with TS4023 on Effect's `NodeInspectSymbol`. Every type-checking option stays on, including `noUncheckedIndexedAccess`: an indexed read is `T | undefined` until a guard or a default narrows it.
- Prefer removing a lint finding's cause over suppressing it: shared helpers (`packages/cli/src/util/fs-errors.ts`, `packages/cli/src/util/exec.ts`, `packages/server/src/fs-errors.ts`) hold the Node `EEXIST` check and the promisified `execFile` once each instead of repeating a suppression per supervisor. A rule that conflicts with another enabled rule or with a mandated API is turned off once in `oxlint.config.ts`/`tsconfig.json` with its reason (`unicorn/no-useless-undefined` versus `consistent-return`, `max-classes-per-file` versus an Effect module's service plus tagged errors, `unstableApiUsage` for the mandated `effect/cli` and `effect/http`). An inline `oxlint-disable-next-line` must name the boundary it guards; a runtime shape check belongs in a named `x is T` predicate, which the rule accepts without any suppression. Three `@effect-diagnostics-next-line` comments are intended: `strictEffectProvide:off` at the process entry point and at the per-command API layer, and `returnEffectInGen:off` where `serveCallback` returns the completion Effect so `login` can open the browser before awaiting it.
- Run non-mutating `bun run check`, `bun run typecheck`, and `bun test`; add the smallest runnable regression check for each nontrivial change. `tests/node-runtime.test.ts` bundles with `--target=node`, asserts the bundle contains no Bun API calls, and runs it under `node` with Bun absent from `PATH`; keep it passing as the guard against reintroducing Bun-only APIs in shared code. Test Node npm artifacts in a clean install without Bun and executable artifacts without either runtime before release.
- Windows instance state is the one case the full matrix cannot cover: it lives in the real per-user `%LOCALAPPDATA%` and an `XDG_DATA_HOME` override fails closed by design, so a test that creates it depends on what else touched that root and under which identity. The `windows-server` CI job is that isolation and sets `DEVVER_WINDOWS_STATE_TESTS=1`; without it those checks skip. Never relax the Windows ACL or supervision assertions to make the shared-state run pass. PowerShell helpers use .NET types (`GetAccessControl`, `Directory.CreateDirectory`) rather than `Get-Acl`/`Set-Acl`, whose module autoload fails on some runners, and they index parsed JSON by position because PowerShell 5.1 writes an array as one non-enumerated item.
- Release artifacts, not sources, prove the create/attach/switch/status/detach path: `tests/standalone-server-cli.test.ts` drives the built `devver` and its packaged server with neither Node nor Bun on `PATH`, and `tests/create-server-macos-cli.test.ts` runs `dist/cli.mjs` with Bun absent. Every such test creates instances through `devver new server` itself, including on Windows, where only the attach-time `XDG_DATA_HOME` is isolated: creation never reads the CLI config, so its instance state still resolves from `%LOCALAPPDATA%`.
- Update this document when an architectural or quality decision changes. Do not discard unrelated working-tree changes (including the Effect v4 migration). Never push commits or branches to the repository.

## Vendored Repositories

This project vendors external repositories under @repos/

- Use vendored repositories as read-only reference material when working with related libraries
- Prefer examples and patterns from the vendored source code over generated guesses or web search results
- Do not edit files under @repos/ unless explicitly asked
- Do not import from @repos/ - application code should continue importing from normal package dependencies

# Ultracite Code Standards

This project uses **Ultracite**, a zero-config preset that enforces strict code quality standards through automated formatting and linting.

## Quick Reference

- **Format code**: `npx ultracite fix`
- **Check for issues**: `npx ultracite check`
- **Diagnose setup**: `npx ultracite doctor`

Oxlint + Oxfmt (the underlying engine) provides robust linting and formatting. Most issues are automatically fixable.

---

## Core Principles

Write code that is **accessible, performant, type-safe, and maintainable**. Focus on clarity and explicit intent over brevity.

### Type Safety & Explicitness

- Use explicit types for function parameters and return values when they enhance clarity
- Prefer `unknown` over `any` when the type is genuinely unknown
- Use const assertions (`as const`) for immutable values and literal types
- Leverage TypeScript's type narrowing instead of type assertions
- Use meaningful variable names instead of magic numbers - extract constants with descriptive names

### Modern JavaScript/TypeScript

- Use arrow functions for callbacks and short functions
- Prefer `for...of` loops over `.forEach()` and indexed `for` loops
- Use optional chaining (`?.`) and nullish coalescing (`??`) for safer property access
- Prefer template literals over string concatenation
- Use destructuring for object and array assignments
- Use `const` by default, `let` only when reassignment is needed, never `var`

### Async & Promises

- Always `await` promises in async functions - don't forget to use the return value
- Use `async/await` syntax instead of promise chains for better readability
- Handle errors appropriately in async code with try-catch blocks
- Don't use async functions as Promise executors

### React & JSX

- Use function components over class components
- Call hooks at the top level only, never conditionally
- Specify all dependencies in hook dependency arrays correctly
- Use the `key` prop for elements in iterables (prefer unique IDs over array indices)
- Nest children between opening and closing tags instead of passing as props
- Don't define components inside other components
- Use semantic HTML and ARIA attributes for accessibility:
  - Provide meaningful alt text for images
  - Use proper heading hierarchy
  - Add labels for form inputs
  - Include keyboard event handlers alongside mouse events
  - Use semantic elements (`<button>`, `<nav>`, etc.) instead of divs with roles

### Error Handling & Debugging

- Remove `console.log`, `debugger`, and `alert` statements from production code
- Throw `Error` objects with descriptive messages, not strings or other values
- Use `try-catch` blocks meaningfully - don't catch errors just to rethrow them
- Prefer early returns over nested conditionals for error cases

### Code Organization

- Keep functions focused and under reasonable cognitive complexity limits
- Extract complex conditions into well-named boolean variables
- Use early returns to reduce nesting
- Prefer simple conditionals over nested ternary operators
- Group related code together and separate concerns

### Security

- Add `rel="noopener"` when using `target="_blank"` on links
- Avoid `dangerouslySetInnerHTML` unless absolutely necessary
- Don't use `eval()` or assign directly to `document.cookie`
- Validate and sanitize user input

### Performance

- Avoid spread syntax in accumulators within loops
- Use top-level regex literals instead of creating them in loops
- Prefer specific imports over namespace imports
- Avoid barrel files (index files that re-export everything)
- Use proper image components (e.g., Next.js `<Image>`) over `<img>` tags

### Framework-Specific Guidance

**Next.js:**

- Use Next.js `<Image>` component for images
- Use `next/head` or App Router metadata API for head elements
- Use Server Components for async data fetching instead of async Client Components

**React 19+:**

- Use ref as a prop instead of `React.forwardRef`

**Solid/Svelte/Vue/Qwik:**

- Use `class` and `for` attributes (not `className` or `htmlFor`)

---

## Testing

- Write assertions inside `it()` or `test()` blocks
- Avoid done callbacks in async tests - use async/await instead
- Don't use `.only` or `.skip` in committed code
- Keep test suites reasonably flat - avoid excessive `describe` nesting

## When Oxlint + Oxfmt Can't Help

Oxlint + Oxfmt will catch most mechanical issues automatically. Focus your attention on:

1. **Business logic correctness** - Oxlint + Oxfmt can't validate your algorithms
2. **Meaningful naming** - Use descriptive names for functions, variables, and types
3. **Architecture decisions** - Component structure, data flow, and API design
4. **Edge cases** - Handle boundary conditions and error states
5. **User experience** - Accessibility, performance, and usability considerations
6. **Documentation** - Add comments for complex logic, but prefer self-documenting code

---

Most formatting and common issues are automatically fixed by Oxlint + Oxfmt. Run `npx ultracite fix` before committing to ensure compliance.
