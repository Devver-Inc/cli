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
const FERRON_VERSION = "2.8.1";
const FERRON_LICENSE_HASH =
  "c1db5c351e357ea68362c01faff8dc046c59e1d7466317f64482c2a6d3e6a695";
const AUBE_VERSION = "v2.8.5";
const AUBE_LICENSE_HASH =
  "d12ab62ad9f4de7596b77e508910e6bcbb320f9550d665b581ce5b2e4a203e5a";
const EXECUTABLE_MODE = 0o755;
const DOCUMENT_MODE = 0o644;
const artifacts = {
  darwin: {
    pitchfork: "aarch64-apple-darwin.tar.gz",
    pitchforkHash:
      "148d3fc64a71245f3752d57e9b8b5e656c4723bc72b2ab4fc61fa883abb46ae7",
    ferron: "aarch64-apple-darwin",
    ferronHash:
      "a2eb94f6c46a8093822dba935fd9641bf3c0a23369296e7e6afa9b70cf25e077",
    aube: "aarch64-apple-darwin.tar.gz",
    aubeHash:
      "74c22535927c8ecd1ca9937371e9cce40a6b4ae7915ea5e45cfff17eb5dad5ff",
  },
  linux: {
    pitchfork: "x86_64-unknown-linux-gnu.tar.gz",
    pitchforkHash:
      "cc2aa26c9d3c0833bfa16d79f8ae167bd7d88a708b489322296286517643a1c4",
    ferron: "x86_64-unknown-linux-gnu",
    ferronHash:
      "3cf41cb1758c9fc653354a7fa5be2ca88a10a03a764cd82df67545216a3c5302",
    aube: "x86_64-unknown-linux-gnu.tar.gz",
    aubeHash:
      "bda6a85ac51b11930f92150d51a2d749ea85d0894195056c9e5a52747b56695a",
  },
  win32: {
    pitchfork: "x86_64-pc-windows-msvc.zip",
    pitchforkHash:
      "860f3f701b9fd027d115fe1f9108f7949c210526e8ec45916417cd97a4c5646e",
    ferron: "x86_64-pc-windows-msvc",
    ferronHash:
      "aa1d083d38452b358c1e0badadf4cf49a52242fe942a4e4e4d7fb715af2793c8",
    aube: "x86_64-pc-windows-msvc.zip",
    aubeHash:
      "97cfb2ee932529091f39f6f47933802569e5b38a689f867ee45ae0ee6f2be4cc",
  },
} as const;

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function configured(value: string | undefined) {
  return value === undefined || value === "" ? undefined : value;
}

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

async function writeAtomic(path: string, bytes: Buffer, mode: number) {
  const staged = `${path}.${randomUUID()}.partial`;
  try {
    await writeFile(staged, bytes);
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

async function zipMember(archivePath: string, member: string, into: string) {
  if (process.platform === "win32") {
    const extracted = Bun.spawnSync(
      ["tar", "-xf", archivePath, "-C", into, member],
      { stdout: "pipe", stderr: "pipe" }
    );
    if (extracted.exitCode !== 0) {
      throw new Error("Could not extract pinned Ferron archive");
    }
    return await readFile(join(into, member));
  }
  const extracted = Bun.spawnSync(["unzip", "-p", archivePath, member], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (extracted.exitCode !== 0) {
    throw new Error("Could not extract pinned Ferron archive");
  }
  return Buffer.from(extracted.stdout);
}

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
    const [
      archive,
      ferronArchive,
      aubeArchive,
      pitchforkLicense,
      ferronLicense,
      aubeLicense,
    ] = await Promise.all([
      cachedVerified(
        `pitchfork-${PITCHFORK_VERSION}-${target.pitchforkHash}`,
        `https://github.com/jdx/pitchfork/releases/download/${PITCHFORK_VERSION}/pitchfork-${target.pitchfork}`,
        target.pitchforkHash
      ),
      cachedVerified(
        `ferron-${FERRON_VERSION}-${target.ferronHash}`,
        `https://github.com/ferronweb/ferron/releases/download/${FERRON_VERSION}/ferron-${FERRON_VERSION}-${target.ferron}.zip`,
        target.ferronHash
      ),
      cachedVerified(
        `aube-${AUBE_VERSION}-${target.aubeHash}`,
        `https://github.com/aubepkg/aube/releases/download/${AUBE_VERSION}/aube-${AUBE_VERSION}-${target.aube}`,
        target.aubeHash
      ),
      cachedVerified(
        `pitchfork-license-${PITCHFORK_VERSION}-${PITCHFORK_LICENSE_HASH}`,
        `https://raw.githubusercontent.com/jdx/pitchfork/${PITCHFORK_VERSION}/LICENSE`,
        PITCHFORK_LICENSE_HASH
      ),
      cachedVerified(
        `ferron-license-${FERRON_VERSION}-${FERRON_LICENSE_HASH}`,
        `https://raw.githubusercontent.com/ferronweb/ferron/${FERRON_VERSION}/LICENSE`,
        FERRON_LICENSE_HASH
      ),
      cachedVerified(
        `aube-license-${AUBE_VERSION}-${AUBE_LICENSE_HASH}`,
        `https://raw.githubusercontent.com/aubepkg/aube/${AUBE_VERSION}/LICENSE`,
        AUBE_LICENSE_HASH
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
    const aubePath = join(
      temporary,
      platform === "win32" ? "aube.zip" : "aube.tar.gz"
    );
    await writeFile(aubePath, aubeArchive);
    if (
      Bun.spawnSync(
        ["tar", "-xf", aubePath, "-C", temporary, `aube${suffix}`],
        { stdout: "pipe", stderr: "pipe" }
      ).exitCode !== 0
    ) {
      throw new Error("Could not extract pinned Aube archive");
    }
    const ferronPath = join(temporary, "ferron.zip");
    await writeFile(ferronPath, ferronArchive);
    await installFile(
      join(destination, `pitchfork${suffix}`),
      await readFile(join(temporary, `pitchfork${suffix}`)),
      EXECUTABLE_MODE
    );
    await installFile(
      join(destination, `aube${suffix}`),
      await readFile(join(temporary, `aube${suffix}`)),
      EXECUTABLE_MODE
    );
    await installFile(
      join(destination, `ferron${suffix}`),
      await zipMember(ferronPath, `ferron${suffix}`, temporary),
      EXECUTABLE_MODE
    );
    await installFile(
      join(destination, "PITCHFORK-LICENSE"),
      pitchforkLicense,
      DOCUMENT_MODE
    );
    await installFile(
      join(destination, "FERRON-LICENSE"),
      ferronLicense,
      DOCUMENT_MODE
    );
    await installFile(
      join(destination, "AUBE-LICENSE"),
      aubeLicense,
      DOCUMENT_MODE
    );
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
}
