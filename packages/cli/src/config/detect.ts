import fs from "node:fs";
import path from "node:path";
import { cwd } from "node:process";

import { Schema } from "effect";

export interface ProjectDetector {
  readonly name: string;
  readonly displayName: string;
  detect: (ctx: DetectionContext) => Promise<boolean>;
}

export interface DetectionContext {
  pkg: PackageJson | null;
  hasFile: (filename: string) => boolean;
  hasEnvVar: (pattern: RegExp) => boolean;
}

const PackageJsonSchema = Schema.Struct({
  name: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  devDependencies: Schema.optional(
    Schema.Record(Schema.String, Schema.Unknown)
  ),
  scripts: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

export type PackageJson = typeof PackageJsonSchema.Type;

const decodePackageJson = Schema.decodeUnknownResult(PackageJsonSchema);

export interface DetectionResult {
  detected: ProjectDetector;
  confidence: "high" | "medium" | "low";
}

export type PrimaryStack =
  | { category: "static"; framework: "html"; evidence: readonly string[] }
  | {
      category: "vite" | "meta" | "backend";
      framework: string;
      evidence: readonly string[];
    }
  | { category: "unknown"; framework: null; evidence: readonly string[] };

export interface ProjectDetection {
  projects: readonly { root: string; stack: PrimaryStack }[];
  results: DetectionResult[];
  detectors: ProjectDetector[];
}

const frameworks = [
  { category: "meta", name: "next", deps: ["next"] },
  {
    category: "meta",
    name: "tanstack-start",
    deps: ["@tanstack/react-start", "@tanstack/start"],
  },
  { category: "meta", name: "astro", deps: ["astro"] },
  { category: "meta", name: "nuxt", deps: ["nuxt"] },
  { category: "meta", name: "sveltekit", deps: ["@sveltejs/kit"] },
  { category: "meta", name: "remix", deps: ["@remix-run/react"] },
  { category: "backend", name: "express", deps: ["express"] },
  { category: "backend", name: "hono", deps: ["hono"] },
  { category: "backend", name: "nestjs", deps: ["@nestjs/core"] },
  { category: "backend", name: "adonis", deps: ["@adonisjs/core"] },
  { category: "backend", name: "fastify", deps: ["fastify"] },
  { category: "vite", name: "vite", deps: ["vite"] },
] as const;

function primaryStack(ctx: DetectionContext): PrimaryStack {
  if (ctx.pkg === null) {
    return ctx.hasFile("index.html") && !ctx.hasFile("package.json")
      ? { category: "static", framework: "html", evidence: ["index.html"] }
      : { category: "unknown", framework: null, evidence: [] };
  }
  const dependencies = { ...ctx.pkg.dependencies, ...ctx.pkg.devDependencies };
  const matches = frameworks.flatMap((candidate) => {
    const evidence = candidate.deps.filter(
      (dep) => dependencies[dep] !== undefined
    );
    return evidence.length > 0 ? [{ candidate, evidence }] : [];
  });
  const primary = matches.filter(
    ({ candidate }) => candidate.category !== "vite"
  );
  const selected = primary.length > 0 ? primary : matches;
  const [match] = selected;
  if (
    match === undefined &&
    ctx.hasFile("index.html") &&
    (ctx.pkg.scripts?.build?.trim().length ?? 0) === 0
  ) {
    return { category: "static", framework: "html", evidence: ["index.html"] };
  }
  if (match === undefined || selected.length !== 1) {
    return {
      category: "unknown",
      framework: null,
      evidence: selected.flatMap(({ evidence }) => evidence),
    };
  }
  return {
    category: match.candidate.category,
    framework: match.candidate.name,
    evidence: match.evidence,
  };
}

export class FileSystemContext implements DetectionContext {
  private readonly root: string;

  constructor(root: string = cwd()) {
    this.root = root;
  }

  get pkg(): PackageJson | null {
    const pkgPath = path.join(this.root, "package.json");
    if (!this.hasFile("package.json")) {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    } catch {
      return null;
    }
    const decoded = decodePackageJson(parsed);
    return decoded._tag === "Success" ? decoded.success : null;
  }

  hasFile(filename: string): boolean {
    try {
      return !fs.lstatSync(path.join(this.root, filename)).isSymbolicLink();
    } catch {
      return false;
    }
  }

  hasEnvVar(pattern: RegExp): boolean {
    const envPath = path.join(this.root, ".env");
    const envLocalPath = path.join(this.root, ".env.local");

    for (const p of [envPath, envLocalPath]) {
      if (!this.hasFile(path.basename(p))) {
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

const ignoredDirectories = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".output",
  "coverage",
  ".turbo",
  ".devver",
]);

export async function detectProject(root?: string): Promise<ProjectDetection> {
  const checkout = path.resolve(root ?? cwd());
  const projects: { root: string; stack: PrimaryStack }[] = [];

  function visit(directory: string, relative: string): void {
    const context = new FileSystemContext(directory);
    if (relative === "." || context.hasFile("package.json")) {
      projects.push({ root: relative, stack: primaryStack(context) });
    }
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .toSorted((a, b) => a.name.localeCompare(b.name, "en"))) {
      if (!entry.isDirectory() || ignoredDirectories.has(entry.name)) {
        continue;
      }
      visit(
        path.join(directory, entry.name),
        relative === "." ? entry.name : `${relative}/${entry.name}`
      );
    }
  }
  visit(checkout, ".");

  const singleRoot = projects.length === 1 && projects[0]?.root === ".";
  const results: DetectionResult[] = [];
  if (singleRoot) {
    const ctx = new FileSystemContext(checkout);
    for (const detector of detectors) {
      if (await detector.detect(ctx)) {
        results.push({ detected: detector, confidence: "high" });
      }
    }
  }
  return {
    projects,
    results,
    detectors,
  };
}

export function createDependencyDetector(
  name: string,
  displayName: string,
  deps: string[]
): ProjectDetector {
  return {
    name,
    displayName,
    async detect(ctx) {
      if (ctx.pkg === null) {
        return false;
      }
      const allDeps = {
        ...ctx.pkg.dependencies,
        ...ctx.pkg.devDependencies,
      };
      return deps.some((dep) => allDeps[dep] !== undefined);
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
    async detect(ctx) {
      return files.some((file) => ctx.hasFile(file));
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
    async detect(ctx) {
      return patterns.some((pattern) => ctx.hasEnvVar(pattern));
    },
  };
}
