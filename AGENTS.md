# AGENTS.md - Devver CLI

Guidelines for AI coding agents working in this Rust CLI codebase.

## Project Overview

Devver CLI is a command-line tool with both TUI (terminal UI) and standard CLI modes. Built with:
- **clap** - Argument parsing with derive macros
- **ratatui** - Terminal user interface
- **color-eyre** - Error handling and reporting
- **reqwest** - HTTP client (blocking, with rustls)
- **serde/serde_json** - Serialization

## Build & Test Commands

```bash
# Build
cargo build                    # Debug build
cargo build --release          # Release build
cargo build --profile dist     # Optimized dist build (thin LTO)

# Run
cargo run -- --help            # Run with args
cargo run -- --interactive     # Run TUI mode

# Test
cargo test                     # Run all tests
cargo test <test_name>         # Run single test by name
cargo test <module>::          # Run tests in module
cargo test -- --nocapture      # Show stdout during tests

# Lint & Format
cargo fmt                      # Format code
cargo fmt --check              # Check formatting (CI)
cargo clippy                   # Run lints
cargo clippy --fix --allow-dirty  # Auto-fix lints

# Combined check (recommended before commit)
task check                     # Runs: fmt --check, clippy, test

# Auto-fix issues
task fix                       # Runs: fmt, clippy --fix
```

## Code Style Guidelines

### Imports

Order imports in this sequence, separated by blank lines:
1. Standard library (`std::`)
2. External crates
3. Crate-internal (`crate::`, `super::`)

```rust
use std::time::Duration;

use clap::{Parser, Subcommand};
use color_eyre::Result;

use crate::shared::SharedLogic;
```

Use grouped imports from the same crate:
```rust
use ratatui::{
    DefaultTerminal, Frame,
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
};
```

### Error Handling

- Use `color_eyre::Result` as the standard Result type
- Propagate errors with `?` operator
- Install color_eyre at program start: `color_eyre::install()?`
- For non-critical operations, return descriptive error messages instead of panicking

```rust
use color_eyre::Result;

fn example() -> Result<()> {
    let data = fetch_data()?;
    Ok(())
}
```

### Types & Structs

- Derive common traits: `#[derive(Debug, Default)]` where applicable
- Use `#[derive(Clone, Copy, PartialEq)]` for simple enums
- Implement `Default` trait for structs with sensible defaults
- Prefer `Option<T>` over sentinel values

```rust
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub enum Mode {
    #[default]
    Normal,
    Command,
}
```

### Naming Conventions

- **Structs/Enums**: PascalCase (`AppState`, `InstallMethod`)
- **Functions/Methods**: snake_case (`handle_command`, `process_hello`)
- **Constants**: SCREAMING_SNAKE_CASE (`CURRENT_VERSION`, `REQUEST_TIMEOUT`)
- **Modules**: snake_case (`shared`, `update`)

### Function Style

- Keep functions focused and small
- Use `&self` for read-only methods, `&mut self` when state changes
- Return `Result<T>` for fallible operations
- Use `Option<&str>` for optional string parameters

```rust
pub fn process_hello(&self, name: Option<&str>) -> String {
    match name {
        Some(n) => format!("Hello, {}!", n),
        None => "Hello, World!".to_string(),
    }
}
```

### Pattern Matching

Prefer exhaustive match statements:
```rust
match method {
    InstallMethod::Brew => { /* ... */ }
    InstallMethod::Cargo => { /* ... */ }
    InstallMethod::Unknown => {}
}
```

### String Handling

- Use `format!()` for string construction
- Use `to_string()` to convert `&str` to `String`
- Use `.as_deref()` to convert `Option<String>` to `Option<&str>`

## Architecture Patterns

### Module Structure

```
src/
  main.rs      # Entry point, mode dispatch
  cli.rs       # CLI argument parsing and handling
  tui.rs       # Terminal UI application
  shared.rs    # Shared logic between CLI and TUI
  update.rs    # Auto-update functionality
```

### Shared Logic Pattern

Business logic lives in `shared.rs` and is used by both CLI and TUI:
```rust
pub struct SharedLogic {
    pub state: AppState,
}

impl CommandHandler for SharedLogic {
    fn handle_command(&mut self, command: &str, args: Vec<String>) -> Result<String>;
}
```

### clap CLI Definition

Use derive macros for CLI structure:
```rust
#[derive(Parser, Debug)]
#[command(name = "devver-cli")]
#[command(version)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Option<Commands>,
    
    #[arg(short, long)]
    pub interactive: bool,
}
```

## Git & Commits

This project uses **conventional commits** for automated releases:

| Prefix | Version Bump | Example |
|--------|--------------|---------|
| `feat:` | minor | `feat: add deploy command` |
| `fix:` | patch | `fix: handle empty config` |
| `feat!:` / `fix!:` | major | `feat!: change API` |
| `docs:`, `chore:`, `refactor:`, `test:`, `ci:` | none | Tracked in changelog |

Pre-commit hooks run `cargo fmt` and `cargo clippy` automatically (via cargo-husky).

## CI Checks

All PRs must pass:
1. `cargo fmt -- --check` (formatting)
2. `cargo clippy` (lints)
3. `cargo test --locked --all-features --all-targets` (tests on macOS + Windows)
4. `cargo doc --no-deps --all-features` (documentation builds)

## Important Notes

- Edition 2024 Rust - use latest language features
- No OpenSSL dependency - uses `rustls-tls` for HTTP
- TUI mode is default when no command provided
- Auto-update detects install method (brew/cargo) from binary path
