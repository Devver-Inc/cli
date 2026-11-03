import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const extensions = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];
const ignored = new Set(["node_modules", "dist", ".git"]);

function sourceFiles(root: string, directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return ignored.has(entry.name) ? [] : sourceFiles(root, path);
    }
    return entry.isFile() && extensions.includes(extname(path))
      ? [relative(root, path).replaceAll("\\", "/")]
      : [];
  });
}

function targetFile(
  root: string,
  source: string,
  specifier: string
): string | undefined {
  if (!specifier.startsWith(".")) {
    return undefined;
  }
  const path = resolve(root, source, "..", specifier);
  const base = /\.[cm]?jsx?$/u.test(path)
    ? path.replace(/\.[cm]?jsx?$/u, "")
    : path;
  for (const candidate of [
    path,
    ...extensions.map((extension) => `${base}${extension}`),
    ...extensions.map((extension) => join(path, `index${extension}`)),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return relative(root, candidate).replaceAll("\\", "/");
    }
  }
  return undefined;
}

function packageName(file: string): string | undefined {
  const [directory, name] = file.split("/");
  return directory === "packages" ? name : undefined;
}

function layerViolation(file: string, target: string): string | undefined {
  if (
    file.startsWith("packages/cli/src/core/") &&
    target.startsWith("packages/cli/src/") &&
    !target.startsWith("packages/cli/src/core/")
  ) {
    return `${file} imports outside core: ${target}`;
  }
  if (
    file.startsWith("packages/cli/src/infra/") &&
    (target.startsWith("packages/cli/src/cli/") ||
      target.startsWith("packages/cli/src/tui/"))
  ) {
    return `${file} imports CLI presentation: ${target}`;
  }
  if (
    file.startsWith("packages/cli/src/tui/") &&
    target.startsWith("packages/cli/src/cli/")
  ) {
    return `${file} imports CLI commands: ${target}`;
  }
  return undefined;
}

export function checkBoundaries(root: string): string[] {
  const packages = sourceFiles(root, join(root, "packages"));
  if (packages.length === 0) {
    return ["No package source files were scanned"];
  }
  const files = [
    ...packages,
    ...sourceFiles(root, join(root, "tests")),
    ...sourceFiles(root, join(root, "scripts")),
  ];
  const graph = new Map<string, string[]>();
  const errors: string[] = [];
  for (const file of files) {
    const extension = extname(file);
    const loader = extension === ".tsx" || extension === ".jsx" ? "tsx" : "ts";
    const transpiler = new Bun.Transpiler({ loader });
    const source = readFileSync(join(root, file), "utf-8").replace(
      /^#![^\n]*\n/u,
      ""
    );
    let imports;
    try {
      imports = transpiler.scanImports(source);
    } catch {
      errors.push(`Cannot scan ${file}`);
      continue;
    }
    const dependencies = imports
      .map(({ path }) => targetFile(root, file, path))
      .filter((target): target is string => target !== undefined);
    graph.set(file, dependencies);
    for (const target of dependencies) {
      const violation = layerViolation(file, target);
      if (violation !== undefined) {
        errors.push(violation);
      }
      const from = packageName(file);
      const to = packageName(target);
      if (to === undefined) {
        continue;
      }
      const inside = target.split("/").length > 3;
      const ownTests = file.startsWith(`packages/${to}/tests/`);
      const fixture = target.startsWith(`packages/${to}/tests/`);
      if (fixture && !ownTests) {
        errors.push(`${file} imports test fixture ${target}`);
      } else if (inside && (from !== to || (ownTests && !fixture))) {
        errors.push(`${file} imports private module ${target}`);
      }
    }
  }
  const visited = new Set<string>();
  const active = new Set<string>();
  function visit(file: string, path: string[]): void {
    if (active.has(file)) {
      errors.push(
        `Import cycle: ${path.slice(path.indexOf(file)).join(" -> ")}`
      );
      return;
    }
    if (visited.has(file)) {
      return;
    }
    active.add(file);
    for (const dependency of graph.get(file) ?? []) {
      if (graph.has(dependency)) {
        visit(dependency, [...path, dependency]);
      }
    }
    active.delete(file);
    visited.add(file);
  }
  for (const file of graph.keys()) {
    visit(file, [file]);
  }
  return errors;
}

if (import.meta.main) {
  const errors = checkBoundaries(process.cwd());
  for (const error of errors) {
    console.error(error);
  }
  if (errors.length > 0) {
    process.exitCode = 1;
  } else {
    console.log("Package seams and import cycles checked");
  }
}
