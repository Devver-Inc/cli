import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { packageStaticTools } from "../scripts/static-tools";

const suffix = process.platform === "win32" ? ".exe" : "";
const EXPECTED = [
  "PITCHFORK-LICENSE",
  "WEBSITINO-LICENSE",
  `pitchfork${suffix}`,
  `websitino${suffix}`,
];
// Reused across runs on this machine, so only a cold cache reaches the network.
const cache = join(tmpdir(), "devver-static-tools-test-cache");

function packaged(destination: string) {
  return readdirSync(destination)
    .toSorted()
    .map((name) => {
      const path = join(destination, name);
      return {
        name,
        // Windows has no POSIX mode bits to compare.
        mode: process.platform === "win32" ? 0 : statSync(path).mode % 0o1000,
        bytes: readFileSync(path).toString("base64"),
      };
    });
}

function times(destination: string) {
  return readdirSync(destination)
    .toSorted()
    .map((name) => statSync(join(destination, name)).mtimeMs);
}

async function offline<A>(run: () => Promise<A>) {
  const online = globalThis.fetch;
  globalThis.fetch = Object.assign(
    () => {
      throw new Error("network used");
    },
    { preconnect: online.preconnect }
  );
  try {
    return await run();
  } finally {
    globalThis.fetch = online;
  }
}

function digest(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function failure(run: () => Promise<void>) {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : "a non-error rejection";
  }
  return "no failure";
}

test("builds reuse verified cached static tools and reject a corrupt entry", async () => {
  const root = mkdtempSync(join(tmpdir(), "devver-tool-cache-"));
  const destination = (name: string) => {
    const path = join(root, name);
    mkdirSync(path);
    return path;
  };
  process.env.DEVVER_STATIC_TOOLS_CACHE = cache;
  try {
    const first = destination("first");
    await packageStaticTools(first);
    const expected = packaged(first);
    expect(expected.map((file) => file.name)).toEqual(EXPECTED);
    if (process.platform !== "win32") {
      expect(expected.map((file) => file.mode)).toEqual([
        0o644, 0o644, 0o755, 0o755,
      ]);
    }
    // Each entry is addressed by the pin every build verifies it against.
    const entries = readdirSync(cache);
    expect(entries).toHaveLength(4);
    for (const entry of entries) {
      expect(entry.endsWith(digest(join(cache, entry)))).toBe(true);
    }

    const warm = destination("warm");
    await offline(async () => packageStaticTools(warm));
    expect(packaged(warm)).toEqual(expected);
    // A destination that already holds the pinned bytes is left untouched.
    const untouched = times(warm);
    await offline(async () => packageStaticTools(warm));
    expect(times(warm)).toEqual(untouched);

    const license = entries.find((entry) =>
      entry.startsWith("pitchfork-license-")
    );
    expect(license).toBeDefined();
    const corrupted = join(cache, license ?? "");
    writeFileSync(corrupted, "not the pinned license");
    const rejected = destination("rejected");
    expect(
      await offline(async () =>
        failure(async () => packageStaticTools(rejected))
      )
    ).toBe("network used");
    expect(readdirSync(rejected)).toEqual([]);

    // The rejected entry is refetched, not reused.
    const refetched = destination("refetched");
    await packageStaticTools(refetched);
    expect(packaged(refetched)).toEqual(expected);
    expect(corrupted.endsWith(digest(corrupted))).toBe(true);
  } finally {
    Reflect.deleteProperty(process.env, "DEVVER_STATIC_TOOLS_CACHE");
    rmSync(root, { force: true, recursive: true });
  }
}, 60_000);
