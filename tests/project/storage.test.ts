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
 * Integration tests for project ID persistence.
 *
 * Same approach as the repository tests: spin up a real FileStorage
 * backed by a temp dir and mirror the logic from
 * src/util/project/storage.ts.
 */

let tmpDir: string;
let storage: FileStorage;

const PROJECT_KEY = "project/current";

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devver-project-test-"));
  storage = new FileStorage(new LocalStorageAdapter(tmpDir));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Mirrors src/util/project/storage.ts
async function getCurrentProjectId(): Promise<string | null> {
  try {
    const exists = await storage.fileExists(PROJECT_KEY);
    if (!exists) {
      return null;
    }
    return await storage.readToString(PROJECT_KEY);
  } catch {
    return null;
  }
}

async function setCurrentProjectId(projectId: string): Promise<void> {
  await storage.write(PROJECT_KEY, projectId);
}

async function clearCurrentProject(): Promise<void> {
  try {
    await storage.deleteFile(PROJECT_KEY);
  } catch {
    // Ignore
  }
}

// -- Tests --------------------------------------------------------------------

describe("project ID persistence", () => {
  beforeEach(async () => {
    try {
      await storage.deleteFile(PROJECT_KEY);
    } catch {
      // Ignore
    }
  });

  test("returns null when no project is set", async () => {
    expect(await getCurrentProjectId()).toBeNull();
  });

  test("set and get roundtrip", async () => {
    await setCurrentProjectId("proj-abc-123");
    expect(await getCurrentProjectId()).toBe("proj-abc-123");
  });

  test("overwriting project ID replaces the old one", async () => {
    await setCurrentProjectId("old-id");
    await setCurrentProjectId("new-id");
    expect(await getCurrentProjectId()).toBe("new-id");
  });

  test("clearCurrentProject removes the stored ID", async () => {
    await setCurrentProjectId("to-clear");
    await clearCurrentProject();
    expect(await getCurrentProjectId()).toBeNull();
  });

  test("clearing when nothing is set does not throw", async () => {
    // Should be a no-op
    await clearCurrentProject();
    expect(await getCurrentProjectId()).toBeNull();
  });
});
