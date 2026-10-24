# Browse local deployments in the TUI

A developer with an attached server can browse the current Git checkout's deployments, select one, and open its ready URL. If the server becomes unreachable, the TUI explains what to check.

## Sub-features

- The list shows the current checkout's deployment IDs and statuses without showing ready URLs in the rows.
- `j` selects the next deployment, `o` opens its ready URL, and `q` exits.
- `c` sends a selected ready URL to the clipboard. Clipboard support and acceptance vary by host and terminal; this recipe does not write to the operator's clipboard.
- A failed listing suggests `devver server status` rather than claiming that the server has no deployments.

## How to get to it (user POV)

Attach a local server, deploy from a Git checkout, and run `devver tui` from that checkout. Use `j` to move to the next row and `o` to open its URL.

## Driving it with Bash

Run `bash .pi/skills/verify-devver-cli/verify.sh tui` on macOS or Linux with Bun, Git, curl, and Python 3. The helper starts one isolated server, deploys the same committed fixture twice, and opens the TUI in a disposable pseudo-terminal. It sends `j`, `o`, and `q`. An isolated `open` or `xdg-open` stub records the selected URL instead of starting a real browser. The helper fetches that URL separately and checks that `tui-opened.txt` contains the second deployment's exact URL. It then stops the server and starts the TUI again to check the unreachable-server message. `tui-list-open.txt` and `tui-unreachable.txt` retain the terminal output. `actions.txt` must end in `PASS tui`.

## Gotchas

The TUI driver captures raw terminal escape sequences. Check `tui-second-deploy.txt`, `tui-opened.txt`, and `tui-second-response.html` together; a rendered row alone does not prove that opening reached the right deployment. The helper does not test the real host clipboard, OSC 52 acceptance, or cloud selectors. The separate TUI component tests cover copy-key success and failure with a fake clipboard.
