# Devver CLI - Design Document

> Design template for MVP. Based on [clig.dev](https://clig.dev) and [bettercli.org](https://bettercli.org).

---

## 1. Overview

**Product**: devver-cli  
**Purpose**: Ultra-fast deployments and visual feedback for Devver  
**Modes**: CLI (non-interactive) + TUI (interactive)

### MVP Scope

- [x] Distribution setup (Homebrew, Cargo, binaries) — DEV-80, DEV-97, DEV-98
- [x] CI/CD for versioning and changelog — DEV-100
- [ ] Authentication via Logto (OAuth flow) — DEV-79, DEV-87
- [ ] Project listing & management — DEV-34
- [ ] TUI basic functionality

### Out of Scope (Post-MVP)

- Fetch comments from deployments — DEV-42
- Access control management via CLI — DEV-65
- Linear sync via CLI

---

## 2. Philosophy Checklist

From clig.dev - tick what applies to your design:

- [x] **Human-first design**: Commands readable by humans, not just scripts
- [x] **Simple parts that work together**: Composable with pipes, other tools
- [x] **Consistency**: Follow existing CLI conventions users already know
- [x] **Say just enough**: Not too verbose, not too silent
- [x] **Ease of discovery**: Users can learn without reading docs
- [x] **Conversation as the norm**: Helpful errors, suggestions, progressive disclosure
- [x] **Robustness**: Handles unexpected input gracefully
- [x] **Empathy**: Feels like the tool is on the user's side

---

## 3. Command Structure

### 3.1 Command Naming Convention

Choose ONE style and stick to it:

| Style | Example | When to use |
|-------|---------|-------------|
| Verb-noun | `devver deploy app` | Most common, intuitive |
| Noun-verb | `devver app deploy` | When entity is primary |
| Flat | `devver deploy` | Simple tools |

**Decision**: Verb-noun style (e.g., `devver auth login`, `devver project list`)

### 3.2 Command Hierarchy

```
devver-cli
├── auth                    # Authentication
│   ├── login              # Login via Logto (browser OAuth)
│   ├── logout             # Clear credentials
│   └── status             # Show auth status
├── project                 # Project management
│   ├── list               # List all projects
│   ├── create             # Create new project
│   ├── deploy             # Deploy a project
│   └── info <id>          # Project details
├── config                  # Configuration management
│   ├── get <key>
│   ├── set <key> <value>
│   └── list
└── (no args)               # → TUI mode (default)
```

### 3.3 MVP Commands

| Command | Description | Priority | Linear Issue |
|---------|-------------|----------|--------------|
| `devver` (no args) | Launch TUI | P0 | - |
| `devver --help` | Show help | P0 | - |
| `devver --version` | Show version | P0 | ✅ Done |
| `devver auth login` | Authenticate via Logto | P0 | DEV-87 |
| `devver auth logout` | Clear credentials | P0 | DEV-79 |
| `devver auth status` | Show login status | P1 | DEV-79 |
| `devver project list` | List projects | P1 | DEV-34 |
| `devver project info <id>` | Show project details | P1 | DEV-34 |
| `devver update` | Self-update CLI | P2 | DEV-99 |

---

## 4. Arguments & Flags

### 4.1 Global Flags

| Flag | Short | Description | Default |
|------|-------|-------------|---------|
| `--help` | `-h` | Show help | - |
| `--version` | `-V` | Show version | - |
| `--interactive` | `-i` | Force TUI mode | false |
| `--quiet` | `-q` | Suppress non-essential output | false |
| `--verbose` | `-v` | Increase output verbosity | false |
| `--no-color` | - | Disable colored output | false |
| `--json` | - | Output as JSON (machine-readable) | false |

### 4.2 Flag Conventions

- **Boolean flags**: `--flag` (not `--flag=true`)
- **Value flags**: `--flag=value` or `--flag value`
- **Short flags can be combined**: `-qv` = `-q -v`
- **Positional args**: Only for the most common required values
- **`--` separator**: Everything after is passed as-is

### 4.3 Command-Specific Flags

_Document per-command flags here as you design them._

---

## 5. Output Design

### 5.1 Output Destinations

| Stream | Content | Example |
|--------|---------|---------|
| `stdout` | Primary output, machine-readable data | Command results, JSON |
| `stderr` | Progress, logs, errors, warnings | Spinners, error messages |

### 5.2 Output Modes

| Mode | When | Example |
|------|------|---------|
| **Default** | TTY detected | Colors, spinners, formatted tables |
| **Plain** | Piped / `--plain` | No colors, simple text |
| **JSON** | `--json` flag | Structured data for scripting |
| **Quiet** | `-q` flag | Errors only |
| **Verbose** | `-v` flag | Debug information |

### 5.3 Color Usage

| Color | Meaning | Usage |
|-------|---------|-------|
| Green | Success | ✓ checkmarks, "done" messages |
| Yellow | Warning | ⚠ warnings, important notices |
| Red | Error | ✗ errors, failures |
| Blue/Cyan | Info | Links, highlighted values |
| Bold | Emphasis | Command names, important values |
| Dim | De-emphasis | Hints, secondary info |

**Disable colors when**:
- `NO_COLOR` env is set
- `--no-color` flag passed
- Output is not a TTY
- `TERM=dumb`

### 5.4 Progress Indication

_For long-running operations:_

- [ ] Spinner for indeterminate progress
- [ ] Progress bar for determinate progress
- [ ] Status text updates
- [ ] Time estimates when possible

---

## 6. Error Handling

### 6.1 Exit Codes

| Code | Meaning | When |
|------|---------|------|
| 0 | Success | Command completed successfully |
| 1 | General error | Unspecified failure |
| 2 | Usage error | Invalid arguments, missing required params |
| _N_ | _Specific error_ | _Define as needed_ |

### 6.2 Error Message Format

```
Error: <brief description>

<details / context>

Hint: <what to do next>

For more info, run: devver <command> --help
```

### 6.3 Error Principles

- [ ] Never show stack traces by default (use `--verbose`)
- [ ] Suggest fixes when possible
- [ ] Link to docs for complex errors
- [ ] Be specific: "File not found: config.toml" not "Error reading config"
- [ ] Use stderr for errors, stdout stays clean

---

## 7. Help System

### 7.1 Help Levels

| Invocation | Shows |
|------------|-------|
| `devver` (no args, no TTY) | Brief usage hint |
| `devver --help` | Full help with all commands |
| `devver <cmd> --help` | Command-specific help with examples |

### 7.2 Help Page Structure

```
<description - one line>

Usage:
  devver <command> [options]

Commands:
  <command>    <description>

Options:
  <flag>       <description>

Examples:
  $ devver <example command>
  $ devver <another example>

Learn more: https://devver.app/docs/cli
```

### 7.3 Help Principles

- [ ] Lead with examples
- [ ] Most common commands/flags first
- [ ] One-line descriptions (detail in `--help`)
- [ ] Link to web docs for more

---

## 8. Configuration

### 8.1 Configuration Sources (Priority Order)

1. Command-line flags (highest)
2. Environment variables
3. Local config file (`.devver.toml` in project)
4. Global config file (`~/.config/devver/config.toml`)
5. Defaults (lowest)

### 8.2 Environment Variables

| Variable | Description | Equivalent flag |
|----------|-------------|-----------------|
| `DEVVER_API_KEY` | API authentication | - |
| `DEVVER_CONFIG` | Custom config path | `--config` |
| `NO_COLOR` | Disable colors | `--no-color` |
| _more..._ | | |

### 8.3 Config File Format

```toml
# ~/.config/devver/config.toml

# Example structure - define based on your needs
[general]
# option = "value"

[defaults]
# default_option = "value"
```

---

## 9. TUI Mode

### 9.1 TUI Entry Points

| Trigger | Action |
|---------|--------|
| `devver` (no args, TTY) | Launch TUI |
| `devver -i` / `--interactive` | Force TUI mode |
| `devver <cmd> -i` | Command in TUI context |

### 9.2 TUI Principles

- [ ] **Keyboard-first**: All actions via keyboard
- [ ] **Vim-style optional**: `j/k` for navigation alongside arrows
- [ ] **Discoverable**: Show key hints on screen
- [ ] **Escapable**: `q` or `Esc` to quit/back
- [ ] **Responsive**: Works in small terminals (min 80x24)

### 9.3 Key Bindings (Conventions)

| Key | Action |
|-----|--------|
| `q` / `Esc` | Quit / Back |
| `?` | Help overlay |
| `Enter` | Select / Confirm |
| `Tab` | Next section |
| `↑/↓` or `j/k` | Navigate list |
| `/` | Search / Filter |

### 9.4 TUI ↔ CLI Parity

_Principle: Anything doable in TUI should be doable in CLI and vice versa._

| TUI Action | CLI Equivalent |
|------------|----------------|
| _TUI action_ | `devver <command>` |

---

## 10. Interactivity Guidelines

### 10.1 When to Prompt

- **Do prompt**: Destructive actions, first-time setup, ambiguous input
- **Don't prompt**: When `--yes` / `-y` flag passed, when not a TTY, in CI

### 10.2 Prompt Design

```
? Question text (default value) [y/N]: 
```

- Show default in parentheses
- Capitalize the default option: `[y/N]` means N is default
- Accept `y`, `yes`, `n`, `no` (case-insensitive)

### 10.3 Non-Interactive Mode

```bash
# Skip all prompts with defaults
devver deploy --yes

# Or via environment
CI=true devver deploy
```

---

## 11. Robustness Checklist

- [ ] **Idempotent where possible**: Running twice = same result
- [ ] **Atomic operations**: All-or-nothing, no partial states
- [ ] **Graceful degradation**: Work offline if possible
- [ ] **Signal handling**: Clean up on SIGINT (Ctrl+C)
- [ ] **Timeout handling**: Don't hang forever
- [ ] **Input validation**: Validate before acting
- [ ] **Confirmation for destructive actions**: Unless `-y` passed

---

## 12. Distribution & Installation

### 12.1 Installation Methods (Priority for MVP)

| Method | Priority | Platform |
|--------|----------|----------|
| Homebrew | P0 | macOS, Linux |
| Cargo install | P0 | Cross-platform |
| Direct download | P1 | All |
| Package managers | P2 | apt, dnf, etc. |

### 12.2 Binary Naming

- Primary: `devver-cli` (crate name)
- Alias: Consider `devver` symlink for convenience

### 12.3 Shell Completions

- [ ] Bash
- [ ] Zsh
- [ ] Fish
- [ ] PowerShell

---

## 13. Versioning & Updates

### 13.1 Version Display

```bash
$ devver --version
devver-cli 0.1.0
```

### 13.2 Update Notifications

_Optional: Notify when new version available_

```
A new version of devver-cli is available: 0.2.0 (current: 0.1.0)
Run `brew upgrade devver-cli` to update.
```

**Rules**:
- Check at most once per day
- Cache result
- Don't block command execution
- Respect `DEVVER_NO_UPDATE_CHECK=1`

---

## 14. MVP Decision Log

_Track key design decisions here:_

| Decision | Choice | Rationale | Date |
|----------|--------|-----------|------|
| Command style | Verb-noun | Most intuitive for users (`devver auth login`) | 2026-01-10 |
| Auth method | Logto OAuth | Consistent with web platform, SSO support | 2026-01-10 |
| Distribution | Homebrew + Cargo + Binaries | Cover macOS, Linux, Windows | 2026-01-10 |
| TUI default | No args → TUI | Power users get rich interface by default | 2026-01-10 |

---

## 15. References

- [Command Line Interface Guidelines](https://clig.dev)
- [Better CLI](https://bettercli.org)
- [12 Factor CLI Apps](https://medium.com/@jdxcode/12-factor-cli-apps-dd3c227a0e46)
- [Clap (Rust CLI library)](https://docs.rs/clap)
- [Ratatui (Rust TUI library)](https://ratatui.rs)

---

## Appendix A: Quick Reference Card

### Must Have (P0)

- [x] `--help` / `-h` works
- [x] `--version` / `-V` works
- [x] Exit code 0 on success, non-zero on failure
- [x] Errors go to stderr
- [x] Respect `NO_COLOR`
- [x] Works when piped (no TTY)

### Should Have (P1)

- [ ] JSON output option
- [ ] Quiet mode (`-q`)
- [ ] Verbose mode (`-v`)
- [ ] Config file support
- [ ] Shell completions

### Nice to Have (P2)

- [ ] Update notifications
- [ ] Man pages
- [ ] Telemetry (opt-in only)

---

## Appendix B: Linear Issue Mapping

| Linear ID | Title | Status | CLI Command |
|-----------|-------|--------|-------------|
| DEV-80 | Téléchargement du cli | ✅ Done | Distribution |
| DEV-97 | Publishing to Homebrew | ✅ Done | `brew install` |
| DEV-98 | Release Binaries | ✅ Done | Direct download |
| DEV-100 | CI/CD for version change | ✅ Done | Automation |
| DEV-99 | Auto-update of the cli | Todo | `devver update` |
| DEV-79 | Connexion au compte | Todo | `devver auth *` |
| DEV-87 | Se connecter via Logto | Todo | `devver auth login` |
| DEV-34 | Requêtes des projets CLI | Backlog | `devver project *` |
| DEV-42 | Fetch des commentaires | Backlog | Post-MVP |
| DEV-65 | Access control via CLI | Backlog | Post-MVP |
