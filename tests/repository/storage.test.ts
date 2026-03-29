import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileStorage } from "@flystorage/file-storage";
import { LocalStorageAdapter } from "@flystorage/local-fs";

/**
 * Integration tests for repository link storage.
 *
 * We can't easily mock the Storage singleton at import time with Bun's
 * module system, so we test the Storage layer with a real temp directory
 * and then test the repo storage logic on top of it.
 */

let tmpDir: string;
let storage: FileStorage;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devver-repo-test-"));
  storage = new FileStorage(new LocalStorageAdapter(tmpDir));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const LINKS_KEY = "repository/links";

// Mirrors the logic from src/util/repository/storage.ts
interface RepoLink {
  repoName: string;
  repoUrl: string;
}
type RepoLinksMap = Record<string, RepoLink>;

async function readLinksMap(): Promise<RepoLinksMap> {
  try {
    const exists = await storage.fileExists(LINKS_KEY);
    if (!exists) {
      return {};
    }
    const raw = await storage.readToString(LINKS_KEY);
    return JSON.parse(raw) as RepoLinksMap;
  } catch {
    return {};
  }
}

async function writeLinksMap(map: RepoLinksMap): Promise<void> {
  await storage.write(LINKS_KEY, JSON.stringify(map, null, 2));
}

async function getLinkedRepo(folderPath: string): Promise<RepoLink | null> {
  const map = await readLinksMap();
  return map[folderPath] ?? null;
}

async function linkRepo(
  folderPath: string,
  repoName: string,
  repoUrl: string
): Promise<void> {
  const map = await readLinksMap();
  map[folderPath] = { repoName, repoUrl };
  await writeLinksMap(map);
}

async function unlinkRepo(folderPath: string): Promise<void> {
  const map = await readLinksMap();
  delete map[folderPath];
  await writeLinksMap(map);
}

// -- Tests --------------------------------------------------------------------

describe("repository link storage", () => {
  beforeEach(async () => {
    // Clean state between tests
    try {
      await storage.deleteFile(LINKS_KEY);
    } catch {
      // Ignore if not exists
    }
  });

  test("returns null for unlinked path", async () => {
    const result = await getLinkedRepo("/some/project");
    expect(result).toBeNull();
  });

  test("links and retrieves a repo", async () => {
    await linkRepo(
      "/home/user/myapp",
      "myapp",
      "https://github.com/user/myapp"
    );

    const result = await getLinkedRepo("/home/user/myapp");
    expect(result).not.toBeNull();
    expect(result?.repoName).toBe("myapp");
    expect(result?.repoUrl).toBe("https://github.com/user/myapp");
  });

  test("multiple paths can be linked independently", async () => {
    await linkRepo("/path/a", "repo-a", "https://github.com/a");
    await linkRepo("/path/b", "repo-b", "https://github.com/b");

    const a = await getLinkedRepo("/path/a");
    const b = await getLinkedRepo("/path/b");
    expect(a?.repoName).toBe("repo-a");
    expect(b?.repoName).toBe("repo-b");
  });

  test("linking same path overwrites previous value", async () => {
    await linkRepo("/path/x", "old-name", "https://old.url");
    await linkRepo("/path/x", "new-name", "https://new.url");

    const result = await getLinkedRepo("/path/x");
    expect(result?.repoName).toBe("new-name");
    expect(result?.repoUrl).toBe("https://new.url");
  });

  test("unlinkRepo removes the entry", async () => {
    await linkRepo("/path/del", "to-delete", "https://del.url");
    await unlinkRepo("/path/del");

    const result = await getLinkedRepo("/path/del");
    expect(result).toBeNull();
  });

  test("unlinkRepo on non-existent path is a no-op", async () => {
    // Should not throw
    await unlinkRepo("/never/linked");
    const result = await getLinkedRepo("/never/linked");
    expect(result).toBeNull();
  });

  test("persisted data is valid JSON", async () => {
    await linkRepo("/path/json", "json-test", "https://json.url");

    const raw = await storage.readToString(LINKS_KEY);
    const parsed = JSON.parse(raw);
    expect(parsed["/path/json"]).toEqual({
      repoName: "json-test",
      repoUrl: "https://json.url",
    });
  });
});
