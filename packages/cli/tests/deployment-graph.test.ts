import { expect, test } from "bun:test";

import { deploymentGraph } from "../lineage";

const row = (id: string, parentId?: string, secondParentId?: string) => ({
  id,
  parentId,
  secondParentId,
});

const glyph = (entry: ReturnType<typeof row>) =>
  entry.secondParentId === undefined ? "●" : "◆";

const art = (rows: readonly ReturnType<typeof row>[]) =>
  deploymentGraph(rows, glyph).map(({ cells }) =>
    cells.map((cell) => cell.char).join("")
  );

test("a merge has two visible lines even when its second parent was below it in the tree", () => {
  const rows = [row("first"), row("merged", "first", "second"), row("second")];
  expect(deploymentGraph(rows, glyph).map(({ entry }) => entry.id)).toEqual([
    "first",
    "second",
    "merged",
  ]);
  expect(art(rows)).toEqual(["●  ", "│ ●", "◆─╯"]);
});

test("overlapping merges get separate lanes and do not duplicate a deployment", () => {
  const rows = [
    row("a"),
    row("first-merge", "a", "b"),
    row("b"),
    row("second-merge", "a", "c"),
    row("c"),
  ];
  expect(deploymentGraph(rows, glyph).map(({ entry }) => entry.id)).toEqual([
    "a",
    "b",
    "first-merge",
    "c",
    "second-merge",
  ]);
  expect(art(rows)).toEqual(["●    ", "│ ●  ", "├─┴─◆", "│ ●  ", "◆─╯  "]);
});

test("an ordinary child continues its parent's lane", () => {
  expect(art([row("root"), row("child", "root")])).toEqual(["●", "●"]);
});

test("every stroke names the lineage that owns it, so the view can light one", () => {
  const merge = deploymentGraph(
    [row("first"), row("merged", "first", "second"), row("second")],
    glyph
  ).at(-1);
  expect(merge?.entry.id).toBe("merged");
  expect(merge?.cells.at(-1)?.lane).toBe("second");
  expect(merge?.cells.at(0)?.lane).toBe("merged");
});
