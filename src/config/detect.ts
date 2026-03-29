/**
 * Framework / database detection engine.
 *
 * Uses a simple plugin model: detectors register themselves via
 * registerDetector() (see detectors.ts for the built-in set).
 * Each detector inspects package.json deps, file presence, or .env vars.
 * Results feed into config file generation (writeConfigFile).
 */
import fs from "node:fs";
import path from "node:path";
import { cwd } from "node:process";

export interface ProjectDetector {
  readonly name: string;
  readonly displayName: string;
  detect(ctx: DetectionContext): Promise<boolean>;
}

export interface DetectionContext {
  pkg: PackageJson | null;
  hasFile: (filename: string) => boolean;
  hasEnvVar: (pattern: RegExp) => boolean;
}

export interface PackageJson {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

export interface DetectionResult {
  detected: ProjectDetector;
  confidence: "high" | "medium" | "low";
}

export interface ProjectDetection {
  results: DetectionResult[];
  detectors: ProjectDetector[];
}

export class FileSystemContext implements DetectionContext {
  private cachedFiles: Set<string> | null = null;
  private readonly root: string;

  constructor(root: string = cwd()) {
    this.root = root;
  }

  /** Recursively walks cwd, caching results. Skips node_modules. */
  private scanFiles(): Set<string> {
    if (this.cachedFiles) {
      return this.cachedFiles;
    }

    const files = new Set<string>();
    const scanDir = (dir: string) => {
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const fullPath = path.join(dir, entry.name);
          if (entry.name === "node_modules") {
            continue;
          }
          if (entry.isDirectory()) {
            scanDir(fullPath);
          } else {
            files.add(entry.name);
            files.add(fullPath);
          }
        }
      } catch {
        // ignore permission errors
      }
    };
    scanDir(this.root);
    this.cachedFiles = files;
    return files;
  }

  get pkg(): PackageJson | null {
    const pkgPath = path.join(this.root, "package.json");
    if (!fs.existsSync(pkgPath)) {
      return null;
    }
    try {
      return JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    } catch {
      return null;
    }
  }

  hasFile(filename: string): boolean {
    return (
      this.scanFiles().has(filename) ||
      this.scanFiles().has(path.join(this.root, filename))
    );
  }

  hasEnvVar(pattern: RegExp): boolean {
    const envPath = path.join(this.root, ".env");
    const envLocalPath = path.join(this.root, ".env.local");

    for (const p of [envPath, envLocalPath]) {
      if (!fs.existsSync(p)) {
        continue;
      }
      const content = fs.readFileSync(p, "utf-8");
      if (pattern.test(content)) {
        return true;
      }
    }
    return false;
  }
}

export const detectors: ProjectDetector[] = [];

export function registerDetector(detector: ProjectDetector): void {
  detectors.push(detector);
}

export async function detectProject(root?: string): Promise<ProjectDetection> {
  const ctx = new FileSystemContext(root);
  const results: DetectionResult[] = [];

  for (const detector of detectors) {
    const detected = await detector.detect(ctx);
    if (detected) {
      results.push({
        detected: detector,
        confidence: "high",
      });
    }
  }

  return { results, detectors };
}

export function createDependencyDetector(
  name: string,
  displayName: string,
  deps: string[]
): ProjectDetector {
  return {
    name,
    displayName,
    detect(ctx) {
      if (!ctx.pkg) {
        return Promise.resolve(false);
      }
      const allDeps = {
        ...ctx.pkg.dependencies,
        ...ctx.pkg.devDependencies,
      };
      return Promise.resolve(deps.some((dep) => allDeps?.[dep]));
    },
  };
}

export function createFileDetector(
  name: string,
  displayName: string,
  files: string[]
): ProjectDetector {
  return {
    name,
    displayName,
    detect(ctx) {
      return Promise.resolve(files.some((file) => ctx.hasFile(file)));
    },
  };
}

export function createEnvDetector(
  name: string,
  displayName: string,
  patterns: RegExp[]
): ProjectDetector {
  return {
    name,
    displayName,
    detect(ctx) {
      return Promise.resolve(
        patterns.some((pattern) => ctx.hasEnvVar(pattern))
      );
    },
  };
}
