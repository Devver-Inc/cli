function help() {
	console.log(`
devver-cli-opentui

Usage:
bun dev                    # Run in TUI mode (interactive)
bun dev -H -m "message"    # Run in headless mode (CLI)
bun dev --headless -m "your text"

Options:
-H, --headless    Run in non-interactive CLI mode
-m, --message     Message to process (for headless mode)
-h, --help        Show this help message
`);
	process.exit(0);
}
