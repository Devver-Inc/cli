<div align="center">

# Devver

**Deploy a commit. Explore what comes next.**

[Get started](#get-started) · [How it works](#how-it-works) · [Install](#install) · [Contribute](#contribute)

[![CI](https://img.shields.io/github/actions/workflow/status/Devver-Inc/cli/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/Devver-Inc/cli/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/@devver-inc/cli?style=flat-square&label=npm)](https://www.npmjs.com/package/@devver-inc/cli) [![Releases](https://img.shields.io/github/v/release/Devver-Inc/cli?style=flat-square&label=release)](https://github.com/Devver-Inc/cli/releases)

![Illustration of Devver deployment lineage: a first deploy branches into previews and merges](docs/assets/devver-banner.svg)

</div>

Devver gives each deployed Git revision its own URL. Start with a local server on your machine, try different versions side by side, and follow their history in a terminal UI. An ordinary deploy follows the nearest ready ancestor; an explicit merge creates a new revision without changing your checkout.

> [!IMPORTANT]
> Local deployments run with **your user account's permissions**. Only deploy code you trust; local servers are not a sandbox. Their API and proxy bind to loopback.

## Get started

Install the CLI with Node and npm, then create a named local server:

```sh
npm install -g @devver-inc/cli
devver new server demo
```

From a **Git checkout containing a committed static site** (for example, an `index.html` at its root), deploy and open the resulting URL:

```sh
cd /path/to/your/project
devver deploy --open
devver
```

The last command opens the deployment graph. The server stays attached for future commands; run `devver server status` to inspect it, `devver detach` to clear your selection, or `devver attach <url>` to select a different verified local server. URLs and deployment state belong to the server instance, not your current shell.

Local deployment currently serves static sites. For another target, `devver cloud` selects the official cloud API; cloud commands use `devver auth login` to sign in. Selecting cloud never silently switches a local server to a remote one.

## How it works

```text
Git checkout ── committed revision ──► local server ──► deployment URL
                                          │
                                          └─► terminal lineage: deploy / branch / merge
```

- **Pinned revisions.** Each deploy pins a Git commit in the server's own repository and leaves your working tree alone. Multiple deployments can use the same commit.
- **History you can navigate.** The TUI shows parent and child relationships, status, URLs, and merge connections. Open it with `devver`; use `d` for details or `o` to open a ready deployment.
- **Separate targets.** Local instances run on your machine without an account. Cloud is opt-in with `devver cloud`; `devver detach` selects neither.

See [AGENTS.md](AGENTS.md) for the CLI/server architecture, [packages/README.md](packages/README.md) for package boundaries, and [GitHub issues](https://github.com/Devver-Inc/cli/issues) for work in progress.

## Install

| Channel | Command | What you get |
| :-- | :-- | :-- |
| Stable | `npm install -g @devver-inc/cli` | Latest stable release |
| Nightly | `npm install -g @devver-inc/cli@nightly` | Builds from `develop` |
| Preview | `npm install -g @devver-inc/cli@dev` | Opt-in development build |

The npm package installs the native executable for your platform. **Node is needed to install it, not to run `devver` or its packaged server; Bun is not needed at runtime either.** Supported native packages are macOS Apple Silicon (macOS 14+) and Linux x64. Windows releases are paused pending runtime verification. Local static serving bundles its tools, so server startup does not download them.

Standalone binaries are available from [GitHub Releases](https://github.com/Devver-Inc/cli/releases). Keep each CLI with its matching versioned server. To update a supported global npm install, run `devver --update`; Homebrew stable installs use `brew update && brew upgrade devver-cli`. Source builds and standalone downloads do not self-update. Existing supervised local servers retain their pinned binaries after a CLI update.

## Contribute

Development uses [Bun](https://bun.sh) and Node for tooling. From the repository root:

```sh
bun install
bun run dev          # run the CLI from source, with restarts
bun run check        # format, lint, and type-check
bun test             # full test suite
```

`bun run build` produces standalone CLI and server executables. For a disposable local-server test, use `mise run dev-local`. Every PR needs a Changeset: `mise run bump` for a release change, or `mise run no-release` for a change without a bump. The root package version is the committed baseline; pending Changesets on `develop` determine the next planned version.

`develop` carries nightly builds; `main` carries stable releases. A maintainer runs the **Release** workflow on `main` with an empty tag field to version, test, tag, and publish a new stable release. To resume a failed publish after tagging, rerun it with the existing `v*` tag. Merge its release commit back into `develop` before the next nightly. See [the release workflow](.github/workflows/release.yml) for the exact steps and [AGENTS.md](AGENTS.md) for project conventions.

Found a bug or have an idea? [Open an issue](https://github.com/Devver-Inc/cli/issues).
