# react

To install dependencies:

```bash
bun install
```

To run the source with automatic restarts: `bun run dev`.

To keep a local standalone `devver` executable rebuilt as you edit (without replacing your globally installed CLI):

```bash
bun run dev:build                 # keep this running in one terminal
export PATH="$PWD:$PATH"          # in another terminal, from the repo root
devver --version                  # runs the freshly built ./devver
```

The watcher rebuilds the executable; an already-running `devver` process does not restart. For automatic process restarts, use `bun run dev` instead. The watch-built executable reports the `dev` channel; release builds use `scripts/build.ts` for stamped version and commit.

This project was created using `bun create tui`. [create-tui](https://git.new/create-tui) is the easiest way to get started with OpenTUI.

# Stable and nightly builds

`main` stays stable and can receive hotfixes. Merge work into `develop` for nightly testing; merge stable fixes forward into `develop`. The nightly workflow checks `develop` daily (or manually) and publishes only if its commit differs from the last published nightly; skipped days are fine. Nightlies are **public and unstable**; they do not update npm `latest`, the stable GitHub release, or Homebrew.

```bash
npm install -g @devver/cli@nightly  # requires Node >=26.4
npm install -g @devver/cli          # stable
```

For CI without Node, find a `nightly-*` tag on the [GitHub Releases page](https://github.com/Devver-Inc/cli/releases), then pin that tag for reproducible installs with mise's GitHub backend:

```toml
# mise.toml
[tools."github:Devver-Inc/cli"]
version = "nightly-1.2.1-nightly.RUN_ID.ATTEMPT"
version_prefix = ""
prerelease = true
```

Replace the example version with an actual nightly release tag, then run `mise install` and `mise exec -- devver --version`. The empty `version_prefix` tells mise not to prepend `v` to the `nightly-*` tag. `devver --version` and the TUI display the running version and commit. Do not use mise `@latest` for CI: it normally excludes prereleases. To ship an urgent stable fix, apply it to `main`, use the existing Release Please release flow, then forward-merge it to `develop`.

# Release Process

This project uses automated release management with the following tools:

## Tools

- **release-please**: Automates version bumps, changelog generation, and release PR creation
- **git-cliff**: Generates beautiful changelogs from conventional commits
- **GitHub Actions**: Automates the entire release pipeline

## How it Works

### 1. Conventional Commits

All commits must follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:

```
<type>(<scope>): <description>

[optional body]

[optional footer(s)]
```

**Types:**
- `feat`: New feature (triggers minor version bump)
- `fix`: Bug fix (triggers patch version bump)
- `refactor`: Code refactoring
- `docs`: Documentation changes
- `perf`: Performance improvements
- `style`: Code style changes
- `test`: Test additions or changes
- `chore`: Maintenance tasks
- `ci`: CI/CD changes

**Breaking Changes:**
- Add `!` after type: `feat!: breaking change`
- Or include `BREAKING CHANGE:` in commit footer (triggers major version bump)

**Examples:**
```bash
feat(auth): add OAuth2 support
fix(api): resolve timeout issue in production
docs: update installation guide
refactor(core)!: rename main config file
```

### 2. Automatic Release PR

When commits are pushed to `main`:

1. **release-please** analyzes commits since the last release
2. Calculates the next version based on conventional commit types
3. Generates/updates a CHANGELOG.md
4. Creates/updates a Release PR with version bumps

### 3. Merging the Release PR

When you merge the Release PR:

1. release-please creates a git tag (e.g., `v1.2.3`)
2. Pushes the tag to trigger the release workflow

### 4. Release Workflow

The release workflow automatically:

1. **Builds** standalone binaries for:
   - macOS (Intel and Apple Silicon)
   - Linux (x86_64 and ARM64)
   - Windows (x86_64)

2. **Creates** a GitHub Release with:
   - Release notes from CHANGELOG.md
   - Binary artifacts for all platforms
   - SHA256 checksums

3. **Publishes** to npm (requires `NPM_TOKEN` secret)

4. **Updates** Homebrew tap (if homebrew-tap repo exists)

## Setup Requirements

### Required Secrets

Add these secrets in GitHub Settings → Secrets and variables → Actions:

- `NPM_TOKEN`: npm authentication token for publishing
  - Create at: https://www.npmjs.com/settings/YOUR_USERNAME/tokens
  - Choose "Automation" token type

### Optional: Homebrew Tap

To enable Homebrew publishing:

1. Create a repository named `homebrew-tap` in your organization
2. The workflow will automatically update the formula

## Manual Release (Emergency)

If you need to create a release manually:

```bash
# 1. Update version in package.json
npm version patch  # or minor, or major

# 2. Update CHANGELOG.md manually

# 3. Commit and tag
git add .
git commit -m "chore(release): v1.2.3"
git tag v1.2.3
git push origin main --tags
```

## Versioning Strategy

Following [Semantic Versioning](https://semver.org/):

- **Major (1.0.0)**: Breaking changes
- **Minor (0.1.0)**: New features (backward compatible)
- **Patch (0.0.1)**: Bug fixes

Pre-1.0.0 versions:
- Breaking changes bump minor version
- Features and fixes bump patch version

## Changelog Generation

The changelog is automatically generated using **git-cliff** configuration (cliff.toml):

- Groups commits by type
- Adds emoji for visual clarity
- Includes scope and breaking change indicators
- Filters out maintenance commits

## Troubleshooting

### Release PR not created

- Check that commits follow conventional commit format
- Verify the workflow ran successfully in Actions tab
- Ensure `main` branch protection allows the GitHub Actions bot

### Build fails

- Check that `bun build --compile` works locally
- Verify all dependencies are properly declared
- Check the Actions logs for specific errors

### Homebrew update fails

- Verify the homebrew-tap repository exists
- Check that the binary URLs are accessible
- Ensure the formula syntax is valid

## Testing Locally

Test the standalone build:

```bash
# Build for your platform
bun build ./src/cli/index.ts --compile --outfile devver-test

# Test the binary
./devver-test --version
```

## Resources

- [Conventional Commits](https://www.conventionalcommits.org/)
- [release-please documentation](https://github.com/googleapis/release-please)
- [git-cliff documentation](https://git-cliff.org/docs/)
- [Semantic Versioning](https://semver.org/)
