# Devver CLI verification map

This map lists the CLI flows covered by the isolated foreground-server harness. Run the command from the repository root. Each run builds the npm artifact, starts its own server, and retains evidence in the printed `devver-verify-proof.*` directory. A feature passes only when `actions.txt` ends with `PASS <feature>` and its separate observations agree. Do not treat an unrun entry point as verified.

- [Attach and detach](attach.md). Select a verified local server, inspect status, then clear the target.
- [Deploy a static page](deploy.md). Deploy committed HEAD through the attached target and fetch the actual app URL.
- [Switch to cloud](switch.md). Replace a local target with the official cloud selection without contacting cloud.
- [Browse local deployments in the TUI](tui.md). Select and open a ready deployment from a real attached server, then check the unreachable state.

The helper uses isolated XDG state on macOS and Linux. Windows state uses `%LOCALAPPDATA%`; this skill and the active CI matrix do not cover Windows. It does not cover supervised `devver new server`, npm without Bun, standalone without Node or Bun, real clipboard writes, or Logto cloud deployment. For release acceptance, run `tests/static-deploy-artifacts.test.ts` on macOS and Linux. The source CLI proof here does not replace the packaged artifact test.
