# Devver CLI

Install dependencies with `bun install`. Run the CLI from source with automatic restarts using `bun run dev`.

To keep a local standalone executable rebuilt as you edit (without replacing your globally installed CLI):

```bash
bun run dev:build                 # keep this running in one terminal
export PATH="$PWD:$PATH"          # in another terminal, from the repo root
devver --version                  # runs the freshly built ./devver
```

The watcher rebuilds the executable; an already-running process does not restart. The source CLI reports the pending Changesets target and Git commit when you request `--version`; watch-built binaries report the `dev` channel. Release builds stamp their version and commit. npm publishes three packages at the same version: `@devver-inc/cli`, which carries only the POSIX launchers, and the per-platform `@devver-inc/cli-darwin-arm64` and `@devver-inc/cli-linux-x64`, which carry the native CLI and offline server executables. `@devver-inc/cli` lists both as pinned `optionalDependencies`, so `npm install -g @devver-inc/cli` is unchanged and downloads only the matching platform; the server workspace is not published.

Build with `bun run build` for standalone executables. To assemble the npm platform packages, place both standalone archives and their SHA-256 files in `artifacts/`, then run `bun run build:npm`. For local tests only, `bun run scripts/build-npm-fixture.ts` assembles a host-only fixture; never publish it. The npm packages install with Node but their commands run without Node or Bun. Both distributions package pinned MIT-licensed Pitchfork and Websitino for local static serving; builds download and verify their checksums, while runtime startup never downloads them. **Local static serving requires macOS 14 or newer on Apple Silicon** (or supported Linux x64); Windows standalone publishing and CI are paused pending runtime verification. Older macOS fails rather than attempting to run an incompatible Websitino binary. Run `bun run check`, `bun run typecheck`, and `bun test` from the root.

After `bun run build`, use `./devver new server <name>` (or put this checkout first on `PATH`); a new server pins this build under its own instance ID, even when the version number has not changed. Existing servers keep their pinned binaries. For an isolated foreground test that cleans up on Ctrl-C, run `mise run dev-local`; it prints a temporary CLI command to use from your website checkout.

## Updating the CLI

A globally installed npm CLI can run `devver --update`. It checks the published npm tag and installs an exact newer version on the same channel: `latest` for stable or `nightly` for nightly. A stable Homebrew installation uses `brew update` and `brew upgrade devver-cli` when its formula has a newer stable version. The terminal UI shows `devver --update` only when it detects a supported installation and a newer release. Source, dev preview, and standalone downloads do not self-update. For those builds, replace the CLI and its matching versioned server together using the original distribution method. Existing supervised servers retain their pinned binaries.

## Development and release versions

Every PR must add a `.changeset/*.md` file: run `mise run bump` and select `@devver-inc/cli` with the appropriate patch/minor/major bump, or `mise run no-release` for a change that needs no release. Commit the file with the PR; CI checks for it. Changesets on `develop` determine the planned version shown by `bun run cmd --version`. A local checkout also shows its commit SHA; it does not reserve a published build number. With no pending changesets, local source shows the current stable baseline instead.

`main` is the stable/hotfix line; `develop` is the integration line. Merge work from `develop` into `main` when ready. To release, a maintainer runs the **Release** workflow on `main`. It verifies pending Changesets, versions the CLI, synchronizes the root/server manifests and both locks, runs checks, commits and tags the exact release, then builds binaries, publishes the GitHub Release and npm `latest`, and updates Homebrew. The workflow's scoped `GITHUB_TOKEN` needs `contents: write` to push `main` and its tag (and must satisfy any branch-protection rules); `NPM_TOKEN` publishes to npm, and `CLI_RELEASE_PAT` updates the optional Homebrew tap. If publishing fails after tagging, rerun **Release** on `main` with its existing `v*` tag in the `tag` input; do not calculate a second version. **Merge the generated stable release commit back to `develop` before another dev/nightly publish.** Stable and prerelease artifacts are independent; no dev artifact is renamed into stable.

Nightly runs daily (or manually) on the latest `develop` commit and publishes public `@devver-inc/cli@nightly` plus `nightly-*` GitHub prereleases. An unchanged commit is skipped. A nightly without pending Changesets uses a _provisional_ next-patch prerelease number, not an approved stable plan. A maintainer can run **Dev preview** from `main` with a full repository commit SHA to publish public `@devver-inc/cli@dev` and matching `dev-*` prerelease binaries. Each publish gets a unique workflow run/attempt number; neither prerelease updates npm `latest` or Homebrew.

```bash
npm install -g @devver-inc/cli@dev      # explicit preview
npm install -g @devver-inc/cli@nightly  # nightly
npm install -g @devver-inc/cli          # stable
# npm requires Node to install; devver and devver-server run without either runtime
```

To test stable and nightly side by side, install them under separate prefixes instead of installing both globally (which would overwrite the same `devver` command):

```bash
npm install --prefix "$HOME/.local/devver-latest" @devver-inc/cli@latest
npm install --prefix "$HOME/.local/devver-nightly" @devver-inc/cli@nightly

"$HOME/.local/devver-latest/node_modules/.bin/devver" --version
"$HOME/.local/devver-nightly/node_modules/.bin/devver" --version
```

Optional zsh aliases (add to `~/.zshrc`, then open a new terminal):

```sh
alias dvr='"$HOME/.local/devver-latest/node_modules/.bin/devver"'
alias dvrn='"$HOME/.local/devver-nightly/node_modules/.bin/devver"'
```

Run the corresponding `npm install --prefix ...` command again to update either channel; these local installs do not use the global-install `devver --update` flow.

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
