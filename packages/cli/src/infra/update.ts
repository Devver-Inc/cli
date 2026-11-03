import { realpath } from "node:fs/promises";
import { join } from "node:path";

import { Data, Effect, Option, Schema } from "effect";

import { updatePlan, validReleaseVersion } from "../core/update";
import type { UpdatableRelease } from "../core/update";
import { execute } from "./util/exec";
import { fetchJson } from "./util/http";

export class UpdateError extends Data.TaggedError("UpdateError")<{
  readonly message: string;
}> {}

const SUBPROCESS_TIMEOUT = 3000;
const REGISTRY_TIMEOUT = 3000;
const MAX_METADATA_BYTES = 65_536;
const REGISTRY_URL =
  "https://registry.npmjs.org/-/package/@devver-inc%2fcli/dist-tags";
const PUBLISHED_PLATFORMS = ["darwin-arm64", "linux-x64"] as const;

const CHANNEL_BY_STAMP: ReadonlyMap<string, UpdatableRelease["channel"]> =
  new Map([
    ["nightly", "nightly"],
    ["npm", "stable"],
    ["standalone", "stable"],
  ]);

const run = (command: string, args: readonly string[]) =>
  Effect.tryPromise({
    try: async () =>
      await execute(command, [...args], {
        timeout: SUBPROCESS_TIMEOUT,
        maxBuffer: MAX_METADATA_BYTES,
      }),
    catch: () => new UpdateError({ message: `Could not run ${command}.` }),
  });

const optional = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.option, Effect.map(Option.getOrUndefined));

const output = (command: string, args: readonly string[]) =>
  optional(run(command, args).pipe(Effect.map(({ stdout }) => stdout.trim())));

const resolved = (path: string) =>
  optional(Effect.tryPromise(async () => await realpath(path)));

declare const DEVVER_VERSION: string;
declare const DEVVER_CHANNEL: string;
// oxlint-disable anti-slop/no-runtime-typeof -- Build constants are absent in source.
const stampedVersion =
  typeof DEVVER_VERSION === "string" ? DEVVER_VERSION : undefined;
const stampedChannel =
  typeof DEVVER_CHANNEL === "string" ? DEVVER_CHANNEL : undefined;
// oxlint-enable anti-slop/no-runtime-typeof

const stampedRelease = ():
  | Pick<UpdatableRelease, "channel" | "version">
  | undefined => {
  const channel = CHANNEL_BY_STAMP.get(stampedChannel ?? "");
  return stampedVersion !== undefined &&
    channel !== undefined &&
    validReleaseVersion(channel, stampedVersion)
    ? { channel, version: stampedVersion }
    : undefined;
};

export const isNpmInstallation = (
  running: string,
  root: string,
  platform: (typeof PUBLISHED_PLATFORMS)[number]
) =>
  Effect.gen(function* () {
    for (const home of [
      join(root, "@devver-inc", `cli-${platform}`),
      join(
        root,
        "@devver-inc",
        "cli",
        "node_modules",
        "@devver-inc",
        `cli-${platform}`
      ),
    ]) {
      const installed = yield* resolved(join(home, "devver"));
      if (installed === running) {
        return true;
      }
    }
    return false;
  });

export const installedRelease: Effect.Effect<UpdatableRelease | undefined> =
  Effect.gen(function* () {
    const stamped = stampedRelease();
    if (stamped === undefined) {
      return undefined;
    }
    const running = yield* resolved(process.execPath);
    if (running === undefined) {
      return undefined;
    }
    const root = yield* output("npm", ["root", "-g"]);
    const platform = PUBLISHED_PLATFORMS.find(
      (name) => name === `${process.platform}-${process.arch}`
    );
    if (
      root !== undefined &&
      platform !== undefined &&
      (yield* isNpmInstallation(running, root, platform))
    ) {
      return { installer: "npm", ...stamped };
    }
    if (stamped.channel !== "stable") {
      return undefined;
    }
    const prefix = yield* output("brew", ["--prefix", "devver-cli"]);
    if (prefix === undefined) {
      return undefined;
    }
    const formula = yield* resolved(join(prefix, "bin", "devver"));
    return formula === running
      ? { installer: "brew", channel: "stable", version: stamped.version }
      : undefined;
  });

const TagsSchema = Schema.Struct({
  latest: Schema.String,
  nightly: Schema.optional(Schema.String),
});
const decodeFormula = Schema.decodeUnknownSync(
  Schema.Struct({
    formulae: Schema.Array(
      Schema.Struct({ versions: Schema.Struct({ stable: Schema.String }) })
    ),
  })
);

const brewCandidate = Effect.gen(function* () {
  const { stdout } = yield* run("brew", [
    "info",
    "--json=v2",
    "--formula",
    "devver-cli",
  ]);
  const body = yield* Effect.try({
    try: () => decodeFormula(JSON.parse(stdout)),
    catch: () =>
      new UpdateError({ message: "Invalid Homebrew formula metadata." }),
  });
  const version = body.formulae[0]?.versions.stable;
  return version !== undefined && validReleaseVersion("stable", version)
    ? { version, url: "https://github.com/Devver-Inc/cli" }
    : undefined;
});

const npmCandidate = (channel: UpdatableRelease["channel"]) =>
  Effect.gen(function* () {
    const tags = yield* fetchJson({
      url: REGISTRY_URL,
      schema: TagsSchema,
      limit: MAX_METADATA_BYTES,
      timeout: REGISTRY_TIMEOUT,
      onError: (message) => new UpdateError({ message }),
    });
    const version = channel === "stable" ? tags.latest : tags.nightly;
    return version !== undefined && validReleaseVersion(channel, version)
      ? {
          version,
          url: `https://www.npmjs.com/package/@devver-inc/cli/v/${version}`,
        }
      : undefined;
  });

export const publishedCandidate = (release: UpdatableRelease) =>
  release.installer === "brew" ? brewCandidate : npmCandidate(release.channel);

export const availableUpdate = Effect.gen(function* () {
  const release = yield* installedRelease;
  if (release === undefined) {
    return undefined;
  }
  const candidate = yield* publishedCandidate(release);
  return candidate !== undefined && updatePlan(release, candidate) !== undefined
    ? candidate
    : undefined;
}).pipe(
  Effect.timeout(5000),
  Effect.orElseSucceed(() => undefined)
);

export const installUpdate = Effect.gen(function* () {
  const release = yield* installedRelease;
  if (release === undefined) {
    return yield* new UpdateError({
      message:
        "This installation cannot self-update. Install the published npm package globally or use Homebrew stable.",
    });
  }
  if (release.installer === "brew") {
    yield* run("brew", ["update"]);
  }
  const candidate = yield* publishedCandidate(release);
  if (candidate === undefined) {
    return yield* new UpdateError({
      message: "Could not verify the published release.",
    });
  }
  const plan = updatePlan(release, candidate);
  if (plan === undefined) {
    return { kind: "current", version: release.version } as const;
  }
  const [command, ...args] = plan;
  yield* Effect.tryPromise({
    try: async () => await execute(command, args),
    catch: () =>
      new UpdateError({
        message: `${command} could not install ${candidate.version}.`,
      }),
  });
  return {
    kind: "installed",
    installer: release.installer,
    channel: release.channel,
    version: candidate.version,
  } as const;
});
