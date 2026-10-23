---
"@devver-inc/cli": minor
---

Deploy one committed static root to an attached local server: `devver deploy` selects the checkout's exact committed HEAD, the server synchronizes it into an instance-owned bare repository, serves a detached worktree through one per-instance Pitchfork supervisor and its loopback proxy, and prints a native `<id>.<instance>.localhost` app URL only after it answers. Pitchfork assigns and bumps each daemon's port. A newly created server pins the build that created it under its instance ID, without replacing binaries used by existing instances.
