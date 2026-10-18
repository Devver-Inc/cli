# Attach and detach

A developer selects a running local server and can remove that selection without stopping the server.

## Sub-features

- `attach` checks the server identity before saving the target.
- `server status` reports the selected server as reachable.
- `detach` clears the target while leaving the server running.

## How to get to it (user POV)

Run `devver attach http://127.0.0.1:<port>/api/v1`, then `devver server status` and `devver detach`.

## Driving it with Bash

Preconditions: Bun, Git, and curl are installed. Run `bash .pi/skills/verify-devver-cli/verify.sh attach`. The helper starts an isolated foreground server, attaches to its printed URL, inspects status, detaches, and inspects status again. `actions.txt` must show `Attached verify-static`, `reachable`, `Detached target`, `No server attached`, and `PASS attach`. `identity.json` must name `verify-static`.

## Gotchas

A foreground server has no system supervisor entry. `devver server list` need not list it. Detaching does not stop its process; the helper stops it during cleanup. Windows cannot isolate server state with XDG variables.
