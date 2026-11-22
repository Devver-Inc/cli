# Architecture

How the Devver CLI is put together: the pieces, the seams between them, and the invariants each piece owns. [AGENTS.md](./AGENTS.md) holds the rules that govern changes; this file describes the system those rules apply to.

## The shape of the product

`devver` is a terminal client for deploying a Git checkout. It has two kinds of backend, selected explicitly and never probed:

- **Cloud** — `devver cloud` selects `https://app.devver.app/api/v1`. Commands authenticate through Logto.
- **Local** — `devver new server` creates a supervised named instance on the machine; `devver attach` points at an already running one. A local instance needs no account, stays on loopback, and works offline.

`devver detach` clears either selection. Running `devver` with no subcommand shows command help; `devver tui` opens the TUI against the selected target.

A **deployment** is a pinned Git revision, built and served under its own hostname by a local instance. Deployments form a lineage graph: an ordinary deploy attaches to the nearest ready ancestor on first-parent history, and an explicit merge produces a deployment with two parents.

## Packages

| Package | Role |
| --- | --- |
| `packages/cli` | The `devver` executable: command tree, API transport, auth, config, TUI |
| `packages/server` | The local instance: `devver-server`, a separate foreground process |
| `packages/cli-darwin-arm64`, `packages/cli-linux-x64` | Prebuilt binaries for one platform each, no code |

`@devver-inc/cli` ships no binary. It pins both platform packages in `optionalDependencies` at its exact version, and its POSIX bin scripts resolve the installed platform package as a sibling or nested under the CLI. npm installs only the matching platform; a missing or unsupported one fails nonzero by name.

The workspace root `package.json` is the canonical installed version. `packages/README.md` defines the package import seams and the CLI core/infra import direction that `bun run lint:boundaries` enforces with Bun's TypeScript parser; dependency-cruiser cannot scan TypeScript 7 and previously reported success with zero modules.

## The CLI process

`packages/cli/src/cli/index.ts` is the sole entrypoint. The command tree is `effect/cli`; `NodeRuntime.runMain` renders failures and sets the exit status. Only expected, already-worded errors (`DeployAbortError`, `ServerCreateError`, `ServerLifecycleError`, `UpdateError`) are printed at the process edge and marked reported, so everything else keeps its runtime diagnostics.

Inside `packages/cli/src/`:

- `cli/` — the `effect/cli` process entrypoint, `commands/` with one file per top-level command, the scoped API/auth layer wiring in `api.ts`, and shell script generation in `completion/`. Handlers compose Effects and provide infrastructure at the edge; `api.ts` creates one scoped authenticated API layer per command, not per request.
- `core/` — pure project-setting validation, JavaScript stack rules, and release comparison and upgrade planning; no filesystem or HTTP imports.
- `infra/` — response schemas and the shared `api/client.ts` transport (`effect/http`), Logto sessions (`auth/`), workspace config parsing and detection I/O (`config/`), persisted state (`storage.ts`, `state/`, `completion/`), and target verification and supervisors (`local-server/`). Infrastructure may import core, not CLI or TUI. Secrets live outside tracked files with owner-only permissions.
- `tui/` — the separately tested view; it receives operations from the CLI and imports only core or infrastructure, never CLI command wiring.

The existing interactive Git workflow and its subprocess calls stay together in `cli/git.ts`; moving the subprocess calls behind another interface would not simplify the command's interaction. `infra/auth/session.ts` owns the Logto operations and the `serveCallback` OAuth loopback server whose scope finalizer closes it; `page.ts` holds the HTML and `browser.ts` opens the browser. Auth stays on the main event loop without workers or RPC.

`cli/commands/new.ts` lazily imports one supervisor from `infra/local-server/` per platform: launchd on macOS, `systemd-run --user` on Linux, Task Scheduler on Windows. POSIX supervisors preserve the creating CLI's `PATH` so the server can execute the project's package manager even when the service manager has a restricted environment; existing pinned instances keep their original environment. `infra/local-server/supervised-server-posix.ts` holds what both POSIX supervisors share. Any other platform gets one honest failure.

`infra/update.ts` discovers installed and published releases and performs upgrades; `core/update.ts` compares versions and plans commands; `cli/update.ts` prints the result. Global npm stable and nightly use their matching dist-tags, Homebrew stable uses its formula; source builds, dev previews and manually downloaded binaries do not advertise `--update`. `infra/version.ts` resolves the installed or source version string; the CLI passes that string and a bounded update-check callback to the TUI, which imports neither module.

`infra/config/detect.ts` scans projects and combines the primary rules in `core/stacks/<stack>.ts`; there is no mutable detector registry or env-file scan. `devver init` writes static config for an unambiguous local static source. For a single-root recognized process project with a `dev` script, it proposes `<detected package manager> run dev`, without server-owned host and port flags. The local server tries bundled Aube for an implicit dependency install and falls back to the project's package manager when Aube cannot install; an explicit install command takes precedence. `init` asks only for the run command and confirmation; custom install and production build commands can still be added manually to `.devver.yaml`. The reviewed recipe is written only after confirmation. Static projects retain automatic local config. Detection alone never starts a service. A contract test writes CLI process recipes and decodes them with the server's committed-config reader, while the server retains its independent file-safety checks.

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
- `deploy.ts` coordinates publication, rollback and restart reconciliation. `deployment/record.ts` owns the persisted record and stage schemas shared by the API and store; `deployment/failures.ts` maps failures to safe staged messages, `readiness.ts` checks the printed URL, `merge-rules.ts` decides merge admissibility, and `listing.ts` shapes status rows. Revision selection remains in `deploy.ts` and `git-source.ts`.
- `static-deployment.ts` records each config-less static creation in a durable Effect workflow journal (`workflow.sqlite`), keyed by deployment id. Its Git activity (pin, sync, worktree) replays idempotently after a crash, while reserve, publish and readiness stay outside the memoized activity so a resumed run re-establishes live state instead of trusting it. Deployments with a committed `.devver.yaml` (static or process) keep the inline preparation path. Records persist a `lifecycle` discriminator: on restart only `workflow` preparations resume, inline preparations degrade as before, and a resumed run whose journal already completed re-publishes and re-marks liveness rather than returning a stale preparing record. The stored `source` path stays internal and never reaches an API response.
- `deployment-store.ts` is scoped Effect SQL over the matching Node/Bun SQLite driver, with owner-only files and WAL disabled; `sqlite-driver.ts` owns that driver selection for both the store and the workflow journal. `private-state.ts` enforces owner-only deployment directories and records.
- `deployment-host.ts` supervises one Pitchfork process and loopback HTTP proxy per instance. `pitchfork/manifest.ts` owns generated config and command quoting, `loopback-port.ts` allocates ports, and `proxy-probe.ts` verifies startup. Each deployment is registered as a project in the instance's isolated Pitchfork config, so `<daemon>.<project>.localhost` routes natively. `reserve` hands each deployment its own loopback port and owner-only config directory, and the manifest pins that port rather than letting Pitchfork bump it. Readiness is a real request to the printed URL, and a persisted proxy port never changes on restart.
- `workloads/static.ts` serves a committed checkout with packaged Ferron: a generated owner-only `ferron.kdl` binds the reserved port on 127.0.0.1, disables the default HTTP and HTTPS ports, and rewrites extensionless non-file routes to `/` for SPA fallback. Paths written into that config pass a KDL guard, because Ferron expands `{env:NAME}` placeholders as it loads.
- `workloads/process.ts` runs an explicit install command if supplied; otherwise a plain package-manager `run <script>` tries packaged Aube's frozen install and falls back to the recorded manager's install if Aube fails. It then runs an optional build, passes `PORT`, `HOST` and `HOSTNAME` through the environment and adds the reserved port and loopback host as launch-only flags for known Vite, Next, Astro and Nuxt dev scripts, each described by its own `workloads/stacks/<stack>.ts` rule; Astro's rule also carries `--ignore-lock` to prevent agent-triggered backgrounding and allow separate deployments. Other scripts can use the environment or specify binding themselves. The recorded run command is still executed with its own package manager; a leading `aube` in older or custom recipes resolves to the packaged binary. `${PORT}` in custom run commands expands only as a whole argument. Pitchfork pins each deployment's port with `bump = false`, so concurrent dev deployments do not choose a framework default. Local workloads are not sandboxed. Ferron does not proxy these processes.
- `git-source.ts` owns the server-side Git subprocesses: the owner-only bare repository, pinned revisions, detached worktrees, first-parent ancestry and `merge-tree --write-tree` merges (Git 2.38 or newer).

A merge creates a new Git merge commit in the server-owned bare repository and a new deployment with both parents. It never changes either source or the user's checkout; conflicts, identical revisions and unrelated histories create nothing.

## The resource engine

`packages/server/engine.ts` owns an internal resource engine, with private implementation under `packages/server/src/engine/`. Deployment commands do not use it: durable static creations run on the Effect workflow journal described above, which is deliberately separate from this resource engine. Its scoped `openResourceEngine` takes an owner-only SQLite journal path, idempotent providers, and a concurrency bound. It exposes `apply` and `teardown`.

Resource inputs contain JSON references such as `{ "$ref": "backend", "output": "url" }`. One traversal validates references and derives dependency edges. Resource identities never become filesystem paths in the engine. These dependencies are separate from Git deployment ancestry.

`apply` validates graph structure and known persisted references before lifecycle effects. It always reconciles included resources in dependency order. Providers own live checks and readiness. Their arguments and outputs cross cloned, Schema-validated boundaries, and failures expose only static messages with validated public ids and stages. References to resources outside the request require a ready journal record, not an interrupted record's retained output.

The journal records `pending` before each reconcile and `ready` after success. Pending updates retain the last successful output, the union of old and attempted dependency edges, and the stricter protection policy. Only successful reconciliation installs the requested bindings and policy. Failure blocks consumers without deleting resources. Providers must discover and reconcile partially created resources by stable identity after a crash.

`teardown` refuses the whole request before removal if any member is unknown, protected, providerless, or still used by a surviving consumer. It also rejects invalid ids and corrupt dependency cycles. Removal runs in reverse dependency order. Failure stops before upstream removal and leaves retryable `deleting` state. Removed-id tombstones distinguish explicit retries from unknown ids. Omitted declarations never imply deletion.

An Effect Semaphore serializes operations on one engine. A scoped SQLite owner claim rejects other writers and reclaims a crashed owner only when its PID is definitely dead. Short transactions preserve checkpoints across process death. PID reuse can conservatively block reopening until that PID disappears.

`scripts/verify-resource-engine.ts` proves crash recovery, update recovery, deletion safety, writer exclusion, and Node execution without Bun on the runtime path. Its resources are files, not production databases or backends. The root test suite runs this proof; package tests exercise the root engine entry.

## Invariants

- Effect v4 throughout: `effect/http` for HTTP, Effects for subprocesses, resource lifetimes and errors, Effect Schema at every trust boundary. Pure domain logic stays pure.
- Unknown data is decoded, never asserted. Decoded types stay readonly; writers build new objects rather than mutating persisted state.
- Secrets never reach logs or error causes, and corrupt secret stores are reported as unusable rather than silently replaced.
- Errors exit nonzero, cancellations never masquerade as successful mutations, and scopes release the auth server, renderer and store. Git and deploy checks fail closed when a subprocess result is unknown.
- Shared code stays runtime-neutral: `tests/node-runtime.test.ts` bundles for Node and asserts no Bun API survives.

## Build, release and verification

`effect/cli` generates Bash, Zsh and Fish scripts through `devver --completions <shell>`; the CLI adds offline value completion for saved server names and ready deployment IDs. Tab reads validated disk state only. The deployment snapshot lives under `completion/local/<instanceId>.json`, refreshed after a successful local TUI listing or `server status` listing, and is deliberately allowed to be stale; normal commands still validate IDs. Cloud snapshots, if needed, must use a separate account-scoped path and refresh during authenticated commands, not completion. The release workflow has Homebrew install the scripts using its formula DSL; npm and standalone users explicitly install them into their shell's completion path. npm install never edits shell startup files.

`bun run build` produces the standalone CLI and a version-matched server; `bun run build:npm` assembles the npm packages from both CI standalone archives and their checksums, verifying before extracting and never downloading at install time. Standalone archives contain `devver` and `servers/<version>/devver-server`, a relative layout preserved by the platform packages and by Homebrew.

`main` is the stable line and `develop` the nightly one. Every PR carries a Changeset; `bun run check:version` fails on drift across manifests and locks. Prerelease workflows may not tag `v*`, move npm `latest`, or touch Homebrew.

`bun run check` and `bun run typecheck` stay green with zero warnings. The [CLI verification skill](./.pi/skills/verify-devver-cli/SKILL.md) drives an isolated CLI and foreground server for the flows it covers and retains its proof.

## Where decisions live

Decisions that bind this code are written here and in [AGENTS.md](./AGENTS.md). Everything still being decided — future contracts, research, release gates — lives in GitHub issues on `Devver-Inc/cli`, not in this repository. Public deployment URLs are issue #91; watch mode is #130 and #162.
