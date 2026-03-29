import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { readConfigFile, writeConfigFile } from "../../src/config";
import type { ProjectDetection } from "../../src/config/detect";

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devver-config-test-"));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// -- readConfigFile -----------------------------------------------------------

describe("readConfigFile", () => {
  test("returns null when no config exists", () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "devver-empty-"));
    expect(readConfigFile(emptyDir)).toBeNull();
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });

  test("reads and parses .devver.yaml", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devver-read-"));
    const config = {
      project: "my-app",
      services: {
        web: { root: ".", build: "npm run build", start: "npm start" },
      },
    };
    fs.writeFileSync(path.join(dir, ".devver.yaml"), yaml.dump(config));

    const result = readConfigFile(dir);
    expect(result).not.toBeNull();
    expect(result?.project).toBe("my-app");
    expect(result?.services.web?.build).toBe("npm run build");
    expect(result?.services.web?.start).toBe("npm start");

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// -- writeConfigFile ----------------------------------------------------------

describe("writeConfigFile", () => {
  test("writes a web service config for React detection", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devver-write-"));
    const detection: ProjectDetection = {
      results: [
        {
          detected: {
            name: "react",
            displayName: "React",
            detect: async () => true,
          },
          confidence: "high",
        },
      ],
      detectors: [],
    };

    writeConfigFile(detection, dir);

    const written = readConfigFile(dir);
    expect(written).not.toBeNull();
    expect(written?.project).toBe(path.basename(dir));
    expect(written?.services.web).toBeDefined();
    expect(written?.services.web?.build).toBe("bun run build");
    expect(written?.services.api).toBeUndefined();

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("writes an api service config for Express detection", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devver-write-api-"));
    const detection: ProjectDetection = {
      results: [
        {
          detected: {
            name: "express",
            displayName: "Express",
            detect: async () => true,
          },
          confidence: "high",
        },
      ],
      detectors: [],
    };

    writeConfigFile(detection, dir);

    const written = readConfigFile(dir);
    expect(written?.services.api).toBeDefined();
    expect(written?.services.web).toBeUndefined();

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("includes mongodb database when mongoose detected", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devver-write-mongo-"));
    const detection: ProjectDetection = {
      results: [
        {
          detected: {
            name: "express",
            displayName: "Express",
            detect: async () => true,
          },
          confidence: "high",
        },
        {
          detected: {
            name: "mongoose",
            displayName: "Mongoose",
            detect: async () => true,
          },
          confidence: "high",
        },
      ],
      detectors: [],
    };

    writeConfigFile(detection, dir);

    const written = readConfigFile(dir);
    expect(written?.databases).toBeDefined();
    expect(
      (written?.databases as Record<string, Record<string, string>>)?.mongodb
        ?.type
    ).toBe("mongodb");
    // api + mongo => depends
    expect(written?.services.api?.depends).toContain("mongodb");

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("roundtrip: write then read yields valid YAML", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devver-roundtrip-"));
    const detection: ProjectDetection = {
      results: [],
      detectors: [],
    };

    writeConfigFile(detection, dir);

    // Verify the file is valid YAML
    const raw = fs.readFileSync(path.join(dir, ".devver.yaml"), "utf-8");
    const parsed = yaml.load(raw) as Record<string, unknown>;
    expect(parsed.project).toBe(path.basename(dir));
    expect(parsed.services).toBeDefined();

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
