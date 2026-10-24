---
name: verify-devver-cli
description: Verify Devver CLI user flows, especially attached local static deployments, by driving an isolated CLI and foreground server and retaining terminal and HTTP evidence.
---

# Verify Devver CLI

Read [the feature map](features/README.md) and the selected feature file before driving. The primary surface is the `devver` CLI. Its local control API and static app URL are secondary observations. Local TUI list, selection, opening, and unreachable state are covered; clipboard writes and authenticated cloud API are outside this skill's live proof.

## Launch

On macOS or Linux, run `bash .pi/skills/verify-devver-cli/verify.sh attach`, `deploy`, `switch`, or `tui` from any working directory. The helper uses the repository's `bun run build:npm` to package Pitchfork and Websitino, starts `packages/server/src/index.ts` as a foreground child on an ephemeral loopback port, and invokes the real CLI entry point. Install dependencies with `bun install` if the repo has no `node_modules`. The helper prints the control URL when the server announces it and tears down the process on exit, including failure. It does not run `devver new server`, which registers a system supervisor; this recipe uses a disposable foreground server instead. On Windows use the repo's Windows CI and packaged artifact tests, not this Bash helper: server state there uses the real `%LOCALAPPDATA%` and cannot be isolated through XDG variables.

## Doctor

The helper runs `devver --version` and fetches `<control URL>/identity` before the feature action. The response must identify `verify-static` and the CLI must exit successfully. If startup or a later step fails, inspect the retained `build.log`, `server.log`, `version.txt`, and `identity.json` before retrying. Only drive the server whose PID and URL this run created.

## Drive

The executable helper is `verify.sh`. Invoke it with exactly one mapped feature ID: `bash .pi/skills/verify-devver-cli/verify.sh deploy`. Its `attach` and `switch` modes exercise the target-selection entry points. `tui` drives a disposable pseudo-terminal with Python 3, records an opened URL through a stub instead of launching a browser, then checks the TUI after stopping its isolated server. Its `deploy` mode creates a disposable Git checkout, commits `index.html`, makes an uncommitted edit, runs `devver attach` and `devver deploy`, then fetches the printed app URL using natural `.localhost` resolution. Consult the matching [feature recipe](features/README.md) for the expected user-visible result.

## Evidence

Each run prints a retained `devver-verify-proof.*` directory outside the repository. `actions.txt` contains commands, outputs, and the pass marker; `identity.json` and `version.txt` identify the server and CLI; `server.log` records server output before teardown. Deploy and TUI also retain `selected-head.txt`, `deploy.txt`, `app-response.html`, and `deployment-record.json`. TUI retains `tui-list-open.txt`, `tui-unreachable.txt`, `tui-second-deploy.txt`, `tui-opened.txt`, and `tui-second-response.html`. The fetched response must match the committed page and differ from the uncommitted edit. The read-only SQLite observation must match the printed ID and SHA with status `ready`. Record the feature ID and the proof path when reporting a result. Use real CLI commands rather than changing stored state through an internal API. Check the printed URL and its HTTP response, not a supplied Host header. No cloud credentials or customer data enter this disposable workspace. A failed run has evidence but no pass marker.

## Cleanup

The helper kills only the foreground server PID it started, waits for it, and deletes its isolated XDG directories and fixture checkout. The TUI driver closes its pseudo-terminal and stops its own CLI process on failure. It retains the proof directory even if a command fails. Never kill processes by name or delete another run's scratch directories. The `switch` recipe selects cloud in isolated config but sends no cloud request; no dry-run flag is involved.

## Helpers

`verify.sh` is executable and takes `attach`, `deploy`, `switch`, or `tui`. It requires Bash, Bun, Git, and curl; `tui` also requires Python 3. The helper sources no ambient CLI config because it sets all four XDG directory variables to a new run directory. Packaging can download the pinned static tools at build time; CLI and server startup never download them.
