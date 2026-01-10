# Devver CLI

The command-line interface for [Devver](https://devver.app) — ultra-fast deployments and contextual visual feedback.

> **Warning**: This CLI is under active development. Commands and APIs may change without notice.

## Installation

### Homebrew (macOS / Linux)

```bash
brew tap Devver-Inc/tap
brew install devver-cli
```

### Cargo

```bash
cargo install devver-cli
```

### From Source

```bash
git clone https://github.com/Devver-Inc/cli.git
cd cli
cargo build --release
# Binary at ./target/release/devver-cli
```

## Usage

```bash
devver-cli --help
devver-cli --version
```

## Development

```bash
# Build
cargo build

# Test
cargo test

# Run
cargo run -- --help
```

## Releasing

This project uses automated releases. You never manually tag or bump versions.

### How it works

1. Push commits to `main` using [conventional commits](https://www.conventionalcommits.org/)
2. `release-plz` automatically creates a Release PR with:
   - Version bump in `Cargo.toml`
   - Updated `CHANGELOG.md`
3. **Merge the Release PR** when ready to ship
4. Automation handles the rest:
   - Publishes to crates.io
   - Creates GitHub Release with binaries (macOS, Linux, Windows)
   - Updates Homebrew tap

### Commit types and version bumps

| Commit | Example | Version bump |
|--------|---------|--------------|
| `feat:` | `feat: add deploy command` | minor (0.1.0 → 0.2.0) |
| `fix:` | `fix: handle empty config` | patch (0.1.0 → 0.1.1) |
| `feat!:` | `feat!: change API` | major (0.1.0 → 1.0.0) |

### Other commit types (no version bump, but tracked in changelog)

- `docs:` — documentation changes
- `chore:` — maintenance tasks
- `refactor:` — code refactoring
- `test:` — adding tests
- `ci:` — CI/CD changes

## License

MIT — see [LICENSE](./LICENSE)
