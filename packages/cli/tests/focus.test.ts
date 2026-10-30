import { expect, test } from "bun:test";

import { intensity, lineage, reachOf } from "../lineage";

test("merge focus reaches both parents and their children without lighting unrelated deployments", () => {
  const rows = [
    { id: "first", parentId: undefined, secondParentId: undefined },
    { id: "second", parentId: undefined, secondParentId: undefined },
    { id: "merged", parentId: "first", secondParentId: "second" },
    { id: "child", parentId: "first", secondParentId: undefined },
    { id: "unrelated", parentId: undefined, secondParentId: undefined },
  ];
  const distances = lineage(rows, "merged");
  expect(distances.get("first")).toBe(1);
  expect(distances.get("second")).toBe(1);
  expect(distances.get("child")).toBe(2);
  expect(distances.has("unrelated")).toBe(false);
  expect(intensity(1, 1, reachOf(distances))).toBeGreaterThan(0);
  expect(intensity(undefined, 1, reachOf(distances))).toBe(0);
});
