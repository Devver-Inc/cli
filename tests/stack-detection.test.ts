import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readConfigFile, writeConfigFile } from "../packages/cli/src/config";
import { detectProject } from "../packages/cli/src/config/detect";

const roots: string[] = [];
const fixture = (
  dependencies?: Record<string, string>,
  scripts?: Record<string, string>
) => {
  const root = mkdtempSync(join(tmpdir(), "devver-stack-"));
  roots.push(root);
  if (dependencies !== undefined) {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ dependencies, scripts })
    );
  }
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([
  [{ next: "1", react: "1", vite: "1" }, "meta", "next", ["next"]],
  [{ "@sveltejs/kit": "1", vite: "1" }, "meta", "sveltekit", ["@sveltejs/kit"]],
  [
    { "@tanstack/react-start": "1", vite: "1" },
    "meta",
    "tanstack-start",
    ["@tanstack/react-start"],
  ],
  [{ astro: "1" }, "meta", "astro", ["astro"]],
  [{ nuxt: "1" }, "meta", "nuxt", ["nuxt"]],
  [{ vite: "1", react: "1" }, "vite", "vite", ["vite"]],
  [{ hono: "1" }, "backend", "hono", ["hono"]],
  [{ "@nestjs/core": "1" }, "backend", "nestjs", ["@nestjs/core"]],
  [{ "@adonisjs/core": "1" }, "backend", "adonis", ["@adonisjs/core"]],
  [{ express: "1" }, "backend", "express", ["express"]],
] as const)(
  "classifies %p as %s %s",
  async (dependencies, category, framework, evidence) => {
    const detection = await detectProject(fixture(dependencies));
    expect(detection.projects[0]?.stack).toEqual({
      category,
      framework,
      evidence,
    });
  }
);

test("a directory without a package or index is unknown", async () => {
  const detection = await detectProject(fixture());
  expect(detection.projects[0]?.stack).toEqual({
    category: "unknown",
    framework: null,
    evidence: [],
  });
});

test("a malformed package does not turn an index into a static project", async () => {
  const root = fixture();
  writeFileSync(join(root, "package.json"), "not json");
  writeFileSync(join(root, "index.html"), "<html></html>");
  const detection = await detectProject(root);
  expect(detection.projects[0]?.stack).toEqual({
    category: "unknown",
    framework: null,
    evidence: [],
  });
  expect(() => {
    writeConfigFile(detection, root);
  }).toThrow("Cannot generate a deployable config");
});

test.each([
  [{ name: "brochure", version: "1.0.0" }],
  [{ dependencies: { lodash: "1" } }],
])(
  "index.html with benign package data %p creates a static config",
  async (pkg) => {
    const root = fixture();
    writeFileSync(join(root, "package.json"), JSON.stringify(pkg));
    writeFileSync(join(root, "index.html"), "<html></html>");
    const detection = await detectProject(root);
    expect(detection.projects[0]?.stack).toEqual({
      category: "static",
      framework: "html",
      evidence: ["index.html"],
    });
    writeConfigFile(detection, root);
    expect(readConfigFile(root)).toEqual({ static: { directory: "." } });
  }
);

test("index.html with an unknown build output cannot create a guessed static config", async () => {
  const root = fixture({ lodash: "1" }, { build: "custom-build" });
  writeFileSync(join(root, "index.html"), "<html></html>");
  const detection = await detectProject(root);
  expect(detection.projects[0]?.stack).toEqual({
    category: "unknown",
    framework: null,
    evidence: [],
  });
  expect(() => {
    writeConfigFile(detection, root);
  }).toThrow("Cannot generate a deployable config");
  expect(readConfigFile(root)).toBeNull();
});

test("bare index.html creates a static config", async () => {
  const root = fixture();
  writeFileSync(join(root, "index.html"), "<html></html>");
  const detection = await detectProject(root);
  expect(detection.projects[0]?.stack).toEqual({
    category: "static",
    framework: "html",
    evidence: ["index.html"],
  });
  writeConfigFile(detection, root);
  expect(readConfigFile(root)).toEqual({ static: { directory: "." } });
});

test("ambiguous frameworks cannot create a guessed config", async () => {
  const root = fixture(
    { next: "1", express: "1" },
    { build: "next build", start: "next start" }
  );
  const detection = await detectProject(root);
  expect(detection.projects[0]?.stack).toEqual({
    category: "unknown",
    framework: null,
    evidence: ["next", "express"],
  });
  expect(() => {
    writeConfigFile(detection, root);
  }).toThrow("Cannot generate a deployable config");
  expect(readConfigFile(root)).toBeNull();
});

test("unknown framework with scripts cannot create a guessed config", async () => {
  const root = fixture({ react: "1" }, { build: "build", start: "start" });
  const detection = await detectProject(root);
  expect(detection.projects[0]?.stack).toEqual({
    category: "unknown",
    framework: null,
    evidence: [],
  });
  expect(() => {
    writeConfigFile(detection, root);
  }).toThrow("Cannot generate a deployable config");
});

test("Vite is identified but does not acquire an invented start command", async () => {
  const root = fixture(
    { vite: "1" },
    { build: "vite build", start: "vite preview" }
  );
  writeFileSync(join(root, "index.html"), "<html></html>");
  const detection = await detectProject(root);
  expect(detection.projects[0]?.stack).toEqual({
    category: "vite",
    framework: "vite",
    evidence: ["vite"],
  });
  expect(() => {
    writeConfigFile(detection, root);
  }).toThrow("Cannot generate a deployable config");
});

test("known framework without required scripts cannot create a guessed config", async () => {
  const root = fixture({ next: "1" }, { build: "next build" });
  writeFileSync(join(root, "index.html"), "<html></html>");
  const detection = await detectProject(root);
  expect(detection.projects[0]?.stack).toEqual({
    category: "meta",
    framework: "next",
    evidence: ["next"],
  });
  expect(() => {
    writeConfigFile(detection, root);
  }).toThrow("Cannot generate a deployable config");
});

test("existing config remains unchanged even when detection changes", async () => {
  const root = fixture(
    { next: "1" },
    { build: "next build", start: "next start" }
  );
  const current = "static:\n  directory: public\n";
  writeFileSync(join(root, ".devver.yaml"), current);
  writeConfigFile(await detectProject(root), root);
  expect(readFileSync(join(root, ".devver.yaml"), "utf-8")).toBe(current);
});

test("invalid existing config is not replaced", async () => {
  const root = fixture(
    { next: "1" },
    { build: "next build", start: "next start" }
  );
  writeFileSync(join(root, ".devver.yaml"), "not: valid config\n");
  expect(() => {
    writeConfigFile(
      {
        projects: [
          {
            root: ".",
            stack: { category: "meta", framework: "next", evidence: ["next"] },
          },
        ],
        results: [],
        detectors: [],
      },
      root
    );
  }).toThrow("Invalid devver config");
  expect(readFileSync(join(root, ".devver.yaml"), "utf-8")).toBe(
    "not: valid config\n"
  );
});

const addPackage = (
  root: string,
  directory: string,
  dependencies: Record<string, string>
) => {
  const location = join(root, directory);
  mkdirSync(location, { recursive: true });
  writeFileSync(
    join(location, "package.json"),
    JSON.stringify({ dependencies })
  );
};

test("root and nested package have independent stacks and deterministic paths", async () => {
  const root = fixture({ express: "1" });
  addPackage(root, "apps/web", { next: "1", vite: "1" });
  const detection = await detectProject(root);
  expect(detection.projects).toEqual([
    {
      root: ".",
      stack: {
        category: "backend",
        framework: "express",
        evidence: ["express"],
      },
    },
    {
      root: "apps/web",
      stack: { category: "meta", framework: "next", evidence: ["next"] },
    },
  ]);
  expect(() => {
    writeConfigFile(detection, root);
  }).toThrow("workspace with nested projects");
  expect(readConfigFile(root)).toBeNull();
});

test("unknown workspace root does not mask two child projects", async () => {
  const root = fixture({ lodash: "1" });
  addPackage(root, "apps/zeta", { vite: "1" });
  addPackage(root, "apps/alpha", { astro: "1", vite: "1" });
  const detection = await detectProject(root);
  expect(
    detection.projects.map(({ root: projectRoot, stack }) => [
      projectRoot,
      stack.category,
      stack.framework,
    ])
  ).toEqual([
    [".", "unknown", null],
    ["apps/alpha", "meta", "astro"],
    ["apps/zeta", "vite", "vite"],
  ]);
  expect(() => {
    writeConfigFile(detection, root);
  }).toThrow("workspace with nested projects");
  expect(readConfigFile(root)).toBeNull();
});

test("a single recognized nested project is reported but not given guessed commands", async () => {
  const root = fixture();
  addPackage(root, "apps/web", { next: "1" });
  const detection = await detectProject(root);
  expect(detection.projects[1]).toEqual({
    root: "apps/web",
    stack: { category: "meta", framework: "next", evidence: ["next"] },
  });
  expect(() => {
    writeConfigFile(detection, root);
  }).toThrow("workspace with nested projects");
});

test("ignored build and node_modules trees and symlink directories are not traversed", async () => {
  const root = fixture({ express: "1" });
  addPackage(root, "node_modules/library", { next: "1" });
  addPackage(root, "build/output", { vite: "1" });
  const outside = fixture({ astro: "1" });
  symlinkSync(outside, join(root, "linked"), "dir");
  const detection = await detectProject(root);
  expect(detection.projects).toEqual([
    {
      root: ".",
      stack: {
        category: "backend",
        framework: "express",
        evidence: ["express"],
      },
    },
  ]);
});

test("recognized backend with scripts cannot generate unreviewed commands", async () => {
  const root = fixture(
    { express: "1", mongoose: "1" },
    { build: "tsc", start: "node dist/index.js" }
  );
  const detection = await detectProject(root);
  expect(() => {
    writeConfigFile(detection, root);
  }).toThrow("Only a single root static source is supported");
  expect(readConfigFile(root)).toBeNull();
});
