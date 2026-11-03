import fs from "node:fs";
import path from "node:path";
import { cwd } from "node:process";

import { Schema } from "effect";

import { stackRules } from "./stacks/rules";
import { isStaticProject } from "./stacks/static";

const PackageJsonSchema = Schema.Struct({
  name: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
  packageManager: Schema.optional(Schema.String),
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  devDependencies: Schema.optional(
    Schema.Record(Schema.String, Schema.Unknown)
  ),
  scripts: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

export type PackageJson = typeof PackageJsonSchema.Type;

const decodePackageJson = Schema.decodeUnknownResult(PackageJsonSchema);

export type PrimaryStack =
  | { category: "static"; framework: "html"; evidence: readonly string[] }
  | {
      category: "vite" | "meta" | "backend";
      framework: string;
      evidence: readonly string[];
    }
  | { category: "unknown"; framework: null; evidence: readonly string[] };

export type PackageManager = "bun" | "npm" | "pnpm" | "yarn";

export interface ProjectProfile {
  readonly root: string;
  readonly stack: PrimaryStack;
  readonly packageManager?: PackageManager;
  readonly scripts?: Readonly<Record<string, string>>;
}

export interface ProjectDetection {
  projects: readonly ProjectProfile[];
}

function primaryStack(ctx: FileSystemContext): PrimaryStack {
  const { pkg } = ctx;
  const dependencies = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const matches = stackRules.flatMap((candidate) => {
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
    isStaticProject(ctx.hasFile("index.html"), pkg, ctx.hasFile("package.json"))
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

class FileSystemContext {
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
}

const packageManagers: readonly PackageManager[] = [
  "pnpm",
  "yarn",
  "bun",
  "npm",
];

function isPackageManager(value: string): value is PackageManager {
  return packageManagers.some((candidate) => candidate === value);
}

function packageManager(
  context: FileSystemContext
): PackageManager | undefined {
  const declared = context.pkg?.packageManager?.split("@")[0];
  const locks = packageManagers.filter((manager) =>
    ({
      pnpm: ["pnpm-lock.yaml"],
      yarn: ["yarn.lock"],
      bun: ["bun.lock", "bun.lockb"],
      npm: ["package-lock.json"],
    })[manager].some((file) => context.hasFile(file))
  );
  if (
    locks.length > 1 ||
    (declared !== undefined && !isPackageManager(declared))
  ) {
    return undefined;
  }
  if (declared !== undefined && locks.length > 0 && locks[0] !== declared) {
    return undefined;
  }
  return declared ?? locks[0];
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
  const projects: ProjectProfile[] = [];

  function visit(directory: string, relative: string): void {
    const context = new FileSystemContext(directory);
    if (relative === "." || context.hasFile("package.json")) {
      const manager = packageManager(context);
      const scripts = context.pkg?.scripts;
      const stack = primaryStack(context);
      if (manager === undefined) {
        if (scripts === undefined) {
          projects.push({ root: relative, stack });
        } else {
          projects.push({ root: relative, stack, scripts });
        }
      } else if (scripts === undefined) {
        projects.push({ root: relative, stack, packageManager: manager });
      } else {
        projects.push({
          root: relative,
          stack,
          packageManager: manager,
          scripts,
        });
      }
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

  return { projects };
}
