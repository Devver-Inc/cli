# Devver CLI

A Rust CLI application with both interactive TUI mode and command-line interface, sharing common logic between modes.

## Features

- **Interactive Mode**: Full-featured terminal UI with ratatui
- **CLI Mode**: Command-line interface with clap
- **Shared Logic**: Common business logic reused between modes
- **Project Management**: Add, list, and remove projects

## Usage

### Interactive Mode

```bash
devver-cli --interactive
# or simply
devver-cli -i
```

### CLI Mode

```bash
# List all projects
devver-cli list

# Add a new project
devver-cli add "My Project" "/path/to/project"

# Remove a project
devver-cli remove "My Project"

# Show status
devver-cli status
```

## Interactive Mode Controls

- `:` - Enter command mode
- `l` - View project list
- `q` - Quit application
- `Esc` - Exit current mode
- In project list:
  - `↑/↓` - Navigate
  - `d` - Delete selected project

## Architecture

The project is organized into modules:

- `shared.rs` - Common business logic and state management
- `cli.rs` - Command-line interface handling
- `tui.rs` - Interactive terminal user interface
- `main.rs` - Application entry point and mode selection

## Building

```bash
cargo build --release
```

## Running

```bash
./target/release/devver-cli --help
```

## License

Copyright (c) Hoareau.Steevy <shoareau@dev-id.fr>

This project is licensed under the MIT license ([LICENSE] or <http://opensource.org/licenses/MIT>)

[LICENSE]: ./LICENSE
