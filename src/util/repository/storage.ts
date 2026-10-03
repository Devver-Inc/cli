import { Schema } from "effect";
import { Storage } from "../../storage";

const REPOSITORY_LINKS_KEY = "repository/links";

const RepoLinkSchema = Schema.Struct({
  repoName: Schema.String,
  repoUrl: Schema.String,
});

const RepoLinksMapSchema = Schema.Record(Schema.String, RepoLinkSchema);

export type RepoLink = typeof RepoLinkSchema.Type;
type RepoLinksMap = typeof RepoLinksMapSchema.Type;

const decodeLinksMap = Schema.decodeUnknownSync(RepoLinksMapSchema);

async function readLinksMap(): Promise<RepoLinksMap> {
  const exists = await Storage.fileExists(REPOSITORY_LINKS_KEY);
  if (!exists) {
    return {};
  }
  const raw = await Storage.readToString(REPOSITORY_LINKS_KEY);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Repository links at '${REPOSITORY_LINKS_KEY}' are not valid JSON`,
      { cause: error }
    );
  }
  try {
    return decodeLinksMap(parsed);
  } catch (error) {
    throw new Error(
      `Repository links at '${REPOSITORY_LINKS_KEY}' have an unexpected shape`,
      { cause: error }
    );
  }
}

async function writeLinksMap(map: RepoLinksMap): Promise<void> {
  await Storage.write(REPOSITORY_LINKS_KEY, JSON.stringify(map, null, 2));
}

export async function getLinkedRepo(
  folderPath: string
): Promise<RepoLink | null> {
  const map = await readLinksMap();
  return map[folderPath] ?? null;
}

export async function linkRepo(
  folderPath: string,
  repoName: string,
  repoUrl: string
): Promise<void> {
  const map = await readLinksMap();
  await writeLinksMap({ ...map, [folderPath]: { repoName, repoUrl } });
}

export async function unlinkRepo(folderPath: string): Promise<void> {
  const { [folderPath]: _removed, ...rest } = await readLinksMap();
  await writeLinksMap(rest);
}

export function getLinkedRepoForCwd(): Promise<RepoLink | null> {
  return getLinkedRepo(process.cwd());
}

export function linkRepoForCwd(
  repoName: string,
  repoUrl: string
): Promise<void> {
  return linkRepo(process.cwd(), repoName, repoUrl);
}
