import { realpath } from "node:fs/promises";
import { join } from "node:path";

import { Console, Data, Effect, Schema, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import { execute } from "../util/exec";

export interface InstalledRelease {
  readonly channel: "stable" | "nightly";
  readonly version: string;
}

export interface Candidate {
  readonly version: string;
  readonly url: string;
}

type Installer = "npm" | "brew";
interface UpdatableRelease extends InstalledRelease {
  readonly installer: Installer;
}

const versionPattern =
  /^(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)(?:-(?<prerelease>[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const nightlyPattern =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-nightly\.build\.(?<run>0|[1-9]\d*)\.(?<attempt>0|[1-9]\d*)$/u;
const tagsSchema = Schema.Struct({
  latest: Schema.String,
  nightly: Schema.optional(Schema.String),
});
const decodeTags = Schema.decodeUnknownSync(tagsSchema);
const decodeBrewInfo = Schema.decodeUnknownSync(
  Schema.Struct({
    formulae: Schema.Array(
      Schema.Struct({
        versions: Schema.Struct({ stable: Schema.String }),
      })
    ),
  })
);
const registryUrl =
  "https://registry.npmjs.org/-/package/@devver-inc%2fcli/dist-tags";

function parts(
  version: string | undefined
): { numbers: number[]; prerelease: string[] } | undefined {
  if (version === undefined) {
    return undefined;
  }
  const match = versionPattern.exec(version);
  if (match === null) {
    return undefined;
  }
  const numbers = match.slice(1, 4).map(Number);
  if (numbers.some((number) => !Number.isSafeInteger(number))) {
    return undefined;
  }
  const prerelease = match.groups?.prerelease?.split(".") ?? [];
  if (
    prerelease.some(
      (part) => /^\d+$/u.test(part) && part.length > 1 && part.startsWith("0")
    )
  ) {
    return undefined;
  }
  return { numbers, prerelease };
}

function nightlyBuild(version: string): readonly [bigint, bigint] | undefined {
  const match = nightlyPattern.exec(version);
  if (match?.groups?.run === undefined || match.groups.attempt === undefined) {
    return undefined;
  }
  return [BigInt(match.groups.run), BigInt(match.groups.attempt)];
}

export function isNewer(
  installed: InstalledRelease,
  candidate: Candidate
): boolean {
  const current = parts(installed.version);
  const next = parts(candidate.version);
  if (current === undefined || next === undefined) {
    return false;
  }
  if (installed.channel === "stable" && next.prerelease.length > 0) {
    return false;
  }
  if (installed.channel === "nightly") {
    const currentBuild = nightlyBuild(installed.version);
    const nextBuild = nightlyBuild(candidate.version);
    if (currentBuild === undefined || nextBuild === undefined) {
      return false;
    }
    return (
      nextBuild[0] > currentBuild[0] ||
      (nextBuild[0] === currentBuild[0] && nextBuild[1] > currentBuild[1])
    );
  }
  for (let index = 0; index < 3; index += 1) {
    const difference =
      (next.numbers[index] ?? 0) - (current.numbers[index] ?? 0);
    if (difference !== 0) {
      return difference > 0;
    }
  }
  return false;
}

export function updatePlan(
  release: UpdatableRelease,
  candidate: Candidate
): readonly [command: "npm" | "brew", ...args: string[]] | undefined {
  if (!isNewer(release, candidate)) {
    return undefined;
  }
  if (release.installer === "npm") {
    return ["npm", "install", "-g", `@devver-inc/cli@${candidate.version}`];
  }
  return release.channel === "stable"
    ? ["brew", "upgrade", "devver-cli"]
    : undefined;
}

declare const DEVVER_VERSION: string;
declare const DEVVER_CHANNEL: string;
// oxlint-disable anti-slop/no-runtime-typeof -- Build constants are absent in source.
const stampedVersion =
  typeof DEVVER_VERSION === "string" ? DEVVER_VERSION : undefined;
const stampedChannel =
  typeof DEVVER_CHANNEL === "string" ? DEVVER_CHANNEL : undefined;
// oxlint-enable anti-slop/no-runtime-typeof

const npmRelease = (version: string, channel: string) =>
  Effect.gen(function* () {
    const root = yield* Effect.tryPromise(async () =>
      (await execute("npm", ["root", "-g"], { timeout: 3000 })).stdout.trim()
    ).pipe(Effect.option);
    let platform: string | undefined;
    if (process.platform === "darwin" && process.arch === "arm64") {
      platform = "darwin-arm64";
    } else if (process.platform === "linux" && process.arch === "x64") {
      platform = "linux-x64";
    }
    if (platform === undefined || root._tag === "None") {
      return undefined;
    }
    const expected = yield* Effect.tryPromise(async () =>
      realpath(
        join(root.value, "@devver-inc", "cli", "dist", platform, "devver")
      )
    ).pipe(Effect.option);
    const running = yield* Effect.tryPromise(async () =>
      realpath(process.execPath)
    ).pipe(Effect.option);
    return expected._tag === "Some" &&
      running._tag === "Some" &&
      expected.value === running.value
      ? ({
          channel: channel === "nightly" ? "nightly" : "stable",
          version,
          installer: "npm",
        } as const)
      : undefined;
  });

export const installedRelease = Effect.gen(function* () {
  if (stampedVersion === undefined || parts(stampedVersion) === undefined) {
    return undefined;
  }
  if (
    stampedChannel !== "npm" &&
    stampedChannel !== "nightly" &&
    stampedChannel !== "standalone"
  ) {
    return undefined;
  }
  if (
    stampedChannel === "nightly" &&
    nightlyBuild(stampedVersion) === undefined
  ) {
    return undefined;
  }
  const npm = yield* npmRelease(stampedVersion, stampedChannel);
  if (npm !== undefined) {
    return npm;
  }
  const binary = yield* Effect.tryPromise(
    async () => await realpath(process.execPath)
  ).pipe(Effect.option);
  if (binary._tag === "None") {
    return undefined;
  }
  const brew = yield* Effect.tryPromise(async () => {
    const { stdout } = await execute("brew", ["--prefix", "devver-cli"], {
      timeout: 3000,
    });
    return await realpath(join(stdout.trim(), "bin", "devver"));
  }).pipe(Effect.option);
  return brew._tag === "Some" && brew.value === binary.value
    ? ({
        channel: "stable",
        version: stampedVersion,
        installer: "brew",
      } as const)
    : undefined;
});

export class UpdateError extends Data.TaggedError("UpdateError")<{
  readonly message: string;
}> {}

export const publishedCandidate = (release: UpdatableRelease) =>
  release.installer === "brew"
    ? Effect.gen(function* () {
        const { stdout } = yield* Effect.tryPromise(
          async () =>
            await execute(
              "brew",
              ["info", "--json=v2", "--formula", "devver-cli"],
              { timeout: 3000, maxBuffer: 65_536 }
            )
        );
        const info = yield* Effect.try({
          try: () => decodeBrewInfo(JSON.parse(stdout)),
          catch: () =>
            new UpdateError({
              message: "Invalid Homebrew formula information.",
            }),
        });
        const version = info.formulae[0]?.versions.stable;
        if (
          version === undefined ||
          parts(version) === undefined ||
          version.includes("-")
        ) {
          return undefined;
        }
        return { version, url: "https://github.com/Devver-Inc/cli" };
      }).pipe(Effect.timeout(3000))
    : Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const response = yield* client.execute(
          HttpClientRequest.get(registryUrl)
        );
        if (response.status !== 200) {
          return yield* new UpdateError({
            message: "Could not check the npm release tag.",
          });
        }
        const bytes = yield* response.stream.pipe(
          Stream.flatMap((chunk) => Stream.fromIterable(chunk)),
          Stream.take(65_537),
          Stream.runCollect
        );
        if (bytes.length > 65_536) {
          return yield* new UpdateError({
            message: "npm release metadata is too large.",
          });
        }
        const tags = yield* Effect.try({
          try: () =>
            decodeTags(
              JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes)))
            ),
          catch: () =>
            new UpdateError({ message: "Invalid npm release metadata." }),
        });
        const version =
          release.channel === "stable" ? tags.latest : tags.nightly;
        if (
          version === undefined ||
          parts(version) === undefined ||
          (release.channel === "nightly" && nightlyBuild(version) === undefined)
        ) {
          return undefined;
        }
        return {
          version,
          url: `https://www.npmjs.com/package/@devver-inc/cli/v/${version}`,
        };
      }).pipe(
        Effect.timeout(3000),
        Effect.provideService(FetchHttpClient.RequestInit, {
          redirect: "manual",
        }),
        // @effect-diagnostics-next-line strictEffectProvide:off -- Isolated public registry check provides its unauthenticated HTTP client.
        Effect.provide(FetchHttpClient.layer),
        Effect.scoped
      );

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

export const runUpdate = Effect.gen(function* () {
  const release = yield* installedRelease;
  if (release === undefined) {
    return yield* new UpdateError({
      message:
        "This installation cannot self-update. Install the published npm package globally or use Homebrew stable.",
    });
  }
  if (release.installer === "brew") {
    yield* Effect.tryPromise(async () => await execute("brew", ["update"]));
  }
  const candidate = yield* publishedCandidate(release);
  if (candidate === undefined) {
    return yield* new UpdateError({
      message: "Could not verify the published release.",
    });
  }
  const plan = updatePlan(release, candidate);
  if (plan === undefined) {
    return yield* Console.log(`Already up to date (${release.version}).`);
  }
  const [command, ...args] = plan;
  yield* Effect.tryPromise(async () => await execute(command, args));
  return yield* Console.log(
    release.installer === "brew"
      ? "Homebrew upgrade completed. Check devver --version."
      : `Installed ${release.channel} ${candidate.version}.`
  );
}).pipe(
  Effect.mapError((error) =>
    error instanceof UpdateError
      ? error
      : new UpdateError({
          message:
            "Update failed. Check your network and installer, then retry.",
        })
  )
);
