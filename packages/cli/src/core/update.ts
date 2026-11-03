export interface Candidate {
  readonly version: string;
  readonly url: string;
}

export type UpdatableRelease =
  | {
      readonly installer: "npm";
      readonly channel: "stable" | "nightly";
      readonly version: string;
    }
  | {
      readonly installer: "brew";
      readonly channel: "stable";
      readonly version: string;
    };

const stablePattern =
  /^(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)$/u;
const nightlyPattern =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-nightly\.build\.(?<run>0|[1-9]\d*)\.(?<attempt>0|[1-9]\d*)$/u;

const numbers = (
  pattern: RegExp,
  version: string
): readonly number[] | undefined => {
  const groups = pattern.exec(version)?.groups;
  return groups === undefined ? undefined : Object.values(groups).map(Number);
};

const ordinal = (channel: UpdatableRelease["channel"], version: string) =>
  numbers(channel === "nightly" ? nightlyPattern : stablePattern, version);

export const validReleaseVersion = (
  channel: UpdatableRelease["channel"],
  version: string
) => ordinal(channel, version) !== undefined;

const descends = (next: readonly number[], current: readonly number[]) => {
  for (const [index, value] of next.entries()) {
    const previous = current[index] ?? 0;
    if (value !== previous) {
      return value > previous;
    }
  }
  return false;
};

export function isNewer(
  installed: Pick<UpdatableRelease, "channel" | "version">,
  candidate: Candidate
): boolean {
  const current = ordinal(installed.channel, installed.version);
  const next = ordinal(installed.channel, candidate.version);
  return current !== undefined && next !== undefined && descends(next, current);
}

export function updatePlan(
  release: UpdatableRelease,
  candidate: Candidate
): readonly [command: "npm" | "brew", ...args: string[]] | undefined {
  if (!isNewer(release, candidate)) {
    return undefined;
  }
  return release.installer === "npm"
    ? ["npm", "install", "-g", `@devver-inc/cli@${candidate.version}`]
    : ["brew", "upgrade", "devver-cli"];
}
