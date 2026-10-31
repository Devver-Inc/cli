# Architecture

How the Devver CLI is put together: the pieces, the seams between them, and the invariants each piece owns. [AGENTS.md](./AGENTS.md) holds the rules that govern changes; this file describes the system those rules apply to.

## The shape of the product

`devver` is a terminal client for deploying a Git checkout. It has two kinds of backend, selected explicitly and never probed:

- **Cloud** — `devver cloud` selects `https://app.devver.app/api/v1`. Commands authenticate through Logto.
- **Local** — `devver new server` creates a supervised named instance on the machine; `devver attach` points at an already running one. A local instance needs no account, stays on loopback, and works offline.

`devver detach` clears either selection. Running `devver` with no subcommand opens the TUI against whichever target is selected.

A **deployment** is a pinned Git revision, built and served under its own hostname by a local instance. Deployments form a lineage graph: an ordinary deploy attaches to the nearest ready ancestor on first-parent history, and an explicit merge produces a deployment with two parents.

## Packages

| Package | Role |
| --- | --- |
| `packages/cli` | The `devver` executable: command tree, API transport, auth, config, TUI |
| `packages/server` | The local instance: `devver-server`, a separate foreground process |
| `packages/cli-darwin-arm64`, `packages/cli-linux-x64` | Prebuilt binaries for one platform each, no code |

`@devver-inc/cli` ships no binary. It pins both platform packages in `optionalDependencies` at its exact version, and its POSIX bin scripts resolve the installed platform package as a sibling or nested under the CLI. npm installs only the matching platform; a missing or unsupported one fails nonzero by name.

The workspace root `package.json` is the canonical installed version. `packages/README.md` defines the import seams and the four boundary rules that `bun run lint:boundaries` enforces.

## The CLI process

`packages/cli/src/cli/index.ts` is the sole entrypoint. The command tree is `effect/cli`; `NodeRuntime.runMain` renders failures and sets the exit status. Only expected, already-worded errors (`DeployAbortError`, `ServerCreateError`, `ServerLifecycleError`, `UpdateError`) are printed at the process edge and marked reported, so everything else keeps its runtime diagnostics.

Inside `packages/cli/src/`:

- `cli/` — one file per command group. Handlers compose Effects and provide the API and auth layers at the edge. `cli/api.ts` supplies one scoped authenticated API layer per command, not per request.
- `domain/project.ts` — pure project-setting validation, free of HTTP and CLI types.
- `api/` — response schemas and the shared `api/client.ts` transport (`effect/http`).
- `auth/` — Logto sessions on the main event loop: `session.ts` owns the operations and the `serveCallback` OAuth loopback server whose scope finalizer closes it, `page.ts` the callback HTML, `browser.ts` cross-platform opening. No worker, no RPC.
- `config/`, `storage.ts` — persisted target selection and state; secrets live outside tracked files with owner-only permissions.
- `util/git/` — CLI-side Git subprocesses through `node:child_process`.

`cli/new.ts` lazily imports one supervisor per platform: launchd on macOS, `systemd-run --user` on Linux, Task Scheduler on Windows. `supervised-server-posix.ts` holds what both POSIX supervisors share. Any other platform gets one honest failure.

`cli/update.ts` advertises `--update` only where the installer can carry it: global npm stable and nightly use their dist-tags; dedicated npm prefixes opt in with a `.devver-self-update` file and a manifest containing only the CLI dependency, and reinstall into the same prefix; Homebrew stable uses its formula. Source builds, unmarked project dependencies, dev previews and manually downloaded binaries do not self-update.

## The TUI

`packages/cli/src/tui/` is a separately testable, lazy-loaded OpenTUI React view. Its `run` is a scoped Effect and the CLI decides when to start it. The view receives a discriminated cloud/local/none target (`target.ts`); it never reaches for organization or deployment data itself.

Folders name the concern rather than a component taxonomy:

- `graph/` — React-free lane, lineage and focus math. `deployment-graph.ts` returns one cell per character, so every stroke names the lineage that owns it; `focus.ts` owns the lineage closure and its per-hop falloff.
- `components/` — presentation that takes props and owns no application state; each component keeps its own hook beside it.
- the root — the views and their state (`app.tsx`), the renderer entry (`index.tsx`), row shaping (`deployments.ts`), keys and theme.

A local target shows the deployments of its attached instance, matched by the SHA-256 of the canonical Git checkout root when there is one. Selection pulls focus instead of opening a second view: the selected row's lineage solidifies and brightens hop by hop while unrelated lanes stay dashed and dim, and the row expands in place with its parents, URL and children. `d` opens a floating detail panel; `v` and `m` select and merge two ready deployments of one repository. `DEVVER_REDUCED_MOTION` disables the travelling highlight, and tests set it.

## The local server

`packages/server/src/index.ts` is a separate foreground Effect entrypoint (`<name> [port]`). It acquires the deployer inside the listener's scope, so cancellation withdraws active deployments and closes the store. The listener binds to 127.0.0.1 and keeps duplicate-`Host`/`Origin` and `Sec-Fetch-Site` same-origin checks on the raw Node request, before routing.

- `api.ts` declares the `HttpApi` endpoints and response schemas; `handlers.ts` implements them. `GET /api/v1/deployments` exposes non-secret statuses, so an older server without it reports unavailable rather than empty.
- `identity.ts` keeps durable per-name identity under XDG data in owner-only `servers/` directories. Windows cannot use mode bits, so `windows-acl.ts` keeps instance state under an owner-only `%LOCALAPPDATA%\devver` DACL and rejects `XDG_DATA_HOME` overrides as untrusted.
- `deployment-store.ts` is scoped Effect SQL over the matching Node/Bun SQLite driver, with owner-only files and WAL disabled.
- `deployment-host.ts` shares one Pitchfork supervisor and loopback HTTP proxy per instance. Each deployment is registered as a project in the instance's isolated Pitchfork config, so `<daemon>.<project>.localhost` routes natively. Readiness is a real request to the printed URL, and a persisted proxy port never changes on restart.
- `git-source.ts` owns the server-side Git subprocesses: the owner-only bare repository, pinned revisions, detached worktrees, first-parent ancestry and `merge-tree --write-tree` merges (Git 2.38 or newer).

A merge creates a new Git merge commit in the server-owned bare repository and a new deployment with both parents. It never changes either source or the user's checkout; conflicts, identical revisions and unrelated histories create nothing.

## Invariants

- Effect v4 throughout: `effect/http` for HTTP, Effects for subprocesses, resource lifetimes and errors, Effect Schema at every trust boundary. Pure domain logic stays pure.
- Unknown data is decoded, never asserted. Decoded types stay readonly; writers build new objects rather than mutating persisted state.
- Secrets never reach logs or error causes, and corrupt secret stores are reported as unusable rather than silently replaced.
- Errors exit nonzero, cancellations never masquerade as successful mutations, and scopes release the auth server, renderer and store. Git and deploy checks fail closed when a subprocess result is unknown.
- Shared code stays runtime-neutral: `tests/node-runtime.test.ts` bundles for Node and asserts no Bun API survives.

## Build, release and verification

`bun run build` produces the standalone CLI and a version-matched server; `bun run build:npm` assembles the npm packages from both CI standalone archives and their checksums, verifying before extracting and never downloading at install time. Standalone archives contain `devver` and `servers/<version>/devver-server`, a relative layout preserved by the platform packages and by Homebrew.

`main` is the stable line and `develop` the nightly one. Every PR carries a Changeset; `bun run check:version` fails on drift across manifests and locks. Prerelease workflows may not tag `v*`, move npm `latest`, or touch Homebrew.

`bun run check` and `bun run typecheck` stay green with zero warnings. The [CLI verification skill](./.pi/skills/verify-devver-cli/SKILL.md) drives an isolated CLI and foreground server for the flows it covers and retains its proof.

## Where decisions live

Decisions that bind this code are written here and in [AGENTS.md](./AGENTS.md). Everything still being decided — future contracts, research, release gates — lives in GitHub issues on `Devver-Inc/cli`, not in this repository. Public deployment URLs are issue #91; watch mode is #130 and #162.
