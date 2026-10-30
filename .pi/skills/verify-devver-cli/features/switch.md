# Switch to cloud

A developer switches an attached local server selection to the official cloud target, then clears the selection.

## Sub-features

- `cloud` replaces the selected local target without probing cloud.
- `config list` shows the official cloud API URL.
- `detach` clears the selection.

## How to get to it (user POV)

Run `devver attach <control URL>`, `devver cloud`, `devver config list`, then `devver detach` and `devver server status`.

## Driving it with Bash

Preconditions: Bun, Git, and curl are installed. Run `bash .pi/skills/verify-devver-cli/verify.sh switch`. `actions.txt` must show the attach result, `Selected cloud at https://app.devver.app/api/v1`, `cloud-target = https://app.devver.app/api/v1`, `Detached target`, `No server attached`, and `PASS switch`.

## Gotchas

Selecting cloud does not authenticate or deploy. This recipe intentionally makes no request to the cloud API. The test uses isolated CLI configuration and a foreground local server, not the user's active selection.
