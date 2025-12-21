# Devver CLI

The command-line interface for [Devver](https://devver.app) — a unified platform that streamlines collaboration between developers and stakeholders through ultra-fast deployments and contextual visual feedback.

## What is Devver?

Devver addresses a critical pain point in software development: the fragmented, slow feedback loop between developers and stakeholders (POs, clients, project managers). Traditional workflows suffer from:

- **Slow validation cycles** — Days between code changes and client testing
- **Scattered communication** — Feedback spread across emails, screenshots, and chat messages
- **Imprecise bug reports** — "The button in the top right doesn't work" with no context
- **Long deployment times** — 3-20 minute CI/CD pipelines for simple CSS tweaks

Devver solves this by enabling **deployments in under 30 seconds** and providing **contextual visual feedback** directly on the tested interface.

## Key Features

### Ultra-Fast Deployments
- Deploy changes in **2-10 seconds** instead of 30-120 seconds with traditional Docker rebuilds
- Git-based diff detection — only transfer modified files
- Content-addressable storage with automatic deduplication
- Smart dependency detection — skip `npm install` when `package.json` hasn't changed

### Visual Feedback Toolbox
- Clients annotate the app directly in the browser (inspired by Figma)
- Automatic capture: screenshots, 30-second video replay, JS console logs, network requests
- No SDK required — zero code pollution in your project

### Intelligent Ticketing
- Every comment auto-generates a rich ticket with full technical context
- Complete workflow: New → In Progress → Ready for Test → Validated
- Before/after visual comparison for quick validation

## CLI Usage

> **Note**: The CLI is under active development. Commands will be documented as they are implemented.

### Installation

```bash
# Build from source
cargo build --release

# The binary will be at ./target/release/devver-cli
```

### Help

```bash
devver-cli --help
```

## Architecture

```
src/
├── main.rs    # Entry point and mode selection
├── cli.rs     # Command-line interface (clap)
├── tui.rs     # Interactive terminal UI (ratatui)
└── shared.rs  # Common business logic and state
```

### Why Rust?

- **Native performance** — Exceptional speed with no garbage collector overhead
- **Memory safety** — Rust's ownership model prevents common bugs
- **Easy distribution** — Single static binary, no runtime dependencies
- **Cross-platform** — Compile once, run anywhere

## How It Works

1. **Init**: `devver-cli init` detects your project type and creates a configuration
2. **Setup**: Clones your repository to the Devver server via SSH
3. **Deploy**: Pushes only changed files using Git's native delta transfer
4. **Access**: Get a unique URL per branch (e.g., `feature-auth.myproject.devver.app`)

The CLI communicates with the Devver server using SSH authentication — a battle-tested protocol with 20+ years of security auditing.

## Target Users

- **Developers** — Deploy and iterate in seconds, not minutes
- **Product Owners** — Test features immediately, give precise feedback
- **Clients** — Preview changes in real-time, validate with one click
- **QA Teams** — Test multiple branches in parallel without conflicts

## Team

| Name | Role |
|------|------|
| Hoareau Steevy (AL) | PM & CLI Lead |
| De Souza Morais Gabriel (AL) | Backend Lead |
| Sedjai Fethi (AL) | Frontend Lead |
| Rusescu Alexandru (AL) | DevOps & Documentation Lead |
| Rouviere Victor (SRC) | Architecture & Infrastructure Lead |

## Links

- **Website**: [devver.app](https://devver.app)
- **Dashboard Prototype**: [devver.vercel.app](https://devver.vercel.app)
- **GitHub Organization**: [github.com/Devver-Inc](https://github.com/Devver-Inc)
- **Contact**: info@devver.app

## Tech Stack

| Component | Technology |
|-----------|------------|
| CLI | Rust + Clap |
| Backend | TypeScript + NestJS |
| Frontend | TypeScript + Vite + React |
| Landing Page | Astro |
| Infrastructure | Kubernetes on Proxmox |
| Provisioning | Terraform + Ansible |
| CI/CD | GitHub Actions |
| Process Manager | PM2 |
| Reverse Proxy | Nginx + HAProxy |

## Building

```bash
# Debug build
cargo build

# Release build (optimized)
cargo build --release

# Run tests
cargo test
```

## License

Copyright (c) Hoareau Steevy <shoareau@dev-id.fr>

This project is licensed under the MIT License — see the [LICENSE](./LICENSE) file for details.
