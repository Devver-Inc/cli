import { expect, test } from "bun:test";

import { mergeDecision } from "./merge-rules";

const ready = {
  repositoryId: "a".repeat(64),
  commit: "1".repeat(40),
  status: "ready",
};

const source = (overrides: Partial<typeof ready> = {}) => ({
  ...ready,
  ...overrides,
});

test("two ready deployments of one repository on different revisions admit a merge", () => {
  expect(
    mergeDecision(
      { id: "first", source: source() },
      { id: "second", source: source({ commit: "2".repeat(40) }) }
    )
  ).toEqual({
    admitted: true,
    repositoryId: ready.repositoryId,
    firstCommit: "1".repeat(40),
    secondCommit: "2".repeat(40),
  });
});

test.each([
  [
    { id: "same", source: source() },
    { id: "same", source: source() },
    "Choose two different deployments to merge",
  ],
  [
    { id: "first", source: undefined },
    { id: "second", source: source() },
    "A source deployment was not found",
  ],
  [
    { id: "first", source: source() },
    {
      id: "second",
      source: source({ repositoryId: "b".repeat(64), commit: "2".repeat(40) }),
    },
    "Both deployments must belong to the same repository",
  ],
  [
    { id: "first", source: source({ status: "degraded" }) },
    { id: "second", source: source({ commit: "2".repeat(40) }) },
    "Both source deployments must be ready",
  ],
  [
    { id: "first", source: source() },
    { id: "second", source: source() },
    "Both deployments already have the same revision",
  ],
])("rejects a merge with %p and %p", (first, second, message) => {
  expect(mergeDecision(first, second)).toEqual({ admitted: false, message });
});
