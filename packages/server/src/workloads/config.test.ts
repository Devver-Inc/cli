import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  detectProject,
  suggestedLocalConfig,
  writeConfigFile,
} from "../../../cli/config";
import { readProcessRecipe } from "./config";

test("the server accepts a process recipe written by CLI init", async () => {
  const root = mkdtempSync(join(tmpdir(), "devver-recipe-contract-"));
  try {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        dependencies: { "@sveltejs/kit": "1", vite: "1" },
        scripts: { dev: "vite dev" },
      })
    );
    writeFileSync(join(root, "package-lock.json"), "{}");
    writeConfigFile(suggestedLocalConfig(await detectProject(root)), root);
    expect(await readProcessRecipe(root)).toEqual({ run: "npm run dev" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the server accepts reviewed install, build and port overrides", async () => {
  const root = mkdtempSync(join(tmpdir(), "devver-recipe-contract-"));
  try {
    const recipe = {
      install: "npm ci",
      build: "npm run build",
      run: `npm run dev \${PORT}`,
    };
    writeConfigFile({ process: recipe }, root);
    expect(await readProcessRecipe(root)).toEqual(recipe);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
