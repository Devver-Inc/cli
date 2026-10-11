# Devver CLI

Install dependencies with `bun install`. Run the CLI from source with automatic restarts using `bun run dev`.

To keep a local standalone executable rebuilt as you edit (without replacing your globally installed CLI):

```bash
bun run dev:build                 # keep this running in one terminal
export PATH="$PWD:$PATH"          # in another terminal, from the repo root
devver --version                  # runs the freshly built ./devver
```

The watcher rebuilds the executable; an already-running process does not restart. The source CLI reports the pending Changesets target and Git commit when you request `--version`; watch-built binaries report the `dev` channel. Release builds stamp their version and commit. npm publishes only `@devver/cli`, including a bundled offline server at `dist/servers/<version>/server.mjs`; the server workspace is not published.

Build with `bun run build:npm` for Node/npm or `bun run build` for standalone executables. Both distributions package pinned MIT-licensed Pitchfork and Websitino for local static serving; builds download and verify their checksums, while runtime startup never downloads them. **Local static serving requires macOS 14 or newer on Apple Silicon** (or supported Linux x64 / Windows x64); older macOS fails rather than attempting to run an incompatible Websitino binary. Run `bun run check`, `bun run typecheck`, and `bun test` from the root.

## Development and release versions

Every PR must add a `.changeset/*.md` file: run `mise run bump` and select `@devver/cli` with the appropriate patch/minor/major bump, or `mise run no-release` for a change that needs no release. Commit the file with the PR; CI checks for it. Changesets on `develop` determine the planned version shown by `bun run cmd --version`. A local checkout also shows its commit SHA; it does not reserve a published build number. With no pending changesets, local source shows the current stable baseline instead.

`main` is the stable/hotfix line; `develop` is the integration line. Merge work from `develop` into `main` when ready. To release, a maintainer runs the **Release** workflow on `main`. It verifies pending Changesets, versions the CLI, synchronizes the root/server manifests and both locks, runs checks, commits and tags the exact release, then builds binaries, publishes the GitHub Release and npm `latest`, and updates Homebrew. The workflow's scoped `GITHUB_TOKEN` needs `contents: write` to push `main` and its tag (and must satisfy any branch-protection rules); `NPM_TOKEN` publishes to npm, and `CLI_RELEASE_PAT` updates the optional Homebrew tap. If publishing fails after tagging, rerun **Release** on `main` with its existing `v*` tag in the `tag` input; do not calculate a second version. **Merge the generated stable release commit back to `develop` before another dev/nightly publish.** Stable and prerelease artifacts are independent; no dev artifact is renamed into stable.

Nightly runs daily (or manually) on the latest `develop` commit and publishes public `@devver/cli@nightly` plus `nightly-*` GitHub prereleases. An unchanged commit is skipped. A nightly without pending Changesets uses a _provisional_ next-patch prerelease number, not an approved stable plan. A maintainer can run **Dev preview** from `main` with a full repository commit SHA to publish public `@devver/cli@dev` and matching `dev-*` prerelease binaries. Each publish gets a unique workflow run/attempt number; neither prerelease updates npm `latest` or Homebrew.

```bash
npm install -g @devver/cli@dev      # explicit preview, Node >=26.4
npm install -g @devver/cli@nightly  # nightly
npm install -g @devver/cli          # stable
```

For CI without Node, pin an actual `nightly-*` or `dev-*` tag from [GitHub Releases](https://github.com/Devver-Inc/cli/releases) with mise's GitHub backend:

```toml
[tools."github:Devver-Inc/cli"]
version = "nightly-1.2.1-nightly.build.42.1"
version_prefix = ""
prerelease = true
```

Replace the sample version with a real release tag. The empty prefix prevents mise from adding `v`; do not use `@latest` for prerelease CI installs.

## Testing locally

```bash
bun run build
./devver --version
```
