import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  detectProject,
  suggestedLocalConfig,
  writeConfigFile,
} from "../../../cli/config";
import { specificationOf } from "../deployment/specification";
import { decodeDevverContent, processRecipeFrom } from "./config";

const respondedRecipe = (root: string) => {
  const content = readFileSync(join(root, ".devver.yaml"), "utf-8");
  return processRecipeFrom(decodeDevverContent(content).process);
};

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
    expect(respondedRecipe(root)).toEqual({ run: "npm run dev" });
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
    expect(respondedRecipe(root)).toEqual(recipe);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing committed configuration resolves as the default static kind", () => {
  expect(specificationOf(null)).toEqual({ kind: "static" });
});

test("a committed static section pins its served directory", () => {
  expect(specificationOf("static:\n  directory: public\n")).toEqual({
    kind: "static",
    directory: "public",
  });
});

test("a committed process configuration resolves to the process kind", () => {
  expect(specificationOf("process:\n  run: npm run dev\n")).toEqual({
    kind: "process",
    run: "npm run dev",
  });
});

test("ambiguous committed configurations fail closed", () => {
  const rejected = specificationOf(
    "static:\n  directory: .\nprocess:\n  run: npm run dev\n"
  );
  expect(rejected instanceof Error && rejected.stage === "config").toBe(true);
  const customCommand = specificationOf("process:\n  run: echo hi; rm -rf /\n");
  expect(
    customCommand instanceof Error && customCommand.stage === "config"
  ).toBe(true);
});
