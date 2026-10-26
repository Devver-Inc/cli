import { expect, test } from "bun:test";

import { deploymentGraph } from "../src/tui/deployment-graph";

const row = (id: string, parentId?: string, secondParentId?: string) => ({
  id,
  parentId,
  secondParentId,
});

test("a merge has two visible lines even when its second parent was below it in the tree", () => {
  const graph = deploymentGraph([
    row("first"),
    row("merged", "first", "second"),
    row("second"),
  ]);
  expect(graph.map(({ entry }) => entry.id)).toEqual([
    "first",
    "second",
    "merged",
  ]);
  expect(graph.map(({ connector }) => connector)).toEqual([
    "●    ",
    "│ ●  ",
    "└─●  ",
  ]);
});

test("overlapping merges get separate lanes and do not duplicate a deployment", () => {
  const graph = deploymentGraph([
    row("a"),
    row("first-merge", "a", "b"),
    row("b"),
    row("second-merge", "a", "c"),
    row("c"),
  ]);
  expect(graph.map(({ entry }) => entry.id)).toEqual([
    "a",
    "b",
    "first-merge",
    "c",
    "second-merge",
  ]);
  expect(graph[0]?.connector).toContain("●   ●");
  expect(graph[2]?.connector).toContain("└─● │");
  expect(graph[4]?.connector).toContain("    └─●");
});

test("an absent parent never gets a fabricated line", () => {
  const graph = deploymentGraph([row("merged", "missing", "also-missing")]);
  expect(graph).toEqual([
    { entry: row("merged", "missing", "also-missing"), connector: "" },
  ]);
});
