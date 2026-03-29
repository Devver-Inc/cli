import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createDependencyDetector,
  createEnvDetector,
  createFileDetector,
  type DetectionContext,
  FileSystemContext,
  type PackageJson,
} from "../../src/config/detect";

// -- helpers ------------------------------------------------------------------

/** Minimal in-memory DetectionContext for unit-testing detector factories. */
function mockContext(overrides: {
  pkg?: PackageJson | null;
  files?: string[];
  envVars?: string;
}): DetectionContext {
  const files = new Set(overrides.files ?? []);
  return {
    pkg: overrides.pkg ?? null,
    hasFile: (f: string) => files.has(f),
    hasEnvVar: (pattern: RegExp) =>
      overrides.envVars ? pattern.test(overrides.envVars) : false,
  };
}

// -- createDependencyDetector -------------------------------------------------

describe("createDependencyDetector", () => {
  const detector = createDependencyDetector("react", "React", [
    "react",
    "react-dom",
  ]);

  test("detects when dependency is in dependencies", async () => {
    const ctx = mockContext({
      pkg: { dependencies: { react: "^18.0.0" } },
    });
    expect(await detector.detect(ctx)).toBe(true);
  });

  test("detects when dependency is in devDependencies", async () => {
    const ctx = mockContext({
      pkg: { devDependencies: { "react-dom": "^18.0.0" } },
    });
    expect(await detector.detect(ctx)).toBe(true);
  });

  test("returns false when no matching dependency", async () => {
    const ctx = mockContext({
      pkg: { dependencies: { express: "^4.0.0" } },
    });
    expect(await detector.detect(ctx)).toBe(false);
  });

  test("returns false when no package.json", async () => {
    const ctx = mockContext({ pkg: null });
    expect(await detector.detect(ctx)).toBe(false);
  });
});

// -- createFileDetector -------------------------------------------------------

describe("createFileDetector", () => {
  const detector = createFileDetector("prisma", "Prisma", [
    "prisma/schema.prisma",
  ]);

  test("detects when file exists", async () => {
    const ctx = mockContext({ files: ["prisma/schema.prisma"] });
    expect(await detector.detect(ctx)).toBe(true);
  });

  test("returns false when file is absent", async () => {
    const ctx = mockContext({ files: ["package.json"] });
    expect(await detector.detect(ctx)).toBe(false);
  });
});

// -- createEnvDetector --------------------------------------------------------

const MONGODB_URI_RE = /MONGODB_URI/i;
const MONGO_URL_RE = /MONGO_URL/i;
const REDIS_URL_RE = /REDIS_URL/i;

describe("createEnvDetector", () => {
  const detector = createEnvDetector("mongodb-env", "MongoDB (env)", [
    MONGODB_URI_RE,
    MONGO_URL_RE,
  ]);

  test("detects matching env var", async () => {
    const ctx = mockContext({ envVars: "MONGODB_URI=mongodb://localhost" });
    expect(await detector.detect(ctx)).toBe(true);
  });

  test("returns false when env has no match", async () => {
    const ctx = mockContext({ envVars: "DATABASE_URL=postgres://localhost" });
    expect(await detector.detect(ctx)).toBe(false);
  });

  test("returns false when no env content", async () => {
    const ctx = mockContext({});
    expect(await detector.detect(ctx)).toBe(false);
  });
});

// -- FileSystemContext (integration with real temp dir) ------------------------

describe("FileSystemContext", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devver-test-"));

    // Create a package.json
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({
        name: "test-project",
        dependencies: { next: "^14.0.0" },
      })
    );

    // Create a nested file
    fs.mkdirSync(path.join(tmpDir, "prisma"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "prisma", "schema.prisma"), "");

    // Create a .env file
    fs.writeFileSync(path.join(tmpDir, ".env"), "MONGO_URL=mongodb://db\n");
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("reads package.json", () => {
    const ctx = new FileSystemContext(tmpDir);
    expect(ctx.pkg).not.toBeNull();
    expect(ctx.pkg?.name).toBe("test-project");
    expect(ctx.pkg?.dependencies?.next).toBe("^14.0.0");
  });

  test("pkg returns null when no package.json", () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "devver-empty-"));
    const ctx = new FileSystemContext(emptyDir);
    expect(ctx.pkg).toBeNull();
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });

  test("hasFile finds nested files by basename", () => {
    const ctx = new FileSystemContext(tmpDir);
    expect(ctx.hasFile("schema.prisma")).toBe(true);
  });

  test("hasFile finds nested files by relative path", () => {
    const ctx = new FileSystemContext(tmpDir);
    // FileSystemContext stores full path: <root>/prisma/schema.prisma
    expect(ctx.hasFile(path.join(tmpDir, "prisma", "schema.prisma"))).toBe(
      true
    );
  });

  test("hasFile returns false for missing files", () => {
    const ctx = new FileSystemContext(tmpDir);
    expect(ctx.hasFile("nonexistent.txt")).toBe(false);
  });

  test("hasEnvVar matches patterns in .env", () => {
    const ctx = new FileSystemContext(tmpDir);
    expect(ctx.hasEnvVar(MONGO_URL_RE)).toBe(true);
  });

  test("hasEnvVar returns false for unmatched patterns", () => {
    const ctx = new FileSystemContext(tmpDir);
    expect(ctx.hasEnvVar(REDIS_URL_RE)).toBe(false);
  });
});
