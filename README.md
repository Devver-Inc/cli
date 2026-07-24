# react

To install dependencies:

```bash
bun install
```

To run:

```bash
bun dev
```

This project was created using `bun create tui`. [create-tui](https://git.new/create-tui) is the easiest way to get started with OpenTUI.

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
bun build ./src/index.tsx --compile --outfile devver-test

# Test the binary
./devver-test --version
```

## Resources

- [Conventional Commits](https://www.conventionalcommits.org/)
- [release-please documentation](https://github.com/googleapis/release-please)
- [git-cliff documentation](https://git-cliff.org/docs/)
- [Semantic Versioning](https://semver.org/)
