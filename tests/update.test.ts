import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

import { Effect } from "effect";

import {
  installedRelease,
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
