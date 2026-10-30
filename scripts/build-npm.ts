#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import pkg from "../package.json";

const targets = [
  {
    archive: "aarch64-apple-darwin",
    home: "packages/cli-darwin-arm64",
    platform: "darwin-arm64",
  },
  {
    archive: "x86_64-unknown-linux-gnu",
    home: "packages/cli-linux-x64",
    platform: "linux-x64",
  },
] as const;
const input = process.argv[2] ?? "artifacts";
const packaged = ["devver", "servers", "version", "fixture"];
const members = [
  "devver",
  `servers/${pkg.version}/devver-server`,
  `servers/${pkg.version}/pitchfork`,
  `servers/${pkg.version}/websitino`,
  `servers/${pkg.version}/PITCHFORK-LICENSE`,
  `servers/${pkg.version}/WEBSITINO-LICENSE`,
];

function tar(args: string[]): string {
  const result = spawnSync("tar", args, { encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(`Invalid npm archive: ${args[0]}`);
  }
  return result.stdout;
}

function executableHeader(path: string): Buffer {
  const handle = openSync(path, "r");
  const header = Buffer.alloc(4);
  try {
    if (readSync(handle, header, 0, 4, 0) !== 4) {
      throw new Error(`Truncated executable: ${path}`);
    }
    return header;
  } finally {
    closeSync(handle);
  }
}

function stage(target: (typeof targets)[number], destination: string) {
  const filename = `devver-cli-${target.archive}.tar.gz`;
  const archive = join(input, filename);
  const checksum = readFileSync(`${archive}.sha256`, "utf-8");
  const match = /^(?<hash>[a-f0-9]{64}) {2}(?<name>[^\r\n]+)\r?\n?$/u.exec(
    checksum
  );
  if (match?.groups?.name !== filename) {
    throw new Error(`Invalid checksum file for ${filename}`);
  }
  const actual = createHash("sha256")
    .update(readFileSync(archive))
    .digest("hex");
  if (actual !== match.groups.hash) {
    throw new Error(`Checksum mismatch for ${filename}`);
  }
  const listed = tar(["-tzf", archive]).trimEnd().split("\n");
  const expected = [
    "devver",
    "servers/",
    `servers/${pkg.version}/`,
    ...members.slice(1),
  ].toSorted();
  if (
    listed.length !== expected.length ||
    listed.toSorted().some((item, index) => item !== expected[index])
  ) {
    throw new Error(`Unexpected archive members or version in ${filename}`);
  }
  const modes = tar(["-tvzf", archive]).trimEnd().split("\n");
  if (
    modes.length !== listed.length ||
    modes.some(
      (line, index) =>
        !line.startsWith(listed[index]?.endsWith("/") === true ? "d" : "-")
    )
  ) {
    throw new Error(
      `Archive contains links or invalid member types: ${filename}`
    );
  }
  mkdirSync(destination, { recursive: true });
  tar(["-xzf", archive, "-C", destination]);
  for (const member of members) {
    const path = join(destination, member);
    const stat = lstatSync(path);
    if (!(stat.isFile() && !stat.isSymbolicLink())) {
      throw new Error(`Invalid archive member ${member}`);
    }
  }
  if (process.env.DEVVER_TEST_ONLY_NPM_FIXTURE === "1") {
    writeFileSync(
      join(destination, "fixture"),
      "Never publish this test fixture.\n"
    );
  } else {
    for (const member of members.slice(0, 2)) {
      const header = executableHeader(join(destination, member));
      const isMachO = header.equals(Buffer.from([0xcf, 0xfa, 0xed, 0xfe]));
      const isElf = header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
      if (target.platform === "darwin-arm64" ? !isMachO : !isElf) {
        throw new Error(`Wrong executable platform in ${filename}`);
      }
    }
  }
  chmodSync(join(destination, "devver"), 0o755);
  chmodSync(join(destination, "servers", pkg.version, "devver-server"), 0o755);
  writeFileSync(join(destination, "version"), `${pkg.version}\n`);
}

function assemble() {
  const stagings = targets.map((target) => join(target.home, ".staging"));
  try {
    for (const [index, target] of targets.entries()) {
      const staging = stagings[index];
      if (staging === undefined) {
        throw new Error(`Missing staging directory for ${target.platform}`);
      }
      rmSync(staging, { recursive: true, force: true });
      stage(target, staging);
    }
    for (const [index, target] of targets.entries()) {
      const staging = stagings[index];
      if (staging === undefined) {
        throw new Error(`Missing staging directory for ${target.platform}`);
      }
      for (const name of packaged) {
        rmSync(join(target.home, name), { recursive: true, force: true });
      }
      for (const name of readdirSync(staging)) {
        renameSync(join(staging, name), join(target.home, name));
      }
      rmSync(staging, { recursive: true, force: true });
    }
  } catch (error) {
    for (const staging of stagings) {
      rmSync(staging, { recursive: true, force: true });
    }
    throw error;
  }
}

assemble();
console.log(
  `Assembled npm platform packages ${pkg.version} from verified standalone archives`
);
