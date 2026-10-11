import { createHash } from "node:crypto";
import { chmod, copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PITCHFORK_VERSION = "v2.30.1";
const WEBSITINO_VERSION = "v0.2.11";
const WEBSITINO_COMMIT = "a68fee90d663c46d5a5dfe8774bb5048ff7cfad6";
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

async function downloadVerified(url: string, expected: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Static tool download failed (${response.status})`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== expected) {
    throw new Error("Static tool checksum mismatch");
  }
  return bytes;
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
        downloadVerified(
          `https://github.com/jdx/pitchfork/releases/download/${PITCHFORK_VERSION}/pitchfork-${target.pitchfork}`,
          target.pitchforkHash
        ),
        downloadVerified(
          `https://raw.githubusercontent.com/trikko/websitino/${WEBSITINO_COMMIT}/${target.websitino}`,
          target.websitinoHash
        ),
        downloadVerified(
          `https://raw.githubusercontent.com/jdx/pitchfork/${PITCHFORK_VERSION}/LICENSE`,
          "5ba5d69f83674602525196efe44114e546cf3440d363603961076e52b9647a5a"
        ),
        downloadVerified(
          `https://raw.githubusercontent.com/trikko/websitino/${WEBSITINO_VERSION}/LICENSE`,
          "c7c58dfbad23e6c8675c0528641e725f2cf3f2f6680c5b9447d78a4646cbcbb6"
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
    await copyFile(
      join(temporary, `pitchfork${suffix}`),
      join(destination, `pitchfork${suffix}`)
    );
    await writeFile(join(destination, `websitino${suffix}`), websitino);
    await writeFile(join(destination, "PITCHFORK-LICENSE"), pitchforkLicense);
    await writeFile(join(destination, "WEBSITINO-LICENSE"), websitinoLicense);
    for (const name of [`pitchfork${suffix}`, `websitino${suffix}`]) {
      await chmod(join(destination, name), 0o755);
    }
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
}
