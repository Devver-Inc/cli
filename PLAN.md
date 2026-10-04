# TUI deployment tree redesign

## Context
- The current TUI is a centered welcome screen (`src/tui/app.tsx`). The screenshot is backed by the existing `tui-vision.html`: a 10-node mock deployment tree with parent links, details, feedback/diff tabs, status colors, and keyboard shortcuts.
- User wants mock data in v1, fully working navigation, and static-but-centralized theme and shortcut definitions for future customization. Keep this prototype quick to adjust. Make ancestor/child connectors and the selected path clearer than the browser mock. Show the actual app version at the bottom right.

## Approach
- Port the mock nodes/relationships and relevant detail content from `tui-vision.html` into terminal-friendly data; render a compact two-column view at wide widths and switch between tree/details with Tab at narrow widths. Use connected tree glyphs with continuous ancestor lines, selection and ancestor highlighting. Keep selection visible in a bounded scrollable tree.
- Centralize color tokens in a static theme module and action-to-key bindings in a static shortcut table; dispatch actions from one `useKeyboard` handler for now. Include `j/k` and arrows for selection, `f/d` for feedback/diff, `b` to change comparison base, Tab to switch narrow panes, and `q`/Ctrl+C to exit. Only advertise working shortcuts; defer `c/r/o/p`, rename prompts, browser opening, and project switching. Avoid a new dependency or user settings until actual remapping/modes are needed.
- Keep renderer lifecycle in `src/tui/index.tsx`; pass the existing version string into the TUI through `src/cli/tui.ts` rather than hardcoding a version or running git from the view. Confirm which mock actions are in scope.

## Files to modify
- `src/tui/app.tsx` — layout, mock data/topology, navigation, and details.
- `src/tui/theme.ts` and `src/tui/keys.ts` — static palette and shortcut/action definitions (names provisional).
- `src/cli/tui.ts`, `src/tui/index.tsx` — supply existing version to footer.
- `tests/tui.test.tsx` — regression checks for tree/selection/navigation.

## Reuse
- Existing `App` / `run` split in `src/tui/app.tsx` and `src/tui/index.tsx`; React `useKeyboard` and `useTerminalDimensions` from `@opentui/react`; `testRender`/mockInput in `tests/tui.test.tsx`.
- `tui-vision.html` is the source of mock copy and topology. `@opentui/keymap` is not installed; a central static key table avoids adding it prematurely.
- `src/cli/version.ts` already formats the stamped package version; `src/cli/index.ts` imports `package.json` for the CLI version. Reuse that formatting for the TUI footer.

## Steps
- [x] Confirm mock-data scope and future-ready static theme/shortcut organization.
- [x] Defer screenshot's non-navigation controls (`c`, `r`, `o`, `p`) as agreed for this UI trial; narrow view switches panes with Tab.
- [x] Model mock parent relationships and derive tree connector/prefix per node; implement readable tree rows, visible selection/ancestor path, scrolling, and responsive layout.
- [x] Wire selection, tabs, comparison, and agreed mock actions via centralized shortcuts; update selected details, help bar, and bottom-right version.
- [x] Add focused renderer/input regression tests for connectors, selection, feedback/diff and comparison base, narrow pane switching, exit, and version.

## Verification
- `bun run check`, `bun run typecheck`, `bun test`; manually inspect narrow/wide terminal renderings, selected-path connectors, navigation/scrolling, and bottom-right version. Preserve the existing renderer-lifecycle probe.
