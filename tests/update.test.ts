import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import {
  installedRelease,
  isNpmInstallation,
  prefixedNpmInstallation,
  isNewer,
  updatePlan,
} from "../packages/cli/src/cli/update";

test("--update rejects a source checkout without invoking an installer", () => {
  const result = spawnSync(
    "bun",
    ["packages/cli/src/cli/index.ts", "--update"],
    {
      encoding: "utf-8",
      timeout: 10_000,
    }
  );
  expect(result.status).not.toBe(0);
  expect(`${result.stdout}${result.stderr}`).toContain(
    "This installation cannot self-update."
  );
  expect(result.stdout).not.toContain("Installed stable");
});

test("--update cannot be combined with a subcommand", () => {
  const result = spawnSync(
    "bun",
    ["packages/cli/src/cli/index.ts", "--update", "deploy"],
    {
      encoding: "utf-8",
      timeout: 10_000,
    }
  );
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Unrecognized flag: --update");
});

test("source checkout has no published installation", async () => {
  expect(await Effect.runPromise(installedRelease)).toBeUndefined();
});

test("npm installation recognizes sibling and nested platform binaries only", async () => {
  const root = mkdtempSync(join(tmpdir(), "devver-update-"));
  try {
    const packageRoot = join(root, "@devver-inc", "cli");
    const sibling = join(root, "@devver-inc", "cli-darwin-arm64", "devver");
    const nested = join(
      packageRoot,
      "node_modules",
      "@devver-inc",
      "cli-darwin-arm64",
      "devver"
    );
    const unrelated = join(root, "other", "devver");
    for (const path of [sibling, nested, unrelated]) {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, "fixture");
    }
    const launcher = join(root, "launcher");
    symlinkSync(nested, launcher);
    expect(
      await Effect.runPromise(
        isNpmInstallation(realpathSync(sibling), root, "darwin-arm64")
      )
    ).toBe(true);
    expect(
      await Effect.runPromise(
        isNpmInstallation(realpathSync(launcher), root, "darwin-arm64")
      )
    ).toBe(true);
    expect(
      await Effect.runPromise(
        isNpmInstallation(realpathSync(unrelated), root, "darwin-arm64")
      )
    ).toBe(false);
    expect(
      await Effect.runPromise(
        isNpmInstallation(realpathSync(nested), root, "linux-x64")
      )
    ).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("only an opted-in dedicated npm prefix can self-update", async () => {
  const prefix = realpathSync(mkdtempSync(join(tmpdir(), "devver-prefix-")));
  try {
    const running = join(
      prefix,
      "node_modules",
      "@devver-inc",
      "cli-darwin-arm64",
      "devver"
    );
    mkdirSync(join(running, ".."), { recursive: true });
    writeFileSync(running, "fixture");
    writeFileSync(
      join(prefix, "package.json"),
      JSON.stringify({ dependencies: { "@devver-inc/cli": "^0.1.0" } })
    );
    expect(
      await Effect.runPromise(
        prefixedNpmInstallation(running, "darwin-arm64", "0.1.0")
      )
    ).toBeUndefined();
    writeFileSync(join(prefix, ".devver-self-update"), "");
    expect(
      await Effect.runPromise(
        prefixedNpmInstallation(running, "darwin-arm64", "0.1.0")
      )
    ).toBe(prefix);
    expect(
      await Effect.runPromise(
        prefixedNpmInstallation(running, "darwin-arm64", "0.2.0")
      )
    ).toBeUndefined();
    expect(
      await Effect.runPromise(
        prefixedNpmInstallation(running, "linux-x64", "0.1.0")
      )
    ).toBeUndefined();
    writeFileSync(
      join(prefix, "package.json"),
      JSON.stringify({
        dependencies: { "@devver-inc/cli": "^0.1.0", other: "1.0.0" },
      })
    );
    expect(
      await Effect.runPromise(
        prefixedNpmInstallation(running, "darwin-arm64", "0.1.0")
      )
    ).toBeUndefined();
    writeFileSync(
      join(prefix, "package.json"),
      JSON.stringify({
        name: "project",
        dependencies: { "@devver-inc/cli": "^0.1.0" },
      })
    );
    expect(
      await Effect.runPromise(
        prefixedNpmInstallation(running, "darwin-arm64", "0.1.0")
      )
    ).toBeUndefined();
  } finally {
    rmSync(prefix, { recursive: true, force: true });
  }
});

test("nested npm prefix recognizes the matching platform only", async () => {
  const prefix = realpathSync(mkdtempSync(join(tmpdir(), "devver-prefix-")));
  try {
    const running = join(
      prefix,
      "node_modules",
      "@devver-inc",
      "cli",
      "node_modules",
      "@devver-inc",
      "cli-linux-x64",
      "devver"
    );
    mkdirSync(join(running, ".."), { recursive: true });
    writeFileSync(running, "fixture");
    writeFileSync(join(prefix, ".devver-self-update"), "");
    writeFileSync(
      join(prefix, "package.json"),
      JSON.stringify({ dependencies: { "@devver-inc/cli": "^0.1.0" } })
    );
    expect(
      await Effect.runPromise(
        prefixedNpmInstallation(running, "linux-x64", "0.1.0")
      )
    ).toBe(prefix);
    expect(
      await Effect.runPromise(
        prefixedNpmInstallation(join(prefix, "other"), "linux-x64", "0.1.0")
      )
    ).toBeUndefined();
  } finally {
    rmSync(prefix, { recursive: true, force: true });
  }
});

test("stable compares versions without accepting prereleases or downgrades", () => {
  const installed = { channel: "stable", version: "1.2.0" } as const;
  expect(
    isNewer(installed, { version: "1.3.0", url: "https://example.test" })
  ).toBe(true);
  expect(
    isNewer(installed, {
      version: "1.3.0-nightly.build.1",
      url: "https://example.test",
    })
  ).toBe(false);
  expect(
    isNewer(installed, { version: "1.1.9", url: "https://example.test" })
  ).toBe(false);
  expect(
    isNewer(installed, {
      version: "1.3.0;rm -rf /",
      url: "https://example.test",
    })
  ).toBe(false);
});

test("nightly compares build numbers and stays on its channel", () => {
  const installed = {
    channel: "nightly",
    version: "1.3.0-nightly.build.9.1",
  } as const;
  expect(
    isNewer(installed, {
      version: "1.3.0-nightly.build.10.1",
      url: "https://example.test",
    })
  ).toBe(true);
  expect(
    isNewer(installed, {
      version: "1.3.0-nightly.build.8.1",
      url: "https://example.test",
    })
  ).toBe(false);
  expect(
    isNewer(installed, {
      version: "1.2.1-nightly.build.11.1",
      url: "https://example.test",
    })
  ).toBe(true);
  expect(
    isNewer(installed, {
      version: "1.4.0-nightly.build.8.1",
      url: "https://example.test",
    })
  ).toBe(false);
  expect(
    isNewer(installed, { version: "1.3.0", url: "https://example.test" })
  ).toBe(false);
  expect(
    isNewer(installed, {
      version: "1.3.0-dev.build.10.1",
      url: "https://example.test",
    })
  ).toBe(false);
});

test("installer plan pins the npm version and upgrades the brew formula", () => {
  expect(
    updatePlan(
      {
        channel: "nightly",
        installer: "npm",
        version: "1.3.0-nightly.build.9.1",
      },
      {
        version: "1.3.0-nightly.build.10.1",
        url: "https://example.test",
      }
    )
  ).toEqual([
    "npm",
    "install",
    "-g",
    "@devver-inc/cli@1.3.0-nightly.build.10.1",
  ]);
  expect(
    updatePlan(
      {
        channel: "stable",
        installer: "npm",
        version: "1.2.0",
        prefix: "/tmp/devver-latest",
      },
      { version: "1.3.0", url: "https://example.test" }
    )
  ).toEqual([
    "npm",
    "install",
    "--prefix",
    "/tmp/devver-latest",
    "@devver-inc/cli@1.3.0",
  ]);
  expect(
    updatePlan(
      { channel: "stable", installer: "brew", version: "1.2.0" },
      { version: "1.3.0", url: "https://example.test" }
    )
  ).toEqual(["brew", "upgrade", "devver-cli"]);
  expect(
    updatePlan(
      { channel: "stable", installer: "brew", version: "1.2.0" },
      { version: "1.2.0", url: "https://example.test" }
    )
  ).toBeUndefined();
});
