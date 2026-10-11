---
"@devver/cli": minor
---

Deploy one committed static root to an attached local server: `devver deploy` selects the checkout's exact committed HEAD, the server synchronizes it into an instance-owned bare repository, serves a detached worktree through the packaged toolchain, and prints a loopback `<id>.localhost` app URL only after it answers.
