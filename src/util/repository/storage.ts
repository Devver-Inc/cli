import { Storage } from "../../storage";

const REPOSITORY_LINKS_KEY = "repository/links";

interface RepoLink {
  repoName: string;
  repoUrl: string;
}

type RepoLinksMap = Record<string, RepoLink>;

async function readLinksMap(): Promise<RepoLinksMap> {
  try {
    const exists = await Storage.fileExists(REPOSITORY_LINKS_KEY);
    if (!exists) {
      return {};
    }
    const raw = await Storage.readToString(REPOSITORY_LINKS_KEY);
    return JSON.parse(raw) as RepoLinksMap;
  } catch {
    return {};
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
  map[folderPath] = { repoName, repoUrl };
  await writeLinksMap(map);
}

export async function unlinkRepo(folderPath: string): Promise<void> {
  const map = await readLinksMap();
  delete map[folderPath];
  await writeLinksMap(map);
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
