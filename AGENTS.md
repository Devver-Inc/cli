Do not write comments unless they are any of:

- absolutely necessary to explain some very complex business logic (in which case, keep it concise and clear)
- used as an input for tools to read and act on.
- a lint or type checker suppression when introducing a truly unavoidable violation
- a TODO or FIXME
  - Not great to have those, but if it's unavoidable, make sure to include a strong, concise reason for why it's there or, better yet, link to a GitHub issue for the follow-up work

Explanation: The point of this rule is to keep out AI slop comments. AI writes way too many and way too verbose comments. Code comments are, in a way, a violation of DRY code. You must update logic in two locations to change the code, and "hard to change" is literally the definition of tech debt. We should instead aim to write code that is intuitive and clear, even at a glance, to the reader, being both easy to maintain and high performance

Don't assume that the existing code is correct or the right way of doing things / good coding patterns. In fact, there are a lot of bad coding practices, overly complex code, code smells, etc. If something doesn't look right, speak up. Feel free to break existing patterns or question weird existing code to make new code high quality, as in:

- correct
- secure
- performant
- readable
- easy to maintain/change
- modern

In descending order of importance

# Devver CLI decisions

## Architecture

- Read [ARCHITECTURE.md](./ARCHITECTURE.md) for how the system fits together; this file holds the rules that govern changing it.
- Deep module entry points and import seams: read [packages/README.md](./packages/README.md) before adding or importing a package.
- Target: `packages/cli/src/cli/` owns the Effect v4 command tree and process entrypoint. Command handlers compose Effects and provide the API/auth layers at the edge; `packages/cli/src/domain/project.ts` owns pure project-setting validation, `packages/cli/src/api/` owns response schemas and HTTP transport, `packages/cli/src/auth/` owns Logto sessions, `packages/cli/src/config/` and `packages/cli/src/storage.ts` own persisted state.
- Target: `packages/cli/src/tui/` owns a separately testable, lazy-loaded OpenTUI React view. Its `run` is a scoped Effect; the CLI decides when to start it. Follow the CLI/TUI boundary in `../oss/opencode/packages/{cli,tui}`, not its broad monorepo framework.
- Inside `packages/cli/src/tui/`, folders name the concern instead of a component taxonomy: `graph/` holds the React-free lane and focus math, `components/` holds presentation that takes props and owns no application state, and the root holds the views and their state (`app.tsx`), the renderer entry (`index.tsx`), the view's input contract (`target.ts`), row shaping (`deployments.ts`), keys and theme. A component file keeps its own hook beside it (`components/organization-picker.tsx`); no barrel re-exports a folder. Atomic-design layers (atoms/molecules/organisms) are deliberately not used: one screen with three views does not have enough shared primitives to fill them.
- `packages/cli/src/cli/index.ts` is the sole CLI entrypoint; all command groups use `effect/cli`. `packages/cli/src/tui/` holds the lazy-imported React view and its scoped renderer; organization/project data and mutations are supplied by the CLI only for a selected cloud target. The TUI receives a discriminated cloud/local/none presentation target; local shows its attached instance and invocation workspace without Logto or cloud selectors, and loads deployment statuses from that server. It shows only deployments matching the SHA-256 of the canonical Git checkout root when available; non-Git workspaces show all server deployments without claiming a match. The listing draws one lane per deployment, where an ordinary child continues its parent's lane and retains primary-parent label indentation while each merged deployment takes two connector lanes (after both visible parents); `1`/`2` navigate its parents. Selection pulls focus rather than opening a second view: `packages/cli/src/tui/graph/focus.ts` owns the lineage closure and its per-hop falloff, `graph/deployment-graph.ts` returns one cell per character so each stroke names the lineage that owns it, and `theme.ts` owns the palette, the terminal surface and the fade toward the background tier. The selected row's lineage solidifies and brightens hop by hop over ~260ms while unrelated lanes stay dashed and dim; failed and degraded deployments keep a brightness floor so they never recede; the selected row expands in place with its parents, URL and children; and a selected merge labels its parents `①`/`②`, which reciprocally shows `⋈ merged here` on the merge when a parent is selected. A row is named by its display name, else its commit subject, else the commit SHA; the lane glyph carries a ready deployment, so only an unfinished or broken one spells out its status and stage. Two deployments of one commit read alike on purpose: renaming one is how they are told apart, and the deployment id never appears in a row. A lane bar stops at the last child instead of trailing past it. `DEVVER_REDUCED_MOTION` disables the travelling highlight, and tests set it to keep frames deterministic. In local TUI, `v` toggles two ready deployments of the same repository and `m` explicitly merges them, and `d` opens a floating detail panel (absolute position over the list, on the shared palette) carrying the id, revision, subject, creation time, how the deployment came to be, status, URL and repository ID hash; the footer keeps two short lines so every key stays readable at 80 columns. Deployment URLs open in a browser. Older servers without the listing endpoint show unavailable, not empty; no target stays unselected. `packages/cli/src/cli/api.ts` supplies one scoped authenticated API layer per command (not per request). `devver cloud` selects the official `https://app.devver.app/api/v1` without probing it or changing local-server identity rules; `attach` switches to a verified local target, `detach` clears either selection, and legacy stored `api-url` remains inactive.
- Auth runs on the main event loop with no worker and no RPC transport: `packages/cli/src/auth/session.ts` owns the Logto operations and a `serveCallback` OAuth loopback server (`node:http`) whose scope finalizer closes it, `packages/cli/src/auth/page.ts` the callback HTML, `packages/cli/src/auth/browser.ts` cross-platform browser opening. `serveCallback` takes the callback handler as an argument so the transport is testable without a provider. CLI Git subprocesses use `node:child_process` through `packages/cli/src/util/git/index.ts`; server Git and Pitchfork subprocesses live in `packages/server/src/{git-source,deployment-host}.ts`.
- `packages/server/src/index.ts` is the separate foreground Effect server entrypoint (`<name> [port]`). It acquires the deployer in the listener's Effect scope so cancellation withdraws active deployments and closes its store. Its scoped `NodeHttpServer` listener binds to 127.0.0.1; `packages/server/src/deployment-store.ts` uses scoped Effect SQL with matching Node/Bun SQLite drivers, owner-only files, and WAL disabled to preserve existing database behavior. Server builds define `DEVVER_NODE_SQLITE` and externalize the other runtime's driver so offline artifacts bundle only their own built-in SQLite. `packages/server/src/api.ts` declares the Effect `HttpApi` endpoints and response schemas, and `handlers.ts` implements them. The server entrypoint retains the duplicate-`Host`/`Origin` and `Sec-Fetch-Site` same-origin checks on the raw Node request, before routing, and preserves exact-path and 405 behavior for the identity endpoint. `packages/server/src/identity.ts` keeps durable per-name identity under XDG data in POSIX owner-only `servers/` directories/files. Its shared `devver` data root is created 0700; existing CLI-created 0755 roots are accepted only if owned, non-symlinked and not group/other writable. Windows cannot use mode bits, so `packages/server/src/windows-acl.ts` keeps instance state under an owner-only `%LOCALAPPDATA%\devver` DACL applied at creation and rejects `XDG_DATA_HOME` overrides as untrusted.
- Local deployments share one Pitchfork supervisor and loopback HTTP proxy per instance in `packages/server/src/deployment-host.ts`. Register the generated manifest as a project in the instance's isolated Pitchfork config so native `<daemon>.<project>.localhost` hostnames route without legacy slugs. Keep Pitchfork's daemon `dir` at the instance and change to each workload's directory in the generated run command: bare-repository worktrees are separate checkouts to Pitchfork, so setting daemon `dir` to a worktree makes the instance hostname fail its checkout guard. The host accepts workload-neutral `{ command, dir, port }`, and `reserve` allocates each daemon a loopback port and an owner-only `daemons/<deploymentId>/` config directory, which `withdraw` and `close` remove; the manifest pins that exact port with `bump = false` because Ferron's KDL config accepts only a literal port. Readiness is a real request to the printed URL. Once persisted, the proxy port cannot change on restart: an occupied port fails startup rather than invalidating previously printed URLs. `GET /api/v1/deployments` exposes non-secret deployment statuses so `devver server status` can report degraded deployments; same-version older servers without that endpoint report status as unavailable. Each status also carries the commit subject, resolved from the instance's own bare repository so merge commits are named too, and the recorded creation time; both are optional on the CLI side, and an unknown or unreadable revision simply goes unnamed rather than failing the listing. An ordinary `deploy` links to the nearest ready deployment of the same repository on the new commit's first-parent Git history, excluding the new commit itself; with no such ancestor it creates a root (`parentDeploymentId: null`). This is determined before recording, leaves existing links untouched, and keeps `secondParentDeploymentId: null`; only an explicit merge establishes two parents. Merging requires Git 2.38 or newer for `merge-tree --write-tree`; older Git fails with a version requirement rather than a false conflict. A merge from two ready deployments of the same repository creates a new Git merge commit in the server-owned bare repository, a new deployment with both lineage parents and URL, and never changes either source or the user's checkout. Conflicts, identical revisions, and unrelated histories create no deployment; older stored deployments gain a nullable second parent during migration.
- `devver new server` creates one supervised named instance and attaches to it, printing the ready URL: `packages/cli/src/cli/new.ts` lazily imports `supervised-server-macos` (launchd `KeepAlive` on unsuccessful exit plus `ThrottleInterval=30`, which rate-bounds relaunch because launchd has no finite attempt cap), `supervised-server-linux` (`systemd-run --user` with a bounded `StartLimitBurst`), or `windows-supervised-server` (Task Scheduler with no trigger, so manual start only, plus a bounded `RestartCount`); any other platform gets one honest failure. `supervised-server-posix.ts` owns the owner-only server pinning and loopback port allocation both POSIX supervisors share, and `attachTarget` in `local-server.ts` is the shared verified attach both `new server` and `devver attach` use. Windows supervisor code remains in source, but Windows CI and standalone publishing are paused until runtime verification; macOS and Linux remain enabled.
- npm needs Node to install the package, but its commands are native Bun-compiled executables that need neither Node nor Bun at runtime. One tarball carrying both POSIX targets reached 224.8 MB packed and 492.1 MB unpacked, which npm rejected with `413 Payload Too Large`, so the binaries moved into per-platform packages on the esbuild pattern: `@devver-inc/cli-darwin-arm64` (`packages/cli-darwin-arm64/`) and `@devver-inc/cli-linux-x64` (`packages/cli-linux-x64/`) each declare `os`/`cpu`, carry no dependencies, and hold that platform's `devver`, `servers/<version>/{devver-server,pitchfork,ferron,PITCHFORK-LICENSE,FERRON-LICENSE}` and `version` at their root. `@devver-inc/cli` keeps its name and bin names, ships no binary, and pins both platform packages in `optionalDependencies` at its own exact version, so `npm install -g @devver-inc/cli` is unchanged and resolves only the matching platform. Its POSIX bin scripts select the platform, then find the installed platform package as a sibling (`node_modules/@devver-inc/cli-<platform>/`) or nested under the CLI, and fail nonzero naming the unsupported or missing platform rather than exiting 0. All three are root workspaces so `bun install` resolves the pins locally; npm cannot resolve a workspace whose `os`/`cpu` miss the host, so `sync-version.ts` regenerates `package-lock.json` with `--force` (lock-only, no install). Runtime packages remain development dependencies for source and standalone builds. `packages/cli/src/cli/update.ts` checks the installed CLI's channel and installer: global npm stable/nightly use their matching npm dist-tags, Homebrew stable uses its formula, and source, dev preview, and manually downloaded binaries do not advertise `--update`. The CLI runs the bounded public check after TUI mount, without cloud authentication; an unavailable check never claims that the CLI is current.
- Workspace root `package.json` is the canonical installed version. Every source PR adds a Changeset (`@devver-inc/cli` bump or empty for no release), checked by CI; generated `release/v*` PRs consume those Changesets and CI instead verifies their version bump and changelog; `changeset status` calculates the development target from pending intent, and source `--version` reports it with the commit. An explicit stable workflow on `main` runs `changeset version`, copies the resulting CLI version to the root, runs `bun run sync:version` to align the server manifests/bin and both locks, then opens a `release/v<version>` PR instead of pushing to protected `main`. Configure `RELEASE_PR_TOKEN` with repository Contents and Pull requests write access so its PR triggers CI; merging the PR tags that exact merge commit and publishes. Merge that release commit back into `develop` before the next development build. `bun run check:version` fails on drift; it also checks the platform package versions and the `optionalDependencies` pins in both manifests and both locks. Publish `@devver-inc/cli-darwin-arm64` and `@devver-inc/cli-linux-x64` before `@devver-inc/cli`, all at the same version and dist-tag, so the optional dependencies resolve: the private root and source-only server workspace are not published.
- `bin` points at POSIX shell launchers under `packages/cli/bin/`. `bun run build` produces the standalone CLI and version-matched server. `bun run build:npm` assembles the npm package from both CI standalone archives and their checksums; it verifies checksums, expected members, and the version before extracting, and does not download at install time. CI downloads both build artifacts before assembly, while `prepack` checks staged binaries without deleting them. `scripts/build-npm-fixture.ts` creates a host-only test fixture with duplicated archive labels; its marker blocks `prepack` unless `DEVVER_ALLOW_NPM_FIXTURE=1` is set for local tests. Publish only the assembled CI artifacts. `build:npm` verifies each archive and extracts it into a `.staging/` directory inside its platform package, committing both only after both verify; the fixture marker and version file live beside the binaries, and each platform package's `prepack` checks its own binaries, version and fixture marker. The platform package root preserves `servers/<version>/devver-server` relative to the CLI. Standalone archives contain `devver` and `servers/<version>/devver-server` (or `.exe` on Windows). Homebrew installs the server at `bin/servers/<version>/devver-server`, sibling to its installed `bin/devver` executable, preserving the standalone relative lookup. #83 pins a packaged server copy under owner-only `installations/<version>/<instanceId>/` before supervision: every newly created instance gets the build that created it, even for repeated local builds of the same version, while running instances retain their own binaries. Existing shared `installations/<version>/` pins remain untouched. `effect/cli` and `@effect/platform-node` supply command parsing, services, and the main runner; do not write a generic command framework.
- Base application architecture on Effect v4: use Effects for HTTP (`effect/http`, not direct `fetch`), subprocesses, resource lifetimes, and errors, and Effect Schema at trust boundaries; keep pure domain logic pure. Prefer composed Effects and early exits over nested conditional chains; do not repeatedly run Effects inside handlers. Inspect `@repos/effect/` for patterns when present; otherwise consult the installed `node_modules/effect` source and declarations.

## Types and trust

- Infer internal types; use `effect/cli` typed flags/arguments and Effect Schema to decode unknown values from HTTP, YAML/JSON, files, and other external inputs.
- Logto persists `logto/accessToken` as JSON but `logto/idToken` as a JWT whose payload carries top-level `organizations: string[]`. Decode the JWT payload; do not `JSON.parse` the ID token file, and do not expect a `claims` wrapper or organization objects. Test fixtures must use real JWTs.
- Do not use `as Type`, `any`, or TypeScript suppressions to make unverified data type-check. `as const` is fine. Narrow with a guard or validate at the boundary; don't silently substitute empty data when persisted secrets/configuration are corrupt.
- Decoded schema types stay readonly; writers build a new object instead of mutating persisted state (`Schema.mutable` applies to arrays only in Effect v4).
- Keep existing Effect response schemas and use the shared `packages/cli/src/api/client.ts` transport. Provide layers to command Effects instead of repeatedly running them from within handlers.

## Reliability and security

- Never log tokens, passwords, or secret values. Credential decode failures report that the store is unusable without attaching the JSON syntax error or schema issue as a cause, because both render a fragment of the offending input. Store project secrets outside tracked files with owner-only permissions; never overwrite unreadable/corrupt secrets. Validate before writing or sending data.
- `NodeRuntime.runMain` renders the failure cause and sets the exit status; do not hand-roll an error formatter beside it. The CLI process edge prints expected `DeployAbortError` and `ServerCreateError` messages directly and marks only those printed errors with `Runtime.errorReported` to avoid duplicate cause logging; other failures keep runtime diagnostics. A message belongs on the error that raises it (`formatBackendError` builds `ApiError.message` from the backend code), and anything that needs a whole cause as text uses `Cause.pretty`/`Cause.prettyErrors`. Never stringify an arbitrary caught value into output: its properties can carry credentials.
- Errors must produce a nonzero exit status, cancellations must not masquerade as successful mutations, and resources (auth server, renderer, Effect scopes) must be cleaned up. Avoid `process.exit()` inside handlers/finalizers. Git/deploy checks fail closed if a subprocess result is unknown or unsuccessful.
- Unimplemented commands must say they are unsupported and fail; do not print a simulated success or wait forever.

## Release channels

- `main` is the stable/hotfix line; `develop` is the long-lived integration/nightly line. Nightly targets derive from pending `develop` Changesets (or a provisional patch when none exist), not npm `latest`. The scheduled/manual nightly workflow checks out `develop` and publishes public opt-in `@devver-inc/cli@nightly` plus `nightly-*` GitHub prereleases. The explicit dev workflow publishes a selected commit via `@devver-inc/cli@dev` and `dev-*` GitHub prereleases. Neither prerelease workflow may tag `v*`, change npm `latest`, or update Homebrew. Forward-merge stable releases to `develop`.

## Checks and updates

- `bun run check` and `bun run typecheck` are green with **zero errors and zero warnings**; keep them that way rather than letting warnings accumulate. The root `tsconfig.json` exists only for `tsc --noEmit`: `composite`/`declaration`/`declarationMap` were removed because nothing consumes declarations (`scripts/build.ts` bundles the source and `scripts/build-npm.ts` packages its executables, and there are no project references), and declaration emit rejected the idiomatic `return yield* new SomeTaggedError(...)` with TS4023 on Effect's `NodeInspectSymbol`. Every type-checking option stays on, including `noUncheckedIndexedAccess`: an indexed read is `T | undefined` until a guard or a default narrows it.
- Prefer removing a lint finding's cause over suppressing it: shared helpers (`packages/cli/src/util/fs-errors.ts`, `packages/cli/src/util/exec.ts`, `packages/server/src/fs-errors.ts`, `packages/server/src/exec.ts`) hold the Node `EEXIST` check and the promisified `execFile` once each instead of repeating a suppression per supervisor. A rule that conflicts with another enabled rule or with a mandated API is turned off once in `oxlint.config.ts`/`tsconfig.json` with its reason (`unicorn/no-useless-undefined` versus `consistent-return`, `max-classes-per-file` versus an Effect module's service plus tagged errors, `unstableApiUsage` for the mandated `effect/cli` and `effect/http`, the Promise callback style rules for `Effect.catch`/`Effect.mapError`). An inline `oxlint-disable-next-line` must name the boundary it guards; a runtime shape check belongs in a named `x is T` predicate, which the rule accepts without any suppression. The intended `@effect-diagnostics-next-line` comments are `strictEffectProvide:off` at the process entry point, at the per-command API layer, where the isolated identity probe provides its fetch layer, where the Promise deployment host provides its HTTP client, and where the server provides its HTTP client; `returnEffectInGen:off` lets `serveCallback` return the completion Effect so `login` can open the browser before awaiting it.
- During implementation, run `bun run check` and the smallest relevant targeted check; use [the CLI verification skill](./.pi/skills/verify-devver-cli/SKILL.md) for flows it covers and retain its proof. Add a new automated test only for important behavior that existing checks or verification cannot reasonably cover. `bun run test:fast` is the working loop: it runs the package tests in about two seconds. The root `tests/` suite builds artifacts and spawns real servers, so five of its tests account for roughly 90% of the full run; run the full `bun test` when preparing a commit or PR, not after every change, and let CI run it for PRs. `tests/node-runtime.test.ts` bundles with `--target=node`, asserts the bundle contains no Bun API calls, and runs it under `node` with Bun absent from `PATH`; keep it passing as the guard against reintroducing Bun-only APIs in shared code. Test the packed npm artifact in a clean install with neither Node nor Bun on the runtime `PATH` before release.
- Windows instance state lives in the real per-user `%LOCALAPPDATA%`; an `XDG_DATA_HOME` override fails closed by design. The active CI matrix does not verify Windows ACLs or supervision. Verify those paths in an isolated Windows runner before resuming Windows releases. PowerShell helpers use .NET types (`GetAccessControl`, `Directory.CreateDirectory`) rather than `Get-Acl`/`Set-Acl`, whose module autoload fails on some runners, and they index parsed JSON by position because PowerShell 5.1 writes an array as one non-enumerated item.
- Release artifact checks cover distinct paths: `tests/standalone-server-cli.test.ts` switches packaged foreground servers without Node or Bun, while `tests/create-server-macos-cli.test.ts` and `tests/create-server-cli.test.ts` create supervised npm servers on macOS and Linux. `tests/static-deploy-artifacts.test.ts` deploys and restarts the standalone artifact. Windows state resolves from `%LOCALAPPDATA%`, cannot be isolated through XDG overrides, and remains outside the active CI matrix.
- Update this document when an architectural or quality decision changes. Do not discard unrelated working-tree changes (including the Effect v4 migration). Push feature branches and open PRs only when the user explicitly requests it; never push directly to `main` or `develop`, and require separate explicit approval before force-pushing.
- Write PR titles and descriptions for human reviewers. Say what changed and why in as few words as possible; include only evidence and risks that affect the merge decision. Cut boilerplate.

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
