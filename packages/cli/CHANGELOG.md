# @devver-inc/cli

## 0.1.0

### Minor Changes

- 8e20cf9: Show supported stable and nightly updates in the terminal UI and update npm-global or Homebrew-managed installations with `devver --update`.
- 8e20cf9: Copy ready local deployment URLs with c in the TUI and show actionable guidance for unavailable, failed, and empty deployment listings.
- 8e20cf9: Render local deployments as a parent-child tree in the TUI with j/k/h/l navigation and o to open a ready deployment URL in the browser.
- 8e20cf9: Keep local static deployments independent across revisions and server restarts: two explicit deploys from one checkout serve their own committed revision at their own stable URL, and a restarted server reconciles its durable records with the processes and routes it finds, recovering healthy deployments on their published addresses and reporting the rest degraded instead of ready.
- 8e20cf9: Allow renaming local deployments from the TUI while retaining deployment IDs and persisted names across server restarts.
- 8e20cf9: Ability to have a server running locally
- 8e20cf9: Deploy one committed static root to an attached local server: `devver deploy` selects the checkout's exact committed HEAD, the server synchronizes it into an instance-owned bare repository, serves a detached worktree through one per-instance Pitchfork supervisor and its loopback proxy, and prints a native `<id>.<instance>.localhost` app URL only after it answers. Pitchfork assigns and bumps each daemon's port. A newly created server pins the build that created it under its instance ID, without replacing binaries used by existing instances.
- 8e20cf9: Ship native self-contained CLI and server executables in the npm package for macOS arm64 and Linux x64. Installation needs Node, but running either command needs neither Node nor Bun.
- 8e20cf9: Attach `devver new server` to the instance it creates and print the ready URL, so no manual attach step follows creation.
- 8e20cf9: Rename the npm package from `@devver/cli` to `@devver-inc/cli`. Install with `npm install -g @devver-inc/cli`. The GitHub org owns this scope, and publishing moves to npm trusted publishing.
- 8e20cf9: Move the terminal UI into the CLI package, connect organization and project selection to the authenticated CLI, remove fabricated deployment previews, and update OpenTUI to 0.6.8.
- 8e20cf9: Add `devver server stop` to halt a supervised instance while preserving its state, and `devver server remove` to stop and delete an instance after an explicit confirmation.

### Patch Changes

- 8e20cf9: Explain that creating a supervised server needs a packaged build, and print expected server-creation failures without stack traces.
- 8e20cf9: Explain how to fix local deploy failures outside a Git repository or before its first commit.
- 8e20cf9: Require `--yes` for non-interactive server removal and allow it to bypass the interactive confirmation.
- 8e20cf9: Show only deployments from the current Git checkout in the local TUI, while keeping the full server list for non-Git workspaces.
- 8e20cf9: Treat stopping an already-stopped server as success, so `devver server stop` and `remove` work on instances whose process already died.
- 8e20cf9: Keep ordinary local deployments as independent roots instead of inventing parent-child links from repository order.
- 8e20cf9: Show the server creation error message without printing nested error causes. Keep the packaged-build hint when creating a server from source.
- 8e20cf9: Show real local deployment statuses in the TUI, grouped by checkout when Git identifies one. Distinguish empty, unavailable, and failed listings.
- 8e20cf9: Show the selected local instance and invocation workspace in the TUI without requiring cloud authentication. Keep the TUI unselected when no target is configured.
- 8e20cf9: Recognize global npm installations with a nested platform package when checking for updates.
- 8e20cf9: Split the native executables into per-platform npm packages, `@devver-inc/cli-darwin-arm64` and `@devver-inc/cli-linux-x64`, which `@devver-inc/cli` pins as optional dependencies. A single tarball carrying both targets exceeded the npm size limit. `npm install -g @devver-inc/cli` is unchanged and now downloads only the matching platform.
- 8e20cf9: Add an opt-in `devver deploy --open` flag to open the deployed local app URL after a successful deployment.
- 8e20cf9: Package checksum-verified Pitchfork and Websitino binaries alongside the server for isolated local static serving.
- 8e20cf9: Reuse the API client across terminal UI requests while keeping organization credentials current.
- 8e20cf9: Make local deploy output concise by default, with deployment details available through --verbose. Generate a static directory config for HTML-only sites on explicit `devver init` instead of unusable Bun service commands.
