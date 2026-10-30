import { describe, expect, test } from "bun:test";

import { visibleDeployments } from "../packages/cli/src/tui/deployments";

const deployments = [
  {
    deploymentId: "first",
    repositoryId: "checkout-a",
    status: "ready",
    stage: null,
    url: "http://localhost:1234",
  },
  {
    deploymentId: "second",
    repositoryId: "checkout-b",
    status: "failed",
    stage: "process",
  },
  {
    deploymentId: "legacy",
    status: "ready",
    stage: null,
  },
] as const;

describe("local TUI deployment visibility", () => {
  test("shows only the opened checkout, excluding unknown repository IDs", () => {
    expect(visibleDeployments(deployments, "checkout-a")).toEqual([
      deployments[0],
    ]);
    expect(visibleDeployments(deployments, "checkout-c")).toEqual([]);
  });

  test("shows all server deployments outside Git", () => {
    expect(visibleDeployments(deployments, undefined)).toEqual(deployments);
  });
});
