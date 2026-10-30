---
"@devver-inc/cli": patch
---

Split the native executables into per-platform npm packages, `@devver-inc/cli-darwin-arm64` and `@devver-inc/cli-linux-x64`, which `@devver-inc/cli` pins as optional dependencies. A single tarball carrying both targets exceeded the npm size limit. `npm install -g @devver-inc/cli` is unchanged and now downloads only the matching platform.
