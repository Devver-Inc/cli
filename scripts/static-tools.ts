import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const PITCHFORK_VERSION = "v2.30.1";
const PITCHFORK_LICENSE_HASH =
  "5ba5d69f83674602525196efe44114e546cf3440d363603961076e52b9647a5a";
const WEBSITINO_VERSION = "v0.2.11";
const WEBSITINO_COMMIT = "a68fee90d663c46d5a5dfe8774bb5048ff7cfad6";
const WEBSITINO_LICENSE_HASH =
  "c7c58dfbad23e6c8675c0528641e725f2cf3f2f6680c5b9447d78a4646cbcbb6";
const EXECUTABLE_MODE = 0o755;
const DOCUMENT_MODE = 0o644;
const artifacts = {
  darwin: {
    pitchfork: "aarch64-apple-darwin.tar.gz",
    pitchforkHash:
      "148d3fc64a71245f3752d57e9b8b5e656c4723bc72b2ab4fc61fa883abb46ae7",
    websitino: "macos-14/websitino",
    websitinoHash:
      "20c6ddb616d1c3d82b87223b4f928fa51c80353be88b28335f5d7bffaf01b8ba",
  },
  linux: {
    pitchfork: "x86_64-unknown-linux-gnu.tar.gz",
    pitchforkHash:
      "cc2aa26c9d3c0833bfa16d79f8ae167bd7d88a708b489322296286517643a1c4",
    websitino: "linux/websitino",
    websitinoHash:
      "f34a5e8bee69a0810544818aaba001dfcd9a6506e7e9794840f2dcd65e1d5391",
  },
  win32: {
    pitchfork: "x86_64-pc-windows-msvc.zip",
    pitchforkHash:
      "860f3f701b9fd027d115fe1f9108f7949c210526e8ec45916417cd97a4c5646e",
    websitino: "windows/websitino.exe",
    websitinoHash:
      "d6a1d49b4c27b805be59516725422ebe56968d1579e9550b7af369223f34b126",
  },
} as const;

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function configured(value: string | undefined) {
  return value === undefined || value === "" ? undefined : value;
}

/** Verified build-time downloads, reused across builds but never shipped. */
function cacheDirectory() {
  const override = configured(process.env.DEVVER_STATIC_TOOLS_CACHE);
  if (override !== undefined) {
    return override;
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Caches", "devver", "static-tools");
  }
  const windowsLocal =
    process.platform === "win32"
      ? configured(process.env.LOCALAPPDATA)
      : undefined;
  if (windowsLocal !== undefined) {
    return join(windowsLocal, "devver", "static-tools");
  }
  const xdg = configured(process.env.XDG_CACHE_HOME);
  return join(xdg ?? join(homedir(), ".cache"), "devver", "static-tools");
}

/** Concurrent builds target the same paths, so a reader sees all or nothing. */
async function writeAtomic(path: string, bytes: Buffer, mode: number) {
  const staged = `${path}.${randomUUID()}.partial`;
  try {
    await writeFile(staged, bytes);
    // writeFile's own mode is masked by umask; chmod sets the shipped bits.
    await chmod(staged, mode);
    await rename(staged, path);
  } catch (error) {
    await rm(staged, { force: true });
    throw error;
  }
}

async function downloadVerified(url: string, expected: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Static tool download failed (${response.status})`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== expected) {
    throw new Error("Static tool checksum mismatch");
  }
  return bytes;
}

/**
 * One test suite run drives a dozen builds, so re-fetching ~28 MB per build
 * made GitHub answer with 504s. Only the pinned bytes are cached: every build
 * verifies the pin again, an entry that fails that check is discarded and
 * re-fetched, and a miss without network fails instead of packaging nothing.
 */
async function cachedVerified(key: string, url: string, expected: string) {
  const directory = cacheDirectory();
  const path = join(directory, key);
  const cached = await readFile(path).catch(() => undefined);
  if (cached !== undefined) {
    if (sha256(cached) === expected) {
      return cached;
    }
    await rm(path, { force: true });
  }
  const bytes = await downloadVerified(url, expected);
  await mkdir(directory, { recursive: true });
  await writeAtomic(path, bytes, DOCUMENT_MODE);
  return bytes;
}

async function installFile(path: string, bytes: Buffer, mode: number) {
  const current = await stat(path).catch(() => undefined);
  if (
    current !== undefined &&
    current.mode % 0o1000 === mode &&
    (await readFile(path)).equals(bytes)
  ) {
    return;
  }
  await writeAtomic(path, bytes, mode);
}

/** Build-time only; never called from a shipped executable. */
export async function packageStaticTools(destination: string) {
  const { platform, arch } = process;
  if (
    (platform === "darwin" && arch !== "arm64") ||
    ((platform === "linux" || platform === "win32") && arch !== "x64")
  ) {
    throw new Error("No pinned static tools for this release platform");
  }
  let target;
  if (platform === "darwin") {
    target = artifacts.darwin;
  } else if (platform === "linux") {
    target = artifacts.linux;
  } else if (platform === "win32") {
    target = artifacts.win32;
  } else {
    throw new Error("No pinned static tools for this release platform");
  }
  const temporary = await mkdtemp(join(tmpdir(), "devver-static-tools-"));
  try {
    const [archive, websitino, pitchforkLicense, websitinoLicense] =
      await Promise.all([
        cachedVerified(
          `pitchfork-${PITCHFORK_VERSION}-${target.pitchforkHash}`,
          `https://github.com/jdx/pitchfork/releases/download/${PITCHFORK_VERSION}/pitchfork-${target.pitchfork}`,
          target.pitchforkHash
        ),
        cachedVerified(
          `websitino-${WEBSITINO_COMMIT}-${target.websitinoHash}`,
          `https://raw.githubusercontent.com/trikko/websitino/${WEBSITINO_COMMIT}/${target.websitino}`,
          target.websitinoHash
        ),
        cachedVerified(
          `pitchfork-license-${PITCHFORK_VERSION}-${PITCHFORK_LICENSE_HASH}`,
          `https://raw.githubusercontent.com/jdx/pitchfork/${PITCHFORK_VERSION}/LICENSE`,
          PITCHFORK_LICENSE_HASH
        ),
        cachedVerified(
          `websitino-license-${WEBSITINO_VERSION}-${WEBSITINO_LICENSE_HASH}`,
          `https://raw.githubusercontent.com/trikko/websitino/${WEBSITINO_VERSION}/LICENSE`,
          WEBSITINO_LICENSE_HASH
        ),
      ]);
    const archivePath = join(
      temporary,
      platform === "win32" ? "pitchfork.zip" : "pitchfork.tar.gz"
    );
    await writeFile(archivePath, archive);
    const extracted = Bun.spawnSync(
      ["tar", "-xf", archivePath, "-C", temporary],
      { stdout: "pipe", stderr: "pipe" }
    );
    if (extracted.exitCode !== 0) {
      throw new Error("Could not extract pinned Pitchfork archive");
    }
    const suffix = platform === "win32" ? ".exe" : "";
    await installFile(
      join(destination, `pitchfork${suffix}`),
      await readFile(join(temporary, `pitchfork${suffix}`)),
      EXECUTABLE_MODE
    );
    await installFile(
      join(destination, `websitino${suffix}`),
      websitino,
      EXECUTABLE_MODE
    );
    await installFile(
      join(destination, "PITCHFORK-LICENSE"),
      pitchforkLicense,
      DOCUMENT_MODE
    );
    await installFile(
      join(destination, "WEBSITINO-LICENSE"),
      websitinoLicense,
      DOCUMENT_MODE
    );
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
}
