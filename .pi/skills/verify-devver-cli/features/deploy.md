# Deploy a static page

A developer deploys the checkout's committed HEAD to an attached local server and receives a working app URL with committed content.

## Sub-features

- `deploy` selects committed HEAD and returns a `.localhost` URL. `--verbose` also prints the ID and SHA.
- Uncommitted edits remain absent from the served page.
- The control API and app listener use different ports.

## How to get to it (user POV)

Attach a local server with `devver attach <control URL>`. In a Git checkout with committed `index.html`, run `devver deploy` and visit the printed `App URL`.

## Driving it with Bash

Preconditions: Bun, Git, and curl are installed. Run `bash .pi/skills/verify-devver-cli/verify.sh deploy`. The helper creates and commits a static HTML fixture, edits `index.html` without committing, then runs the CLI from that checkout. `actions.txt` must show the selected target and `PASS deploy`. `deploy.txt` comes from `devver deploy --verbose` and must print the SHA in `selected-head.txt` and an app URL. `app-response.html` must contain `<h1>committed static page</h1>`, not `uncommitted edit`. `deployment-record.json` must show that ID and SHA with status `ready`. The URL must resolve and answer without a manually supplied Host header.

## Gotchas

This is source-CLI verification with packaged Pitchfork and Websitino. It does not prove that installed npm or standalone CLI artifacts work without their development runtimes. The local server is unsandboxed; use only this disposable fixture. On older macOS or unsupported platforms, the packaged Websitino binary may be unavailable.
